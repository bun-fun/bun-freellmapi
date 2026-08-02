// Migration: <short description>
// Created: <YYYY-MM-DD>
//
// DOWN: <reversible | irreversible - reason>

import type { DatabaseType } from '../index.js';

export function up(db: DatabaseType): void {
  db.exec(`
    -- your SQL here
  `);
}

export function down(db: DatabaseType): void {
  // If reversible:
  db.exec(`
    -- inverse SQL here
  `);

  // If irreversible:
  // throw new Error('irreversible migration: <reason>');
}
