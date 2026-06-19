// X7 PROTOCOL — DASHBOARD SERVER
// FIXED: All strategy data imported and served
// FIXED: All tabs connected to real data
// Live balance every 3 seconds via WebSocket push

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getTotalRevenue, getTodayRevenue, getRecentExecutions,
         getWithdrawals, getConfig, query, isReady } from './db.js'
import { getAutoWithdraw, setAutoWithdraw, withdraw } from './treasury.js'
import { getExecutorAddress, getNativeBalance } from './pimlico.js'
import { CHAINS, ACTIVE_CHAINS } from './config.js'

const __dir  = dirname(fileURLToPath(import.meta.url))
const HTML   = readFileSync(join(__dir, 'dashboard/index.html'), 'utf8')
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
const clients= new Set()
app.use(express.json())

wss.on('connection', ws => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

export function broadcast(type, data) {
  const m = JSON.stringify({ type, data, ts: Date.now() })
  for (const c of clients)
    if (c.readyState === 1) try { c.send(m) } catch {}
}

// Push live balances every 3 seconds
async function pushLiveBalances() {
  const execAddr = getExecutorAddress()
  if (!execAddr) return
  const balances = {}
  for (const c of ['polygon','arbitrum','ethereum','avalanche']) {
    balances[c] = getConfig('live_balance_' + c) || '0.000000'
  }
  broadcast('balances', { executor: execAddr, balances })
}

app.get('/health', (_, res) => res.status(200).json({
  status: 'operational',
  uptime: Math.floor(process.uptime()),
  ts:     new Date().toISOString(),
  dbReady: isReady()
}))

app.get('/api/overview', (req, res) => {
  if (!isReady()) return res.json({ initializing: true })
  try {
    // Import strategy stats
    let stratData = {}
    try {
      const saved = getConfig('strategy_stats')
      if (saved) stratData = JSON.parse(saved)
    } catch {}

    const totalExecs   = query('SELECT COUNT(*) as c FROM executions')[0]?.c || 0
    const successExecs = query("SELECT COUNT(*) as c FROM executions WHERE status='success'")[0]?.c || 0
    const borrowers    = query('SELECT COUNT(*) as c FROM borrowers')[0]?.c || 0
    const atRisk       = query('SELECT COUNT(*) as c FROM borrowers WHERE health_factor<1.1 AND health_factor>0')[0]?.c || 0
    const liquidatable = query('SELECT COUNT(*) as c FROM borrowers WHERE health_factor<1.0 AND health_factor>0')[0]?.c || 0
    const weekRev      = Number(query(
      "SELECT SUM(profit_usdc) as t FROM executions WHERE status='success' AND created_at>=strftime('%s','now','-7 days')"
    )[0]?.t) || 0

    const balances = {}
    for (const c of ['polygon','arbitrum','ethereum','avalanche']) {
      balances[c] = getConfig('live_balance_' + c) || '0'
    }

    const executor = getExecutorAddress()

    res.json({
      totalRevenue:      getTotalRevenue(),
      todayRevenue:      getTodayRevenue(),
      weekRevenue:       weekRev,
      recentExecutions:  getRecentExecutions(20),
      prices:     JSON.parse(getConfig('prices') || '{}'),
      apex:       {
        insight:  getConfig('apex_insight') || 'All 33 strategies scanning.',
        action:   getConfig('apex_action')  || 'Targeting $100M+ swaps.',
        priorityChain: getConfig('apex_priority_chain') || 'ethereum'
      },
      borrowers, atRisk, liquidatable,
      executor,
      balances,
      autoWithdraw: getAutoWithdraw(),
      stats: {
        total:   totalExecs,
        success: successExecs,
        winRate: totalExecs > 0
          ? ((successExecs / totalExecs) * 100).toFixed(1) + '%' : '0%'
      },
      strategies: {
        total:   Number(getConfig('strategies_total')  || 0),
        missed:  Number(getConfig('strategies_missed') || 0),
        count:   Number(getConfig('strategies_count')  || 0),
        stats:   stratData
      },
      chains: ACTIVE_CHAINS.reduce((a, c) => ({
        ...a, [c]: {
          ws:        getConfig('ws_' + c)       || 'starting',
          contract:  getConfig('contract_' + c) || 'waiting',
          wr_aave:   getConfig('wr_' + c + '_aave') || '0.400',
          yield:     getConfig('yield_deployed_' + c) || '0',
          borrowers: query('SELECT COUNT(*) as c FROM borrowers WHERE chain=?', [c])[0]?.c || 0,
          profit24:  Number(query(
            "SELECT SUM(profit_usdc) as t FROM executions WHERE chain=? AND status='success' AND created_at>=strftime('%s','now','-1 day')", [c]
          )[0]?.t) || 0,
          balance:   getConfig('live_balance_' + c) || '0'
        }
      }), {})
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/strategies', (req, res) => {
  if (!isReady()) return res.json({})
  try {
    let stats = {}
    const saved = getConfig('strategy_stats')
    if (saved) stats = JSON.parse(saved)
    res.json({
      stats,
      total:  Number(getConfig('strategies_total')  || 0),
      missed: Number(getConfig('strategies_missed') || 0)
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/scanner', (req, res) => {
  if (!isReady()) return res.json({ borrowers: [], total: 0 })
  try {
    const chain = req.query.chain
    const sql   = chain
      ? 'SELECT * FROM borrowers WHERE chain=? ORDER BY health_factor ASC LIMIT 1000'
      : 'SELECT * FROM borrowers ORDER BY health_factor ASC LIMIT 1000'
    const borrowers    = query(sql, chain ? [chain] : [])
    const total        = borrowers.length
    const liquidatable = borrowers.filter(b => b.health_factor < 1.0 && b.health_factor > 0).length
    const atRisk       = borrowers.filter(b => b.health_factor < 1.2 && b.health_factor > 0).length
    res.json({ borrowers, total, liquidatable, atRisk, safe: total - atRisk })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/executions', (req, res) => {
  if (!isReady()) return res.json({ executions: [], stats: {} })
  try {
    const executions = query('SELECT * FROM executions ORDER BY created_at DESC LIMIT 500')
    const total      = query('SELECT COUNT(*) as c FROM executions')[0]?.c || 0
    const success    = query("SELECT COUNT(*) as c FROM executions WHERE status='success'")[0]?.c || 0
    const profit     = query("SELECT SUM(profit_usdc) as t FROM executions WHERE status='success'"  )[0]?.t || 0
    const missed     = ACTIVE_CHAINS.reduce((s, c) => ({
      ...s, [c]: getConfig('missed_profit_' + c) || '0'
    }), {})
    res.json({ executions, missed,
      stats: { total, success, profit,
               winRate: total > 0 ? ((success/total)*100).toFixed(1)+'%':'0%' }
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/treasury', (req, res) => {
  if (!isReady()) return res.json({})
  try {
    res.json({
      totalRevenue: getTotalRevenue(),
      todayRevenue: getTodayRevenue(),
      byChain:      ACTIVE_CHAINS.reduce((a, c) => ({
        ...a, [c]: Number(query(
          "SELECT SUM(profit_usdc) as t FROM executions WHERE chain=? AND status='success'", [c]
        )[0]?.t) || 0
      }), {}),
      withdrawals:  getWithdrawals(10),
      autoWithdraw: getAutoWithdraw()
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/system', (req, res) => {
  if (!isReady()) return res.json({ initializing: true })
  try {
    const envVars = [
      'EXECUTOR_PRIVATE_KEY','ANTHROPIC_API_KEY',
      'ALCHEMY_POL_KEY','ALCHEMY_POL_KEY','ALCHEMY_ARB_KEY',
      'ALCHEMY_ETH_KEY','ALCHEMY_AVAX_KEY',
      'MODEM_PAY_SECRET_KEY','MODEM_PAY_WAVE_NUMBER'
    ]
    res.json({
      uptime:      Math.floor(process.uptime()),
      memory:      (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0) + 'MB',
      executor:    getExecutorAddress(),
      dbReady:     isReady(),
      activeChains: ACTIVE_CHAINS,
      contracts:   ACTIVE_CHAINS.reduce((a, c) => ({
        ...a, [c]: getConfig('contract_' + c) || '--'
      }), {}),
      apexLog: query('SELECT * FROM apex_log ORDER BY created_at DESC LIMIT 20'),
      envStatus: envVars.reduce((a, k) => ({
        ...a, [k]: !!(process.env[k] && process.env[k].length > 5)
      }), {})
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/withdraw', async (req, res) => {
  try {
    const { amount } = req.body
    if (!amount || isNaN(+amount) || +amount <= 0)
      return res.status(400).json({ error: 'Valid amount required' })
    const result = await withdraw(+amount)
    broadcast('withdrawal', { amount, id: result.key })
    res.json({ success: true, ...result })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/toggle-auto-withdraw', (req, res) => {
  const current = getAutoWithdraw()
  setAutoWithdraw(!current)
  broadcast('auto_withdraw_toggle', { enabled: !current })
  res.json({ autoWithdraw: !current })
})

app.get('*', (_, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(HTML)
})

export function startDashboard() {
  const PORT = parseInt(process.env.PORT) || 3000
  server.listen(PORT, '0.0.0.0', () =>
    console.log('[DASHBOARD] Live on port ' + PORT))

  // Revenue tick every 5 seconds
  setInterval(() => {
    try {
      broadcast('tick', {
        revenue: getTotalRevenue(),
        today:   getTodayRevenue(),
        strategies: {
          total:  Number(getConfig('strategies_total')  || 0),
          missed: Number(getConfig('strategies_missed') || 0)
        },
        ts: Date.now()
      })
    } catch {}
  }, 5000)

  // Live balance every 3 seconds
  setInterval(() => pushLiveBalances().catch(() => {}), 3000)

  return server
}
