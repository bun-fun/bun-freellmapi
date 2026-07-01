import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');

const HF_TOKEN = process.env.HF_TOKEN;
const HF_DATASET_ID = process.env.HF_DATASET_ID;
const BACKUP_ENABLED = process.env.BACKUP_ENABLED === 'true';
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS ?? 86400000);

const BACKUP_PREFIX = 'backup_';
const BACKUP_SUFFIX = '.db';

interface HfFile {
  path: string;
  type: string;
}

function log(msg: string) {
  console.log(`[Backup] ${msg}`);
}

function getBackupFiles(files: HfFile[]): string[] {
  return files
    .filter(
      (f) =>
        f.type === 'file' &&
        f.path.startsWith(BACKUP_PREFIX) &&
        f.path.endsWith(BACKUP_SUFFIX)
    )
    .map((f) => f.path)
    .sort();
}

function parseBackupTimestamp(filename: string): number {
  const match = filename.match(/backup_(\d{8})_(\d{6})\.db/);
  if (!match) return 0;
  const [, date, time] = match;
  return new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(
      0,
      2
    )}:${time.slice(2, 4)}:${time.slice(4, 6)}`
  ).getTime();
}

export async function restoreLatestBackup(dbPath?: string): Promise<boolean> {
  if (!BACKUP_ENABLED || !HF_TOKEN || !HF_DATASET_ID) {
    log('Backup not configured, skipping restore.');
    return false;
  }

  const targetPath = dbPath ?? DB_PATH;

  try {
    log('Checking for remote backups...');
    const listUrl = `https://huggingface.co/api/datasets/${HF_DATASET_ID}/tree/main`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${HF_TOKEN}` },
    });

    if (!listRes.ok) {
      if (listRes.status === 404) {
        log('Dataset not found. Skipping restore.');
        return false;
      }
      throw new Error(
        `Failed to list dataset files: ${listRes.status} ${listRes.statusText}`
      );
    }

    const files = (await listRes.json()) as HfFile[];
    const backups = getBackupFiles(files);

    if (backups.length === 0) {
      log('No backups found in dataset.');
      return false;
    }

    const latest = backups[backups.length - 1];
    log(`Found latest backup: ${latest}`);

    const dataDir = path.dirname(targetPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // If local DB exists, back it up locally first (safety)
    if (fs.existsSync(targetPath)) {
      const localBackup = path.join(
        dataDir,
        `local_before_restore_${Date.now()}.db`
      );
      fs.copyFileSync(targetPath, localBackup);
      log(`Local DB backed up to ${localBackup}`);
    }

    const downloadUrl = `https://huggingface.co/datasets/${HF_DATASET_ID}/resolve/main/${latest}`;
    const downloadRes = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${HF_TOKEN}` },
    });

    if (!downloadRes.ok) {
      throw new Error(`Failed to download backup: ${downloadRes.status}`);
    }

    const buffer = Buffer.from(await downloadRes.arrayBuffer());
    fs.writeFileSync(targetPath, buffer);
    log(`Restored ${latest} to ${targetPath} (${buffer.length} bytes)`);
    return true;
  } catch (err) {
    console.error('[Backup] Restore failed:', err);
    return false;
  }
}

export async function createBackup(): Promise<boolean> {
  if (!BACKUP_ENABLED || !HF_TOKEN || !HF_DATASET_ID) {
    log('Backup not configured, skipping backup.');
    return false;
  }

  if (!fs.existsSync(DB_PATH)) {
    log('Local DB not found, skipping backup.');
    return false;
  }

  try {
    // Ensure WAL is checkpointed so the main db file is complete
    const { Database } = require('bun:sqlite');
    const db = new Database(DB_PATH);
    db.exec('PRAGMA wal_checkpoint(FULL)');
    db.close();

    const timestamp = new Date();
    const dateStr = timestamp.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = timestamp.toTimeString().slice(0, 8).replace(/:/g, '');
    const filename = `${BACKUP_PREFIX}${dateStr}_${timeStr}${BACKUP_SUFFIX}`;

    log(`Creating backup: ${filename}`);

    // Copy to temp file to avoid reading while db may be written
    const tmpPath = path.join(
      path.dirname(DB_PATH),
      `.tmp_backup_${Date.now()}.db`
    );
    fs.copyFileSync(DB_PATH, tmpPath);

    const fileBuffer = fs.readFileSync(tmpPath);

    const uploadUrl = `https://huggingface.co/api/datasets/${HF_DATASET_ID}/upload/main/${filename}`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/octet-stream',
      },
      body: fileBuffer,
    });

    // Clean up temp file
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(
        `Upload failed: ${uploadRes.status} ${uploadRes.statusText} - ${text}`
      );
    }

    log(`Uploaded ${filename} successfully.`);
    await cleanupOldBackups();
    return true;
  } catch (err) {
    console.error('[Backup] Backup creation failed:', err);
    return false;
  }
}

async function cleanupOldBackups(): Promise<void> {
  try {
    const listUrl = `https://huggingface.co/api/datasets/${HF_DATASET_ID}/tree/main`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${HF_TOKEN}` },
    });

    if (!listRes.ok) return;

    const files = (await listRes.json()) as HfFile[];
    const backups = getBackupFiles(files);

    if (backups.length <= 3) return;

    const sorted = backups
      .map((f) => ({ path: f, ts: parseBackupTimestamp(f) }))
      .sort((a, b) => a.ts - b.ts);

    const toDelete = sorted.slice(0, sorted.length - 3).map((x) => x.path);

    const commitUrl = `https://huggingface.co/api/datasets/${HF_DATASET_ID}/commit/main`;
    const commitRes = await fetch(commitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: 'Cleanup old backups (keep last 3)',
        deletedFiles: toDelete,
      }),
    });

    if (commitRes.ok) {
      log(`Deleted ${toDelete.length} old backups: ${toDelete.join(', ')}`);
    } else {
      const text = await commitRes.text();
      log(`Failed to delete old backups: ${commitRes.status} ${text}`);
    }
  } catch (err) {
    console.error('[Backup] Cleanup failed:', err);
  }
}

export function startBackupScheduler(): void {
  if (!BACKUP_ENABLED) {
    log('Backup scheduler disabled.');
    return;
  }

  log(`Backup scheduler started (interval: ${BACKUP_INTERVAL_MS}ms)`);

  // Run first backup after interval, then recurring
  setTimeout(() => {
    createBackup().catch(console.error);
    setInterval(() => createBackup().catch(console.error), BACKUP_INTERVAL_MS);
  }, BACKUP_INTERVAL_MS);
}
