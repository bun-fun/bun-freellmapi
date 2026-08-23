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
import { seedCatalogModels } from '../services/catalog-seed.js';

const { Database } = (global as any).bun?.sqlite || require('bun:sqlite');
export type DatabaseType = InstanceType<typeof Database>;

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
  ensureSchemaCompat(db);
  initEncryptionKey(db);

  const hasModels = db.prepare('SELECT COUNT(*) as cnt FROM models').get() as { cnt: number };
  if (hasModels.cnt === 0) {
    try {
      await seedModelsFromModelsDev(db);
    } catch (err) {
      console.error('[DB] Failed to seed models from models.dev:', err);
    }
  }

  // Seed catalog-managed platform models (agnes, reka, nara, bazaarlink, etc.)
  // that are not in models.dev and would normally come from catalog-sync.
  // Idempotent: only inserts rows for platforms with zero models.
  try {
    seedCatalogModels(db);
  } catch (err) {
    console.error('[DB] Failed to seed catalog models:', err);
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
      supports_vision INTEGER NOT NULL DEFAULT 0,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      key_id INTEGER,
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
      last_checked_at TEXT,
      base_url TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      requested_model TEXT,
      ttfb_ms INTEGER,
      request_type TEXT NOT NULL DEFAULT 'chat',
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
      tokens INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#6366f1',
      type TEXT NOT NULL DEFAULT 'custom',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      auto_sort TEXT,
      layout_config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(profile_id, model_db_id)
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
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS provider_quota_state (
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      quota_pool_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      limit_value INTEGER,
      remaining_value INTEGER,
      reset_at TEXT,
      reset_strategy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'probe',
      confidence REAL NOT NULL DEFAULT 0,
      notes TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, key_id, quota_pool_key, metric)
    );

    CREATE TABLE IF NOT EXISTS provider_quota_observations (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      provider_account_id TEXT,
      model_id TEXT,
      quota_pool_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      status_code INTEGER,
      limit_value INTEGER,
      remaining_value INTEGER,
      reset_at TEXT,
      retry_after_ms INTEGER,
      reset_strategy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'probe',
      confidence REAL NOT NULL DEFAULT 0,
      headers_json TEXT,
      notes TEXT,
      raw_json TEXT,
      endpoint TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS embedding_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      max_input INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS media_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      modality TEXT NOT NULL DEFAULT 'image',
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      quota_label TEXT,
      key_id INTEGER,
      meta_json TEXT,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS quirks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      quirk_type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, model_id, quirk_type)
    );

    CREATE TABLE IF NOT EXISTS quirk_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quirk_id INTEGER NOT NULL REFERENCES quirks(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_value TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_lookup ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_expires ON rate_limit_cooldowns(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_state_platform ON provider_quota_state(platform, key_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_provider_quota_state_reset_at ON provider_quota_state(reset_at);
  `);
}

function ensureSchemaCompat(db: DatabaseType) {
  // Playground conversations (upstream migration 20260820_000001; the Bun
  // baseline creates tables in-code, so mirror it here idempotently).
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      messages_json TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      system_prompt TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_playground_conversations_updated
      ON playground_conversations(updated_at_ms DESC);
  `);

  // Legacy baseline columns
  ensureCol(db, 'models', 'supports_vision', 'INTEGER NOT NULL DEFAULT 0');
  ensureCol(db, 'models', 'supports_tools', 'INTEGER NOT NULL DEFAULT 0');
  ensureCol(db, 'models', 'key_id', 'INTEGER');
  ensureCol(db, 'requests', 'key_id', 'INTEGER');
  ensureCol(db, 'requests', 'requested_model', 'TEXT');
  ensureCol(db, 'requests', 'ttfb_ms', 'INTEGER');
  ensureCol(db, 'requests', 'request_type', "TEXT NOT NULL DEFAULT 'chat'");
  ensureCol(db, 'api_keys', 'base_url', 'TEXT');
  ensureCol(db, 'provider_quota_observations', 'retry_after_ms', 'INTEGER');
  ensureCol(db, 'provider_quota_observations', 'raw_json', 'TEXT');
  ensureCol(db, 'provider_quota_observations', 'endpoint', 'TEXT');
  ensureCol(db, 'provider_quota_observations', 'created_at', "TEXT NOT NULL DEFAULT (datetime('now'))");

  // Migration: request_client_info
  ensureCol(db, 'requests', 'client_ip', 'TEXT');
  ensureCol(db, 'requests', 'client_user_agent', 'TEXT');

  // Migration: key_health_error
  ensureCol(db, 'api_keys', 'last_health_error', 'TEXT');

  // Migration: cooldown_probe_provenance
  ensureCol(db, 'rate_limit_cooldowns', 'source', "TEXT NOT NULL DEFAULT 'heuristic'");
  ensureCol(db, 'rate_limit_cooldowns', 'set_at_ms', 'INTEGER');

  // Migration: model_source_provenance
  ensureCol(db, 'models', 'source', "TEXT NOT NULL DEFAULT 'catalog'");

  // Migration: media_model_meta
  ensureCol(db, 'media_models', 'meta_json', 'TEXT');

  // Migration: media_models modality columns. The pre-merge table carried the
  // modality under `media_type` (with no priority/quota_label/key_id), which the
  // media services and catalog-sync read as `modality`. Add the missing columns
  // and backfill the old name so existing installs' media dashboard works.
  ensureMediaModelsColumns(db);
  ensureEmbeddingModelsColumns(db);

  // Migration: request_served_model
  ensureCol(db, 'requests', 'served_model', 'TEXT');

  // Migration: agent_compatibility
  ensureCol(db, 'requests', 'client_agent', 'TEXT');

  // Migration: auth-email — auth.ts expects an `email` column; the baseline
  // table uses `username` + `salt`. Rebuild users to add email and make
  // username/salt nullable so both schemas coexist. SQLite cannot DROP NOT
  // NULL via ALTER TABLE, so we park child rows, rebuild, and restore.
  ensureUsersEmailCompat(db);

  // lib/auth.ts queries sessions.token/expires_at while services/auth.ts
  // writes sessions.token_hash/expires_at_ms. ensureUsersEmailCompat below
  // normalises both column sets so neither path breaks on a fresh or legacy
  // database. Do NOT use ensureCol here — it would add stale legacy columns
  // onto a table that was just rebuilt with the new schema.

  // Create tables added by migrations BEFORE adding columns to them
  ensureMigrationTables(db);

  // Reconcile orphaned child rows that can accumulate when foreign_keys was
  // OFF at backup/restore time (e.g. a backup created while the constraint was
  // disabled, or a manual DELETE from the parent without cascade). These
  // orphans cause immediate SQLITE_CONSTRAINT_FOREIGNKEY on the first write
  // that touches the child table after PRAGMA foreign_keys = ON is enabled.
  const orphanAttempts = db.prepare(`
    DELETE FROM request_attempts
     WHERE request_id NOT IN (SELECT id FROM requests)
  `).run();
  if (orphanAttempts.changes > 0) {
    console.log(`[DB] Cleaned up ${orphanAttempts.changes} orphaned request_attempts rows`);
  }
  const orphanFallback = db.prepare(`
    DELETE FROM fallback_config
     WHERE model_db_id NOT IN (SELECT id FROM models)
  `).run();
  if (orphanFallback.changes > 0) {
    console.log(`[DB] Cleaned up ${orphanFallback.changes} orphaned fallback_config rows`);
  }

  // Migration: custom_model_endpoint_identity — endpoint_scope + UNIQUE change
  ensureCol(db, 'models', 'endpoint_scope', "TEXT NOT NULL DEFAULT ''");
  ensureCol(db, 'models', 'paid_input_per_m', 'REAL');
  ensureCol(db, 'models', 'paid_output_per_m', 'REAL');
  ensureModelsEndpointScopeUnique(db);

  // Migration: tombstone_provenance
  ensureCol(db, 'catalog_model_tombstones', 'source', "TEXT NOT NULL DEFAULT 'user'");
  ensureCol(db, 'catalog_model_tombstones', 'reason', 'TEXT');

  // Migration: attempt_error_summary
  ensureCol(db, 'request_attempts', 'error_summary', 'TEXT');
}

function ensureMigrationTables(db: DatabaseType) {
  // catalog_model_state migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_model_tombstones (
      kind TEXT NOT NULL DEFAULT 'chat',
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (kind, platform, model_id)
    );
    CREATE TABLE IF NOT EXISTS model_overrides (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_model_tombstones_platform_model
      ON catalog_model_tombstones(platform, model_id);
  `);

  // request_aggregates migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_hourly (
      hour TEXT PRIMARY KEY,
      total_requests INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_request_hourly_hour ON request_hourly(hour);
  `);

  // request_attempts migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_ordinal INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      start_offset_ms INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_request_attempts_request_id
      ON request_attempts(request_id, ordinal);
  `);
}

// SQLite cannot DROP a table-level UNIQUE constraint via ALTER TABLE.
// The endpoint_identity migration rebuilds the table to move uniqueness from
// (platform, model_id) to (platform, model_id, endpoint_scope). We do the same
// here, but only if the old constraint is still in place.
function ensureModelsEndpointScopeUnique(db: DatabaseType) {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='models'").get() as { sql: string } | undefined;
  if (!schema) return;
  // If the schema already has endpoint_scope in the UNIQUE clause, nothing to do.
  if (/endpoint_scope/i.test(schema.sql)) return;

  // Rebuild models with the new unique constraint, preserving all data.
  // Same approach as the migration: park child rows, rebuild, restore.
  const childTables = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'models'
     ORDER BY name
  `).all() as { name: string }[];
  const children = childTables.filter(t =>
    (db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as { table: string }[])
      .some(fk => fk.table === 'models'));

  const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'models'")
    .get() as { seq: number } | undefined;

  for (const child of children) {
    db.exec(`CREATE TEMP TABLE "_endpoint_identity_${child.name}" AS SELECT * FROM "${child.name}"`);
    db.exec(`DELETE FROM "${child.name}"`);
  }

  // Get all existing column names to carry over
  const cols = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  const colNames = cols.map(c => c.name).join(', ');

  db.exec(`
    CREATE TABLE models_endpoint_identity (
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
      supports_vision INTEGER NOT NULL DEFAULT 0,
      key_id INTEGER,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      paid_input_per_m REAL,
      paid_output_per_m REAL,
      source TEXT NOT NULL DEFAULT 'catalog',
      endpoint_scope TEXT NOT NULL DEFAULT '',
      UNIQUE(platform, model_id, endpoint_scope)
    );
    INSERT INTO models_endpoint_identity (${colNames})
      SELECT ${colNames} FROM models;
    DROP TABLE models;
    ALTER TABLE models_endpoint_identity RENAME TO models;
  `);

  if (seqRow) {
    const restored = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'models' AND seq < ?")
      .run(seqRow.seq, seqRow.seq);
    if (restored.changes === 0
      && !db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'models'").get()) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('models', ?)").run(seqRow.seq);
    }
  }

  for (const child of children) {
    db.exec(`INSERT INTO "${child.name}" SELECT * FROM "_endpoint_identity_${child.name}"`);
    db.exec(`DROP TABLE "_endpoint_identity_${child.name}"`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_models_endpoint_scope
      ON models(endpoint_scope) WHERE endpoint_scope <> '';
  `);
}

// Rebuild the users table to add `email` and relax `username`/`salt` to
// nullable. auth.ts only inserts (email, password_hash), so the legacy
// NOT NULL constraints on username and salt would reject new accounts on
// a database that was bootstrapped with the baseline schema. Also rebuild
// sessions to match auth.ts's expected schema (token_hash / expires_at_ms)
// when the migration's version is what's on disk.
function ensureUsersEmailCompat(db: DatabaseType) {
  const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]);
  const sessionCols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]);
  const sessionColNames = sessionCols.map(c => c.name);
  const needsUsersRebuild = !userCols.some(c => c.name === 'email');
  const hasTokenHash = sessionColNames.includes('token_hash');
  const hasLegacyToken = sessionColNames.includes('token');
  const needsSessionsRebuild = !hasTokenHash;

  // Mixed-schema recovery: a prior boot rebuilt sessions to the new schema,
  // then a later ensureCol call added stale legacy columns (token / expires_at)
  // onto it. Drain them before proceeding so the migration sees a clean state.
  if (hasTokenHash && hasLegacyToken) {
    db.exec('ALTER TABLE sessions DROP COLUMN token');
    db.exec('ALTER TABLE sessions DROP COLUMN expires_at');
    console.log('[DB] Stripped stale legacy sessions columns (token, expires_at)');
  }

  if (!needsUsersRebuild && !needsSessionsRebuild) return;

  // If a prior boot crashed mid-rebuild, a leftover `users_email_compat` table
  // from that run blocks CREATE TABLE on the next boot. Drain it so we can
  // start fresh. Same for the temp park tables below — use DROP TABLE IF
  // EXISTS to swallow leftovers from interrupted runs.
  db.exec('DROP TABLE IF EXISTS users_email_compat');
  db.exec('DROP TABLE IF EXISTS "_park_sessions"');
  db.exec('DROP TABLE IF EXISTS "_park_old_sessions"');

  // Park any existing data
  const hasSessions = sessionCols.length > 0;
  if (hasSessions) {
    db.exec('CREATE TEMP TABLE "_park_sessions" AS SELECT * FROM sessions');
  }

  if (needsUsersRebuild) {
    const existingRows = db.prepare('SELECT id, username, password_hash, salt, created_at FROM users').all() as {
      id: number; username: string; password_hash: string; salt: string; created_at: string;
    }[];
    const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'")
      .get() as { seq: number } | undefined;

    db.exec(`
      CREATE TABLE users_email_compat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        email TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        salt TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(username)
      )
    `);

    const insert = db.prepare('INSERT INTO users_email_compat (id, username, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of existingRows) {
      insert.run(row.id, row.username, row.username ? row.username.toLowerCase() : '', row.password_hash, row.salt, row.created_at);
    }

    // Drop sessions first (it references users with NO ACTION — dropping users
    // while sessions rows exist would trigger a FK constraint error). The
    // parked temp copy preserves the data so we can restore it below.
    if (hasSessions) {
      db.exec('DROP TABLE sessions');
    }
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_email_compat RENAME TO users');

    if (seqRow) {
      const restored = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'users' AND seq < ?")
        .run(seqRow.seq, seqRow.seq);
      if (restored.changes === 0
        && !db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'users'").get()) {
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('users', ?)").run(seqRow.seq);
      }
    }
  }

  if (needsSessionsRebuild) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    if (hasSessions) {
      // Check whether the parked copy has the old schema (id/token/expires_at)
      // or the new one. The old-schema park happens when the users table
      // rebuild dropped sessions above; the new-schema park happens when we
      // arrive here without having dropped sessions.
      const oldCols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]);
      if (oldCols.some(c => c.name === 'token') && !oldCols.some(c => c.name === 'token_hash')) {
        // Sessions still have the legacy shape — park, drop, recreate, migrate.
        db.exec('CREATE TEMP TABLE "_park_old_sessions" AS SELECT * FROM sessions');
        db.exec('DROP TABLE sessions');
        db.exec(`
          CREATE TABLE sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at_ms INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        // Convert: token → sha256(token), expires_at (ISO) → expires_at_ms (epoch ms)
        const parkRows = db.prepare('SELECT token, user_id, expires_at FROM "_park_old_sessions"').all() as { token: string; user_id: number; expires_at: string }[];
        const ins = db.prepare('INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at_ms, created_at) VALUES (?, ?, ?, ?)');
        for (const r of parkRows) {
          const tokenHash = crypto.createHash('sha256').update(r.token).digest('hex');
          const expiresAtMs = new Date(r.expires_at).getTime();
          ins.run(tokenHash, r.user_id, expiresAtMs, new Date().toISOString());
        }
        db.exec('DROP TABLE "_park_old_sessions"');
      } else {
        // Sessions were dropped by the users rebuild; _park_sessions holds the
        // legacy shape. Migrate old → new columns explicitly.
        const parkedCols = (db.prepare('PRAGMA table_info("_park_sessions")').all() as { name: string }[]);
        if (parkedCols.some(c => c.name === 'token')) {
          // Legacy park: id/token/user_id/expires_at
          const parkRows = db.prepare('SELECT token, user_id, expires_at FROM "_park_sessions"').all() as { token: string; user_id: number; expires_at: string }[];
          const ins = db.prepare('INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at_ms, created_at) VALUES (?, ?, ?, ?)');
          for (const r of parkRows) {
            const tokenHash = crypto.createHash('sha256').update(r.token).digest('hex');
            const expiresAtMs = new Date(r.expires_at).getTime();
            ins.run(tokenHash, r.user_id, expiresAtMs, new Date().toISOString());
          }
        }
        db.exec('DROP TABLE "_park_sessions"');
      }
    }
  }
}

function ensureCol(db: DatabaseType, table: string, col: string, defn: string) {
  const existing = db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[];
  if (!existing.some(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${defn}`);
  }
}

// Bring a pre-# migration media_models table (media_type, no priority/quota
// key columns) in line with what catalog-sync and the media services expect.
function ensureMediaModelsColumns(db: DatabaseType) {
  const cols = new Set((db.prepare('PRAGMA table_info(media_models)').all() as { name: string }[]).map(c => c.name));
  if (!cols.has('modality')) {
    db.exec('ALTER TABLE media_models ADD COLUMN modality TEXT');
    if (cols.has('media_type')) {
      db.exec('UPDATE media_models SET modality = media_type');
    }
  }
  if (!cols.has('priority')) db.exec('ALTER TABLE media_models ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('quota_label')) db.exec('ALTER TABLE media_models ADD COLUMN quota_label TEXT');
  if (!cols.has('key_id')) db.exec('ALTER TABLE media_models ADD COLUMN key_id INTEGER');
}

// Same story for embedding_models: the pre-merge table only had
// id/platform/model_id/display_name/dimensions/max_input/enabled, while the
// embeddings service and catalog-sync read family/priority/quota_label/key_id
// and the max input as `max_input_tokens`.
function ensureEmbeddingModelsColumns(db: DatabaseType) {
  const cols = new Set((db.prepare('PRAGMA table_info(embedding_models)').all() as { name: string }[]).map(c => c.name));
  if (!cols.has('family')) db.exec('ALTER TABLE embedding_models ADD COLUMN family TEXT');
  if (cols.has('max_input') && !cols.has('max_input_tokens')) {
    db.exec('ALTER TABLE embedding_models ADD COLUMN max_input_tokens INTEGER');
    db.exec('UPDATE embedding_models SET max_input_tokens = max_input');
  } else if (!cols.has('max_input_tokens')) {
    db.exec('ALTER TABLE embedding_models ADD COLUMN max_input_tokens INTEGER');
  }
  if (!cols.has('priority')) db.exec('ALTER TABLE embedding_models ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('quota_label')) db.exec("ALTER TABLE embedding_models ADD COLUMN quota_label TEXT NOT NULL DEFAULT ''");
  if (!cols.has('key_id')) db.exec('ALTER TABLE embedding_models ADD COLUMN key_id INTEGER');
  // Backfill legacy rows that never had a family assigned (pre-merge table had
  // no family column at all). Derive one from the provider model id so the
  // embeddings router and dashboard stay usable on migrated databases.
  const unclassified = db.prepare("SELECT id, model_id FROM embedding_models WHERE family IS NULL OR family = ''")
    .all() as { id: number; model_id: string }[];
  if (unclassified.length > 0) {
    const setFamily = db.prepare('UPDATE embedding_models SET family = ? WHERE id = ?');
    for (const row of unclassified) {
      setFamily.run((row.model_id.trim().split('/').pop() ?? row.model_id).toLowerCase(), row.id);
    }
  }
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
  const envPassword = process.env.ADMIN_PASSWORD;

  // Detect whether the users table uses `email` (new auth.ts schema) or
  // `username` (legacy baseline). The column existence check is cheap and
  // correct on both fresh installs and migrated databases.
  const hasEmailCol = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[])
    .some(c => c.name === 'email');

  if (!exists) {
    password = envPassword || `${crypto.randomBytes(3).toString('hex')}-${crypto.randomBytes(3).toString('hex')}`;
    if (hasEmailCol) {
      const hash = crypto.pbkdf2Sync(password, crypto.randomBytes(16).toString('hex'), 100000, 64, 'sha512').toString('hex');
      db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('admin@example.com', hash);
    } else {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)').run('admin', hash, salt);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?)").run(password);
    console.log(`\n  Admin user created:`);
  } else if (envPassword) {
    password = envPassword;
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get() as { value: string } | undefined;
    if (stored?.value !== envPassword) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      if (hasEmailCol) {
        db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@example.com');
      } else {
        db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?').run(hash, salt, 'admin');
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?)").run(password);
      console.log(`\n  Admin password set from ADMIN_PASSWORD env:`);
    } else {
      console.log(`\n  Admin credentials:`);
    }
  } else {
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get() as { value: string } | undefined;
    if (stored?.value) {
      password = stored.value;
    } else {
      password = `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`;
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      if (hasEmailCol) {
        db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'admin@example.com');
      } else {
        db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?').run(hash, salt, 'admin');
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?)").run(password);
      console.log(`\n  Admin password regenerated:`);
    }
  }

  console.log(`  Username: admin`);
  console.log(`  Password: ${password}`);
  console.log(`  (set ADMIN_PASSWORD env var to use a custom password)\n`);
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

export function getDefaultDbPath(): string {
  return process.env.FREEAPI_DB_PATH?.trim() || DB_PATH;
}

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export function connectDb(dbPath?: string, opts?: { ensureDir?: boolean }): DatabaseType {
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const isMemory = resolvedPath === ':memory:';
  const ensureDir = opts?.ensureDir ?? true;
  if (!isMemory && ensureDir) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }
  const d = new Database(resolvedPath);
  if (!isMemory) d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA foreign_keys = ON');
  return d;
}
