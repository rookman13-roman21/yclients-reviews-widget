// kv-store.js — SQLite-based KV store that mimics Cloudflare KV API
// Methods: get(key), put(key, value), delete(key), list({limit, cursor})

const Database = require('better-sqlite3');
const path = require('path');

class KVStore {
  constructor(dbPath) {
    this.db = new Database(dbPath || path.join(__dirname, 'data', 'kv.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      )
    `);
    this._stmtGet = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    this._stmtPut = this.db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    this._stmtDel = this.db.prepare('DELETE FROM kv WHERE key = ?');
    this._stmtCount = this.db.prepare('SELECT COUNT(*) as cnt FROM kv');
  }

  async get(key) {
    const row = this._stmtGet.get(key);
    return row ? row.value : null;
  }

  async put(key, value) {
    this._stmtPut.run(key, String(value), Math.floor(Date.now() / 1000));
  }

  async delete(key) {
    this._stmtDel.run(key);
  }

  async list({ limit = 1000, cursor } = {}) {
    // cursor is the offset (stringified integer)
    const offset = cursor ? parseInt(cursor, 10) : 0;
    const safeLimit = Math.max(1, Math.min(1000, limit));
    const stmt = this.db.prepare('SELECT key FROM kv ORDER BY key LIMIT ? OFFSET ?');
    const rows = stmt.all(safeLimit, offset);
    const keys = rows.map(r => ({ name: r.key }));
    const total = this._stmtCount.get().cnt;
    const nextOffset = offset + rows.length;
    return {
      keys,
      cursor: nextOffset < total ? String(nextOffset) : null
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = KVStore;
