// X7-SV · db.js — sql.js (pure WASM) + Postgres backup + Railway volume
// FIX: removed strftime() from schema — sql.js WASM omits date functions
// Timestamps written from JS (Date.now()/1000) not SQL DEFAULT

import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import pg from 'pg'

const require  = createRequire(import.meta.url)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH  = DATA_DIR + '/x7sv.db'

let _db, _pgPool, _SQL

// FIX: NO strftime() anywhere — sql.js WASM doesn't support it
// Timestamps are plain INTEGER, written as Math.floor(Date.now()/1000) from JS
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT, chain TEXT, protocol TEXT,
    profit_usdc REAL DEFAULT 0, status TEXT, created_at INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usdc_amount REAL, gmd_amount REAL, tx_id TEXT,
    status TEXT, created_at INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_exec_chain ON executions(chain, created_at);
  CREATE INDEX IF NOT EXISTS idx_exec_proto ON executions(protocol, status);
`

export async function initDB() {
  const initSqlJs = require('sql.js')
  _SQL = await initSqlJs()

  if (existsSync(DB_PATH)) {
    _db = new _SQL.Database(readFileSync(DB_PATH))
    console.log('[DB] Restored from', DB_PATH)
  } else {
    _db = new _SQL.Database()
    console.log('[DB] New database created')
  }

  _db.run(SCHEMA)
  _persist()

  if (process.env.DATABASE_URL) {
    try {
      _pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
      await _pgPool.query(`
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT, updated_at BIGINT DEFAULT 0);
        CREATE TABLE IF NOT EXISTS executions (
          id SERIAL PRIMARY KEY, tx_hash TEXT, chain TEXT, protocol TEXT,
          profit_usdc REAL DEFAULT 0, status TEXT, created_at BIGINT DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS withdrawals (
          id SERIAL PRIMARY KEY, usdc_amount REAL, gmd_amount REAL,
          tx_id TEXT, status TEXT, created_at BIGINT DEFAULT 0
        );
      `)
      // Restore config from Postgres if local DB is empty
      const n = _db.exec('SELECT COUNT(*) FROM config')[0]?.values[0][0] || 0
      if (n === 0) {
        const rows = await _pgPool.query('SELECT key, value FROM config')
        const ins  = _db.prepare('INSERT OR REPLACE INTO config(key,value,updated_at) VALUES(?,?,?)')
        rows.rows.forEach(r => ins.run([r.key, r.value, Math.floor(Date.now()/1000)]))
        ins.free()
        _persist()
        console.log('[DB] Restored', rows.rows.length, 'keys from Postgres')
      }
      console.log('[DB] Postgres connected')
    } catch(e) { console.log('[DB] Postgres optional:', e.message?.slice(0,60)) }
  }

  setInterval(_persist, 5000)
  console.log('[DB] Ready')
}

function _persist() {
  if (!_db) return
  try { writeFileSync(DB_PATH, Buffer.from(_db.export())) } catch {}
}

// Batched writes — flush every 100ms
const _queue = []
let   _timer = null

function _enqueue(sql, params) {
  _queue.push({ sql, params })
  if (!_timer) _timer = setTimeout(_flush, 100)
}

function _flush() {
  _timer = null
  if (!_queue.length || !_db) return
  try {
    _db.run('BEGIN')
    _queue.splice(0).forEach(({ sql, params }) => _db.run(sql, params))
    _db.run('COMMIT')
  } catch(e) {
    try { _db.run('ROLLBACK') } catch {}
    // Recreate DB if WASM memory corrupted
    if (e.message?.includes('memory') || e.message === 'undefined') {
      console.warn('[DB] WASM memory issue — recreating database')
      try {
        _db = new _SQL.Database()
        _db.run(SCHEMA)
      } catch {}
    } else {
      console.error('[DB] flush error:', e.message)
    }
  }
}

export function setConfig(key, value) {
  const v  = String(value)
  const ts = Math.floor(Date.now()/1000)
  _enqueue('INSERT OR REPLACE INTO config(key,value,updated_at) VALUES(?,?,?)', [key, v, ts])
  _pgPool?.query('INSERT INTO config(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=$3',
    [key, v, ts]).catch(()=>{})
}

export function getConfig(key) {
  if (!_db) return null
  try {
    const r = _db.exec(`SELECT value FROM config WHERE key='${key.replace(/'/g,"''")}'`)
    return r[0]?.values[0]?.[0] ?? null
  } catch { return null }
}

export function recordExecution(data) {
  const ts = Math.floor(Date.now()/1000)
  _enqueue(
    'INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status,created_at) VALUES(?,?,?,?,?,?)',
    [data.txHash||'', data.chain||'', data.protocol||'', data.profitUsdc||0, data.status||'success', ts]
  )
  _pgPool?.query(
    'INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status,created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [data.txHash||'', data.chain||'', data.protocol||'', data.profitUsdc||0, data.status||'success', ts]
  ).catch(()=>{})
}

export function recordWithdrawal(data) {
  _enqueue(
    'INSERT INTO withdrawals(usdc_amount,gmd_amount,tx_id,status,created_at) VALUES(?,?,?,?,?)',
    [data.usdcAmount, data.gmdAmount, data.txId||'', data.status||'completed', Math.floor(Date.now()/1000)]
  )
}

export function getExecutions(limit=50, protocol='') {
  if (!_db) return []
  try {
    const sql  = protocol
      ? 'SELECT * FROM executions WHERE protocol=? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM executions ORDER BY created_at DESC LIMIT ?'
    const stmt = _db.prepare(sql)
    const rows = []
    protocol ? stmt.bind([protocol, limit]) : stmt.bind([limit])
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  } catch { return [] }
}

export function getStats() {
  if (!_db) return { total:0, winRate:'0%', profit:0, today:0 }
  try {
    const now = Math.floor(Date.now()/1000)
    const r   = _db.exec(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) wins,
             COALESCE(SUM(profit_usdc),0) profit,
             COALESCE(SUM(CASE WHEN created_at > ${now-86400} THEN profit_usdc ELSE 0 END),0) today
      FROM executions
    `)
    const v = r[0]?.values[0] || [0,0,0,0]
    return { total:v[0]||0, winRate:v[0]?Math.round((v[1]/v[0])*100)+'%':'0%', profit:v[2]||0, today:v[3]||0 }
  } catch { return { total:0, winRate:'0%', profit:0, today:0 } }
          }
