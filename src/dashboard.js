import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getTotalRevenue, getTodayRevenue, getRecentExecutions,
         getWithdrawals, getConfig, query, isReady } from './db.js'
import { getAutoWithdraw, setAutoWithdraw, withdraw } from './treasury.js'
import { getExecutorAddress } from './pimlico.js'
import { getBootstrapStatus } from './bootstrap.js'
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
  for (const c of clients) if (c.readyState===1) try { c.send(m) } catch {}
}

app.get('/health', (_,res) => res.status(200).json({
  status:'operational', uptime:Math.floor(process.uptime()),
  ts: new Date().toISOString(), dbReady: isReady()
}))

app.get('/api/overview', (req,res) => {
  if (!isReady()) return res.json({ initializing:true })
  try {
    const allChains = Object.keys(CHAINS)
    const borrowers = query('SELECT COUNT(*) as c FROM borrowers')[0]?.c||0
    const atRisk    = query('SELECT COUNT(*) as c FROM borrowers WHERE health_factor < 1.2 AND health_factor > 0')[0]?.c||0
    const liquidatable = query('SELECT COUNT(*) as c FROM borrowers WHERE health_factor < 1.0 AND health_factor > 0')[0]?.c||0
    const weekRevenue = Number(query(
      "SELECT SUM(profit_usdc) as t FROM executions WHERE status='success' AND created_at>=strftime('%s','now','-7 days')"
    )[0]?.t)||0
    const totalExecs = query('SELECT COUNT(*) as c FROM executions')[0]?.c||0
    const successExecs = query("SELECT COUNT(*) as c FROM executions WHERE status='success'")[0]?.c||0

    res.json({
      totalRevenue:  getTotalRevenue(),
      todayRevenue:  getTodayRevenue(),
      weekRevenue,
      borrowers, atRisk, liquidatable,
      recentExecutions: getRecentExecutions(15),
      prices:  JSON.parse(getConfig('prices')||'{}'),
      apex: {
        insight:       getConfig('apex_insight')||'Scanning.',
        action:        getConfig('apex_action')||'—',
        priorityChain: getConfig('apex_priority_chain')||'polygon'
      },
      executor:    getExecutorAddress(),
      autoWithdraw: getAutoWithdraw(),
      stats: {
        total:   totalExecs,
        success: successExecs,
        winRate: totalExecs>0 ? ((successExecs/totalExecs)*100).toFixed(1)+'%' : '0%'
      },
      chains: allChains.reduce((a,c) => ({
        ...a, [c]: {
          ws:       getConfig('ws_'+c)||'starting',
          contract: getConfig('contract_'+c)||'waiting',
          wr_aave:  getConfig('wr_'+c+'_aave')||'0.400',
          yield:    getConfig('yield_deployed_'+c)||'0',
          borrowers:query('SELECT COUNT(*) as c FROM borrowers WHERE chain=?',[c])[0]?.c||0,
          profit24: Number(query(
            "SELECT SUM(profit_usdc) as t FROM executions WHERE chain=? AND status='success' AND created_at>=strftime('%s','now','-1 day')",[c]
          )[0]?.t)||0
        }
      }), {})
    })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.get('/api/scanner', (req,res) => {
  if (!isReady()) return res.json({ borrowers:[], total:0 })
  try {
    const chain = req.query.chain
    const sql   = chain
      ? 'SELECT * FROM borrowers WHERE chain=? ORDER BY health_factor ASC LIMIT 500'
      : 'SELECT * FROM borrowers ORDER BY health_factor ASC LIMIT 500'
    const borrowers    = query(sql, chain ? [chain] : [])
    const total        = borrowers.length
    const liquidatable = borrowers.filter(b => b.health_factor < 1.0 && b.health_factor > 0).length
    const atRisk       = borrowers.filter(b => b.health_factor < 1.2 && b.health_factor > 0).length
    const safe         = total - atRisk
    res.json({ borrowers, total, liquidatable, atRisk, safe })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.get('/api/executions', (req,res) => {
  if (!isReady()) return res.json({ executions:[], stats:{} })
  try {
    const executions = query('SELECT * FROM executions ORDER BY created_at DESC LIMIT 300')
    const total   = query('SELECT COUNT(*) as c FROM executions')[0]?.c||0
    const success = query("SELECT COUNT(*) as c FROM executions WHERE status='success'"  )[0]?.c||0
    const profit  = query("SELECT SUM(profit_usdc) as t FROM executions WHERE status='success'"  )[0]?.t||0
    const missed  = Object.keys(CHAINS).reduce((a,c) => ({
      ...a, [c]: getConfig('missed_profit_'+c)||'0'
    }),{})
    res.json({ executions, stats:{total,success,profit,
      winRate: total>0?((success/total)*100).toFixed(1)+'%':'0%'}, missed })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.get('/api/treasury', (req,res) => {
  if (!isReady()) return res.json({})
  try {
    const chains = Object.keys(CHAINS)
    res.json({
      totalRevenue: getTotalRevenue(),
      todayRevenue: getTodayRevenue(),
      byChain: chains.reduce((a,c) => ({
        ...a, [c]: Number(query(
          "SELECT SUM(profit_usdc) as t FROM executions WHERE chain=? AND status='success'",[c]
        )[0]?.t)||0
      }),{}),
      withdrawals:  getWithdrawals(10),
      autoWithdraw: getAutoWithdraw(),
      x7tBurned:    Number(getConfig('x7t_burned')||0)
    })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.get('/api/bootstrap', (req,res) => {
  if (!isReady()) return res.json({ chains:{} })
  try { res.json(getBootstrapStatus()) }
  catch(e) { res.status(500).json({ error:e.message }) }
})

app.get('/api/system', (req,res) => {
  if (!isReady()) return res.json({ initializing:true })
  try {
    const envVars = ['EXECUTOR_PRIVATE_KEY','OWNER_PRIVATE_KEY','ANTHROPIC_API_KEY',
      'MODEM_PAY_SECRET_KEY','MODEM_PAY_WAVE_NUMBER',
      'ALCHEMY_POL_KEY','ALCHEMY_POLY_KEY','ALCHEMY_ARB_KEY',
      'ALCHEMY_ETH_KEY','ALCHEMY_AVAX_KEY','ALCHEMY_BASE_KEY',
      'ALCHEMY_OPT_KEY','ALCHEMY_BNB_KEY','ALCHEMY_SCROLL_KEY']
    res.json({
      uptime:      Math.floor(process.uptime()),
      memory:      (process.memoryUsage().heapUsed/1024/1024).toFixed(0)+'MB',
      executor:    getExecutorAddress(),
      dbReady:     isReady(),
      activeChains: ACTIVE_CHAINS,
      autoWithdraw: getAutoWithdraw(),
      apexLog:     query('SELECT * FROM apex_log ORDER BY created_at DESC LIMIT 30'),
      contracts:   Object.keys(CHAINS).reduce((a,c)=>({
        ...a,[c]:getConfig('contract_'+c)||'waiting'}),{}),
      gasPrices:   Object.keys(CHAINS).reduce((a,c)=>({
        ...a,[c]:getConfig('gas_price_'+c)||'—'}),{}),
      envStatus:   envVars.reduce((a,k)=>({
        ...a,[k]:!!(process.env[k]&&process.env[k].length>5)}),{})
    })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.post('/api/withdraw', async (req,res) => {
  try {
    const { amount } = req.body
    if (!amount || isNaN(+amount) || +amount<=0)
      return res.status(400).json({ error:'Valid amount required' })
    const result = await withdraw(+amount)
    broadcast('withdrawal', { amount, id:result.key })
    res.json({ success:true, ...result })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.post('/api/toggle-auto-withdraw', (req,res) => {
  const current = getAutoWithdraw()
  setAutoWithdraw(!current)
  broadcast('auto_withdraw_toggle', { enabled:!current })
  res.json({ autoWithdraw:!current })
})

app.get('*', (_,res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8')
  res.send(HTML)
})

export function startDashboard() {
  const PORT = parseInt(process.env.PORT)||3000
  server.listen(PORT, '0.0.0.0', () =>
    console.log('[DASHBOARD] Live on port '+PORT)
  )
  setInterval(() => {
    try {
      broadcast('tick', {
        revenue: getTotalRevenue(),
        today:   getTodayRevenue(),
        ts:      Date.now()
      })
    } catch {}
  }, 5000)
  return server
}
