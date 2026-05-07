import type { Database } from '@sqlite.org/sqlite-wasm' with {
    'resolution-mode': 'import'
};

export const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS docsets (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL,
  version       TEXT,
  root_path     TEXT NOT NULL,
  documents_dir TEXT NOT NULL,
  index_format  TEXT NOT NULL,
  installed_at  INTEGER NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS symbols (
  id              INTEGER PRIMARY KEY,
  docset_id       INTEGER NOT NULL REFERENCES docsets(id) ON DELETE CASCADE,
  qualified_name  TEXT NOT NULL,
  unqualified     TEXT NOT NULL,
  parent          TEXT,
  kind            TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  anchor          TEXT,
  arglist         TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_qualified        ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_unqualified      ON symbols(unqualified);
CREATE INDEX IF NOT EXISTS idx_symbols_parent           ON symbols(parent);
CREATE INDEX IF NOT EXISTS idx_symbols_docset           ON symbols(docset_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind             ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_docset_filepath  ON symbols(docset_id, file_path);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_pages USING fts5(
    docset_id UNINDEXED,
    file_path UNINDEXED,
    title,
    body,
    tokenize = 'porter ascii'
);
`;

const MIGRATION_1_TO_2 = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_pages USING fts5(
    docset_id UNINDEXED,
    file_path UNINDEXED,
    title,
    body,
    tokenize = 'porter ascii'
);
`;

const MIGRATION_2_TO_3 = `
CREATE INDEX IF NOT EXISTS idx_symbols_docset_filepath ON symbols(docset_id, file_path);
`;

function migrateSchema(db: Database, fromVersion: number): void {
    if (fromVersion < 2) {
        db.exec(MIGRATION_1_TO_2);
        db.exec('PRAGMA user_version = 2');
    }
    if (fromVersion < 3) {
        db.exec(MIGRATION_2_TO_3);
        db.exec('PRAGMA user_version = 3');
    }
}

/**
 * Apply the schema and stamp the user-version pragma. Both calls are
 * synchronous against the sqlite-wasm OO1 database handle. Idempotent
 * thanks to the `IF NOT EXISTS` clauses, so re-opening an already-
 * initialized DB is a no-op.
 */
export function applySchema(db: Database): void {
    db.exec(SCHEMA_SQL);
    const v = readSchemaVersion(db);
    if (v < SCHEMA_VERSION) {
        migrateSchema(db, v);
    } else {
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
}

/**
 * Read the schema version stamped into the DB at create time. Used by
 * migration paths (none today; reserved for future schema bumps).
 */
export function readSchemaVersion(db: Database): number {
    const v = db.selectValue('PRAGMA user_version');
    return typeof v === 'number' ? v : Number(v ?? 0);
}
