import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initEncryptionKey } from '../lib/crypto.js';
import {
  fetchModelsDev,
  filterFreeModels,
  mapToFreellmapi,
  computeRanks,
} from '../services/modelsDev.js';

const { Database } = (global as any).bun?.sqlite || require('bun:sqlite');
type DatabaseType = InstanceType<typeof Database>;

const __filename = typeof import.meta.url === 'string' ? fileURLToPath(import.meta.url) : import.meta.url;
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'data', 'freeapi.db');

let db: DatabaseType;

export function getDb(): DatabaseType {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null as any;
  }
}

export async function initDb(dbPath?: string): Promise<DatabaseType> {
  const resolvedPath = dbPath ?? DB_PATH;
  const isMemory = resolvedPath === ':memory:';

  if (!isMemory) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  db = new Database(resolvedPath);
  if (!isMemory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  createTables(db);
  initEncryptionKey(db);

  const hasModels = db.prepare('SELECT COUNT(*) as cnt FROM models').get() as { cnt: number };
  if (hasModels.cnt === 0) {
    try {
      await seedModelsFromModelsDev(db);
    } catch (err) {
      console.error('[DB] Failed to seed models from models.dev:', err);
    }
  }

  ensureUnifiedKey(db);
  ensureAdminUser(db);

  console.log(`Database initialized at ${resolvedPath}`);
  return db;
}

function createTables(db: DatabaseType) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  `);
}

async function seedModelsFromModelsDev(db: DatabaseType) {
  console.log('[DB] Fetching free models from models.dev...');
  const allModels = await fetchModelsDev();
  const freeModels = filterFreeModels(allModels);

  if (freeModels.length === 0) {
    console.warn('[DB] No free models found from models.dev');
    return;
  }

  const insert = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
      monthly_token_budget, context_window, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const insertFallback = db.prepare(
    'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)'
  );

  const mapped = freeModels.map((m) => {
    const mappedModel = mapToFreellmapi(m);
    const ranks = computeRanks(m);
    const sizeLabel = guessSizeLabel(m.name);
    return {
      ...mappedModel,
      intelligenceRank: ranks.intelligence,
      speedRank: ranks.speed,
      sizeLabel,
    };
  });

  // Sort by intelligence rank (lower = smarter) for fallback priority
  mapped.sort((a, b) => a.intelligenceRank - b.intelligenceRank);

  const insertMany = db.transaction(() => {
    for (const m of mapped) {
      insert.run(
        m.platform,
        m.modelId,
        m.displayName,
        m.intelligenceRank,
        m.speedRank,
        m.sizeLabel,
        null, // rpm_limit - unknown from models.dev
        null, // rpd_limit
        null, // tpm_limit
        null, // tpd_limit
        '',   // monthly_token_budget
        m.contextWindow
      );
    }
  });
  insertMany();

  // Seed fallback config in intelligence rank order
  const allDbModels = db
    .prepare('SELECT id FROM models ORDER BY intelligence_rank ASC')
    .all() as { id: number }[];

  const insertFallbacks = db.transaction(() => {
    for (let i = 0; i < allDbModels.length; i++) {
      insertFallback.run(allDbModels[i].id, i + 1);
    }
  });
  insertFallbacks();

  console.log(`[DB] Seeded ${mapped.length} free models from models.dev`);
}

function guessSizeLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('opus') || n.includes('o1') || n.includes('o3') || n.includes('claude-3.5') || n.includes('claude-4') || n.includes('gpt-4') || n.includes('gemini-pro') || n.includes('deepseek-v4') || n.includes('deepseek-r1')) {
    return 'Frontier';
  }
  if (n.includes('flash') || n.includes('lite') || n.includes('nano') || n.includes('mini') || n.includes('xs') || n.includes('small') || n.includes('8b') || n.includes('1.2b')) {
    return 'Small';
  }
  return 'Large';
}

function ensureAdminUser(db: DatabaseType) {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  const exists = count.cnt > 0;

  let password: string;
  if (!exists) {
    const username = 'admin';
    password = process.env.ADMIN_PASSWORD || `${crypto.randomBytes(3).toString('hex')}-${crypto.randomBytes(3).toString('hex')}`;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');

    db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)').run(username, hash, salt);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?)").run(password);

    console.log(`\n  Admin user created:`);
  } else {
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get() as { value: string } | undefined;
    if (stored?.value) {
      password = stored.value;
    } else {
      password = `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`;
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?').run(hash, salt, 'admin');
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?)").run(password);
      console.log(`\n  Admin password regenerated:`);
    }
  }

  console.log(`  Username: admin`);
  console.log(`  Password: ${password}`);
  console.log(`  (set ADMIN_PASSWORD env var on first run to use a custom password)\n`);
}

function ensureUnifiedKey(db: DatabaseType) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
  if (!existing) {
    const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
    db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(key);
    console.log(`\n  Your unified API key: ${key}\n`);
  }
}

export function getUnifiedApiKey(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string };
  return row.value;
}

export function regenerateUnifiedKey(): string {
  const db = getDb();
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(key);
  return key;
}
