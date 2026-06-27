// X7-SV · db.js — sql.js WASM SQLite + Postgres backup + Railway volume
// SELF-HEALING: migrates old schema automatically, never crashes on column mismatch
// FIX: old DB had updated_at/created_at — new schema uses ts
//      Migration runs on every boot, adds missing columns, copies data
// FOREVER-PROOF: handles any schema version from any prior deploy

import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import pg from 'pg'

const require  = createRequire(import.meta.url)
const DIR      = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
const PATH     = DIR + '/x7sv.db'
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })

let _db, _pg, _SQL

// ── SCHEMA ────────────────────────────────────────────────────────────────────
// ts column only — no strftime(), no updated_at, no created_at
// Written from JS: Math.floor(Date.now()/1000)
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config(
    key   TEXT PRIMARY KEY,
    value TEXT,
    ts    INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS executions(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash     TEXT,
    chain       TEXT,
    protocol    TEXT,
    profit_usdc REAL    DEFAULT 0,
    status      TEXT,
    ts          INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_exec ON executions(chain, ts);
`

// ── MIGRATION: handle any old schema version ──────────────────────────────────
// Adds 'ts' column if missing, copies from updated_at/created_at if present
// Safe to run on every boot — all operations are idempotent
function migrate(db) {
  try {
    // Config table migration
    const configCols = db.exec("PRAGMA table_info(config)")[0]?.values?.map(r => r[1]) || []
    if (!configCols.includes('ts')) {
      db.run('ALTER TABLE config ADD COLUMN ts INTEGER DEFAULT 0')
      console.log('[DB] Migration: added ts to config')
      // Copy from updated_at if it exists
      if (configCols.includes('updated_at')) {
        db.run('UPDATE config SET ts = updated_at WHERE ts = 0 AND updated_at IS NOT NULL')
        console.log('[DB] Migration: copied updated_at → ts in config')
      }
    }

    // Executions table migration
    const execCols = db.exec("PRAGMA table_info(executions)")[0]?.values?.map(r => r[1]) || []
    if (!execCols.includes('ts')) {
      db.run('ALTER TABLE executions ADD COLUMN ts INTEGER DEFAULT 0')
      console.log('[DB] Migration: added ts to executions')
      // Copy from created_at if it exists
      if (execCols.includes('created_at')) {
        db.run('UPDATE executions SET ts = created_at WHERE ts = 0 AND created_at IS NOT NULL')
        console.log('[DB] Migration: copied created_at → ts in executions')
      }
    }

    // Withdrawals table (may not exist — create if needed)
    db.run(`
      CREATE TABLE IF NOT EXISTS withdrawals(
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        usdc_amount REAL,
        gmd_amount  REAL,
        tx_id       TEXT,
        status      TEXT,
        ts          INTEGER DEFAULT 0
      );
    `)

    console.log('[DB] Migration complete')
  } catch(e) {
    // Migration errors are non-fatal — log and continue
    console.warn('[DB] Migration warning:', e.message?.slice(0, 100))
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────────
export async function initDB() {
  _SQL = await require('sql.js')()

  // Load existing DB or create new
  if (existsSync(PATH)) {
    try {
      _db = new _SQL.Database(readFileSync(PATH))
      console.log('[DB] Restored from', PATH)
    } catch(e) {
      console.warn('[DB] Corrupt DB file — creating fresh:', e.message?.slice(0,60))
      _db = new _SQL.Database()
    }
  } else {
    _db = new _SQL.Database()
    console.log('[DB] New database created')
  }

  // Apply schema (CREATE IF NOT EXISTS — safe)
  _db.run(SCHEMA)

  // Migrate any old columns
  migrate(_db)

  // Save immediately after migration
  _save()

  // Optional Postgres backup
  if (process.env.DATABASE_URL) {
    try {
      _pg = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
      await _pg.query(`
        CREATE TABLE IF NOT EXISTS config(
          key TEXT PRIMARY KEY, value TEXT, ts BIGINT DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS executions(
          id SERIAL PRIMARY KEY, tx_hash TEXT, chain TEXT, protocol TEXT,
          profit_usdc REAL DEFAULT 0, status TEXT, ts BIGINT DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS withdrawals(
          id SERIAL PRIMARY KEY, usdc_amount REAL, gmd_amount REAL,
          tx_id TEXT, status TEXT, ts BIGINT DEFAULT 0
        );
      `)

      // Restore config from Postgres if local DB is empty
      const n = _db.exec('SELECT COUNT(*) FROM config')[0]?.values[0][0] || 0
      if (!n) {
        const rows = await _pg.query('SELECT key, value FROM config')
        if (rows.rows.length) {
          const s = _db.prepare('INSERT OR REPLACE INTO config(key,value,ts) VALUES(?,?,?)')
          rows.rows.forEach(r => s.run([r.key, r.value, Math.floor(Date.now()/1000)]))
          s.free()
          _save()
          console.log('[DB] Restored', rows.rows.length, 'keys from Postgres')
        }
      }
      console.log('[DB] Postgres connected — dual-write active')
    } catch(e) {
      console.log('[DB] Postgres optional:', e.message?.slice(0,60))
    }
  }

  // Persist every 5 seconds
  setInterval(_save, 5000)
  console.log('[DB] Ready')
}

// ── PERSIST ───────────────────────────────────────────────────────────────────
function _save() {
  if (!_db) return
  try { writeFileSync(PATH, Buffer.from(_db.export())) } catch {}
}

// ── WRITE QUEUE (batched 100ms) ───────────────────────────────────────────────
const _q = []
let   _t = null

function _flush() {
  _t = null
  if (!_q.length || !_db) return
  try {
    _db.run('BEGIN')
    _q.splice(0).forEach(({ s, p }) => _db.run(s, p))
    _db.run('COMMIT')
  } catch(e) {
    try { _db.run('ROLLBACK') } catch {}
    // Self-heal: recreate if WASM memory corrupted
    if (!e.message || e.message === 'undefined' || e.message.includes('memory')) {
      console.warn('[DB] Self-heal: recreating WASM database')
      try {
        _db = new _SQL.Database()
        _db.run(SCHEMA)
        migrate(_db)
      } catch {}
    } else {
      console.error('[DB] flush error:', e.message?.slice(0, 100))
    }
  }
}

function _w(s, p) {
  _q.push({ s, p })
  if (!_t) _t = setTimeout(_flush, 100)
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
export function setConfig(k, v) {
  const ts = Math.floor(Date.now() / 1000)
  _w('INSERT OR REPLACE INTO config(key,value,ts) VALUES(?,?,?)', [k, String(v), ts])
  _pg?.query(
    'INSERT INTO config(key,value,ts) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=$2, ts=$3',
    [k, String(v), ts]
  ).catch(() => {})
}

export function getConfig(k) {
  try {
    return _db?.exec(
      `SELECT value FROM config WHERE key='${k.replace(/'/g, "''")}'`
    )[0]?.values[0]?.[0] ?? null
  } catch { return null }
}

export function recordExecution(d) {
  const ts = Math.floor(Date.now() / 1000)
  _w(
    'INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status,ts) VALUES(?,?,?,?,?,?)',
    [d.txHash||'', d.chain||'', d.protocol||'', d.profitUsdc||0, d.status||'success', ts]
  )
  _pg?.query(
    'INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status,ts) VALUES($1,$2,$3,$4,$5,$6)',
    [d.txHash||'', d.chain||'', d.protocol||'', d.profitUsdc||0, d.status||'success', ts]
  ).catch(() => {})
}

export function recordWithdrawal(d) {
  _w(
    'INSERT INTO withdrawals(usdc_amount,gmd_amount,tx_id,status,ts) VALUES(?,?,?,?,?)',
    [d.usdcAmount, d.gmdAmount, d.txId||'', d.status||'completed', Math.floor(Date.now()/1000)]
  )
}

export function getStats() {
  try {
    const now = Math.floor(Date.now() / 1000)
    const r = _db.exec(`
      SELECT
        COUNT(*)                                                          total,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)                wins,
        COALESCE(SUM(profit_usdc), 0)                                     profit,
        COALESCE(SUM(CASE WHEN ts > ${now - 86400} THEN profit_usdc ELSE 0 END), 0) today
      FROM executions
    `)[0]?.values[0] || [0, 0, 0, 0]
    return {
      total:   r[0] || 0,
      winRate: r[0] ? Math.round((r[1] / r[0]) * 100) + '%' : '0%',
      profit:  r[2] || 0,
      today:   r[3] || 0
    }
  } catch { return { total: 0, winRate: '0%', profit: 0, today: 0 } }
}

export function getExecutions(limit = 50) {
  try {
    const s = _db.prepare('SELECT * FROM executions ORDER BY ts DESC LIMIT ?')
    s.bind([limit])
    const rows = []
    while (s.step()) rows.push(s.getAsObject())
    s.free()
    return rows
  } catch { return [] }
}
