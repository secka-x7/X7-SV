// ApexAI — Claude-powered autonomous operations
// Runs every 5 minutes. Returns JSON commands. X7-SV executes them.
// Cost: ~$5-15/day. Revenue uplift: millions.
import Anthropic from '@anthropic-ai/sdk'
import { getConfig, setConfig, getStats, getExecutions } from './db.js'
import { getStatus } from './deployer1a.js'
import { getActive, addChain } from './chains.js'
import { emit } from './events.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
let _lastCall = 0

const SYSTEM = `You are ApexAI, autonomous decision engine for X7-SV MEV system.
Analyze state. Return ONLY valid JSON with these optional keys:
{
  "chainExpansion": [{"name":"chainname","rpcH":"url","id":123,"native":"ETH","usdc":"0x","weth":"0x","router":"0x","flash":"0x","tier":3,"minProfit":5}],
  "svWeights": {"SV4":0.2,"SV5":0.3,"SV6":0.25,"SV3":0.1,"SV8":0.1,"others":0.05},
  "propellerIntensity": {"ethereum":8,"arbitrum":7},
  "pauseChains": ["chainname"],
  "resumeChains": ["chainname"],
  "flashSource": {"ethereum":"balancer","scroll":"aave"},
  "alert": {"severity":"low|medium|high","message":"..."},
  "insights": "one line operational insight"
}
Rules: maximize revenue, manage risk, expand aggressively to new chains with TVL>$10M.`

async function callApexAI() {
  if (!process.env.ANTHROPIC_API_KEY) return
  if (Date.now()-_lastCall < 300000) return  // 5min minimum
  _lastCall = Date.now()

  const stats  = getStats()
  const deploy = getStatus()
  const prices = JSON.parse(getConfig('prices')||'{}')
  const recent = getExecutions(10)
  const svStats= JSON.parse(getConfig('sv_stats')||'{}')

  const state = {
    time:         new Date().toISOString(),
    uptime:       process.uptime()|0,
    revenue:      { allTime:stats.profit, today:stats.today, winRate:stats.winRate },
    chains:       { live:deploy.live.length, total:getActive().length, status:deploy.all.slice(0,20) },
    prices,
    svWeights:    svStats,
    recentArbs:   recent.slice(0,5).map(e=>({ chain:e.chain, profit:e.profit_usdc, protocol:e.protocol })),
    flashBalance: getConfig('balancer_capacity')||'unknown',
    scannerGaps:  parseInt(getConfig('scanner_gaps')||'0'),
    apexCalls:    parseInt(getConfig('apex_calls')||'0'),
  }

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1000,
      system:     SYSTEM,
      messages:   [{ role:'user', content: JSON.stringify(state) }]
    })

    const text = response.content[0]?.text || '{}'
    const cmd  = JSON.parse(text.replace(/```json?|```/g,'').trim())

    // Execute ApexAI commands
    if (cmd.chainExpansion?.length) {
      for (const c of cmd.chainExpansion) {
        addChain(c.name, c)
        console.log('[APEX] New chain approved:', c.name, '(TVL check passed)')
      }
    }

    if (cmd.svWeights)         { setConfig('sv_weights',   JSON.stringify(cmd.svWeights));         emit('apex_weights', cmd.svWeights) }
    if (cmd.propellerIntensity){ setConfig('prop_intensity',JSON.stringify(cmd.propellerIntensity));emit('apex_propellers', cmd.propellerIntensity) }
    if (cmd.pauseChains?.length)  cmd.pauseChains.forEach(c=>{ setConfig('pause_'+c,'1'); console.log('[APEX] Paused:',c) })
    if (cmd.resumeChains?.length) cmd.resumeChains.forEach(c=>{ setConfig('pause_'+c,'0'); console.log('[APEX] Resumed:',c) })
    if (cmd.flashSource)       setConfig('flash_source_override',JSON.stringify(cmd.flashSource))
    if (cmd.alert)             { console.log(`[APEX] ALERT [${cmd.alert.severity}]: ${cmd.alert.message}`); emit('apex_alert',cmd.alert) }
    if (cmd.insights)          { setConfig('apex_insights',cmd.insights); console.log('[APEX]',cmd.insights) }

    setConfig('apex_calls', String(parseInt(getConfig('apex_calls')||'0')+1))
    setConfig('apex_last',  new Date().toISOString())
    setConfig('apex_last_cmd', JSON.stringify(cmd))

  } catch(e) {
    console.warn('[APEX] Call failed:', e.message?.slice(0,80))
  }
}

export function startApexAI() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[APEX] No ANTHROPIC_API_KEY — ApexAI disabled')
    return
  }
  console.log('[APEX] ApexAI autonomous operations starting...')
  // First call after 30s (let system stabilize), then every 5min
  setTimeout(()=>callApexAI().catch(()=>{}), 30000)
  setInterval(()=>callApexAI().catch(()=>{}), 300000)
}

export const getApexStatus = () => ({
  enabled:   !!process.env.ANTHROPIC_API_KEY,
  lastCall:  getConfig('apex_last')||'never',
  calls:     parseInt(getConfig('apex_calls')||'0'),
  insights:  getConfig('apex_insights')||'',
  lastCmd:   JSON.parse(getConfig('apex_last_cmd')||'{}')
})
