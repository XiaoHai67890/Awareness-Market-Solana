// Anchoring state is durable user data, independent of the rebuildable index.
// anchor_state  = the last SNAPSHOTTED content hash per card (what the latest
//                 built delta committed to), not the last broadcast one.
// anchor_outbox = locally built, sequence-ordered deltas awaiting broadcast.
// anchor_meta   = space identity + local head (last built seq / root).

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const MIGRATION_KEY = 'legacy_index_migration_v1';
const ANCHOR_TABLES = ['anchor_state', 'anchor_outbox', 'anchor_meta'];

function readLegacyState(indexDb) {
  if (!indexDb) return null;
  if (indexDb.open === false) throw new Error('cannot migrate anchoring from a closed index database');
  return indexDb.transaction(() => {
    const tables = new Set(indexDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map((row) => row.name));
    const present = ANCHOR_TABLES.filter((table) => tables.has(table));
    if (present.length === 0) return null;
    if (present.length !== ANCHOR_TABLES.length) {
      throw new Error('incomplete legacy anchoring tables; original index state was preserved');
    }
    return {
      state: indexDb.prepare('SELECT * FROM anchor_state').all(),
      outbox: indexDb.prepare('SELECT * FROM anchor_outbox').all(),
      meta: indexDb.prepare('SELECT * FROM anchor_meta').all(),
    };
  }).deferred();
}

function copyLegacyState(db, indexDb) {
  // Destination-only commit: a failed copy cannot delete or mutate the old data.
  return db.transaction(() => {
    if (getMeta(db, MIGRATION_KEY)) return {migrated: false, alreadyMigrated: true};
    const legacy = readLegacyState(indexDb);
    if (!legacy) return {migrated: false};
    const hasLegacyData = legacy.state.length + legacy.outbox.length + legacy.meta.length > 0;
    if (hasLegacyData) {
      const hasDestinationData = ANCHOR_TABLES.some((table) =>
        db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
      );
      if (hasDestinationData) {
        throw new Error('legacy anchoring conflicts with the independent database; both were preserved');
      }
      const state = db.prepare(
        'INSERT INTO anchor_state (card_id, content_hash, built_seq) VALUES (@card_id, @content_hash, @built_seq)'
      );
      for (const row of legacy.state) state.run(row);
      const outbox = db.prepare(`INSERT INTO anchor_outbox
        (seq, space_id, prev_state_root, delta_commitment, provenance_commitment,
         profile_id, locator_commitment, transition_id, next_state_root, ops_count,
         witness_path, status, tx_hash, created_at, anchored_at)
        VALUES (@seq, @space_id, @prev_state_root, @delta_commitment, @provenance_commitment,
         @profile_id, @locator_commitment, @transition_id, @next_state_root, @ops_count,
         @witness_path, @status, @tx_hash, @created_at, @anchored_at)`);
      for (const row of legacy.outbox) outbox.run(row);
      for (const row of legacy.meta) setMeta(db, row.key, row.value);
      // Legacy space identities and queued transactions were always EVM. Empty
      // tables alone are not an identity and must not bind a fresh Solana space.
      if (getMeta(db, 'space_id') || legacy.outbox.length > 0) setMeta(db, 'backend', 'evm');
    }
    setMeta(db, MIGRATION_KEY, hasLegacyData ? 'copied' : 'empty');
    return {migrated: hasLegacyData, rows: legacy.outbox.length};
  }).immediate();
}

export function openAnchoringDatabase(awarenessDir, indexDb) {
  fs.mkdirSync(awarenessDir, {recursive: true});
  const filename = path.join(awarenessDir, 'anchoring.sqlite');
  // Create with private permissions before SQLite writes any identity or data.
  try { fs.closeSync(fs.openSync(filename, 'wx', 0o600)); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  if (!fs.lstatSync(filename).isFile()) throw new Error('anchoring.sqlite must be a regular file');
  fs.chmodSync(filename, 0o600);
  const db = new Database(filename);
  try {
    db.pragma('busy_timeout = 5000');
    ensureAnchorTables(db);
    const migration = copyLegacyState(db, indexDb);
    return {db, migration};
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Run before deleting/rebuilding index.db, even when no manager is running. */
export function migrateLegacyAnchoring(awarenessDir, indexDb) {
  const {db, migration} = openAnchoringDatabase(awarenessDir, indexDb);
  db.close();
  return migration;
}

export function ensureAnchorTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS anchor_state (
      card_id      TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      built_seq    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS anchor_outbox (
      seq                   INTEGER PRIMARY KEY,
      space_id              TEXT NOT NULL,
      prev_state_root       TEXT NOT NULL,
      delta_commitment      TEXT NOT NULL,
      provenance_commitment TEXT NOT NULL,
      profile_id            TEXT NOT NULL,
      locator_commitment    TEXT NOT NULL,
      transition_id         TEXT NOT NULL,
      next_state_root       TEXT NOT NULL,
      ops_count             INTEGER NOT NULL,
      witness_path          TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'pending',
      tx_hash               TEXT,
      created_at            TEXT NOT NULL,
      anchored_at           TEXT
    );
    CREATE TABLE IF NOT EXISTS anchor_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM anchor_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO anchor_meta (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function getStateMap(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT card_id, content_hash FROM anchor_state').all()) {
    map.set(row.card_id, row.content_hash);
  }
  return map;
}

/** Replace anchor_state with the new snapshot, atomically with outbox insert. */
export function applySnapshot(db, entries, seq) {
  const upsert = db.prepare(
    'INSERT INTO anchor_state (card_id, content_hash, built_seq) VALUES (?, ?, ?) ' +
    'ON CONFLICT(card_id) DO UPDATE SET content_hash = excluded.content_hash, built_seq = excluded.built_seq'
  );
  const keep = new Set();
  for (const e of entries) {
    upsert.run(e.card_id, e.content_hash, seq);
    keep.add(e.card_id);
  }
  const stale = db.prepare('SELECT card_id FROM anchor_state').all()
    .map((r) => r.card_id).filter((id) => !keep.has(id));
  const del = db.prepare('DELETE FROM anchor_state WHERE card_id = ?');
  for (const id of stale) del.run(id);
}

export function insertOutbox(db, row) {
  db.prepare(
    `INSERT INTO anchor_outbox
       (seq, space_id, prev_state_root, delta_commitment, provenance_commitment,
        profile_id, locator_commitment, transition_id, next_state_root,
        ops_count, witness_path, status, created_at)
     VALUES (@seq, @space_id, @prev_state_root, @delta_commitment, @provenance_commitment,
             @profile_id, @locator_commitment, @transition_id, @next_state_root,
             @ops_count, @witness_path, 'pending', @created_at)`
  ).run(row);
}

export function listPending(db) {
  return db.prepare(
    "SELECT * FROM anchor_outbox WHERE status = 'pending' ORDER BY seq ASC"
  ).all();
}

export function countAnchored(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM anchor_outbox WHERE status = 'anchored'").get();
  const last = db.prepare(
    "SELECT tx_hash FROM anchor_outbox WHERE status = 'anchored' ORDER BY seq DESC LIMIT 1"
  ).get();
  return {count: row?.n ?? 0, lastTxHash: last?.tx_hash ?? null};
}

export function confirmSeq(db, seq, txHash) {
  const info = db.prepare(
    "UPDATE anchor_outbox SET status = 'anchored', tx_hash = ?, anchored_at = ? " +
    "WHERE seq = ? AND status = 'pending'"
  ).run(txHash, new Date().toISOString(), seq);
  return info.changes === 1;
}
