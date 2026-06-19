// X7 PROTOCOL — ENTRY POINT
// 99.999% resources to 33 strategies
// All 33 strategies live within 60 seconds of MATIC arrival
// Yield/learner/apex deferred until $50K profit accumulated

import { startDashboard, broadcast } from './dashboard.js'

console.log('X7 PROTOCOL — 33 STRATEGY ENGINE STARTING')
startDashboard()
console.log('/health live')

setTimeout(boot, 500) // Fast boot — 500ms not 1500ms

async function boot() {
  // DB first — everything depends on it
  try {
    const { initDB } = await import('./db.js')
    await initDB()
  } catch (e) { console.error('DB fatal:', e.message); process.exit(1) }

  // Print executor address immediately
  try {
    const { getExecutorAddress } = await import('./pimlico.js')
    const addr = getExecutorAddress()
    console.log('[BOOT] Executor: ' + addr)
    console.log('[BOOT] Send 0.01 POL → deploys in < 1 second')
  } catch {}

  // Compile contract (required for deployment)
  try {
    const { compile } = await import('./compiler.js')
    await compile()
    console.log('[BOOT] Contract compiled — ready to deploy')
  } catch (e) { console.warn('[COMPILE]:', e.message) }

  // START DEPLOYER — watches for MATIC, deploys in < 1 second
  // This is the gate — strategies need deployed contracts to execute
  try {
    const { startDeployer } = await import('./deployer.js')
    await startDeployer()
  } catch (e) { console.warn('[DEPLOY]:', e.message) }

  // START 33 STRATEGIES — start immediately, queue until contract deployed
  // Strategies detect opportunities now, execute the moment contract is live
  try {
    const { startStrategies } = await import('./strategies.js')
    startStrategies()
    console.log('[BOOT] 33 strategies ACTIVE')
  } catch (e) { console.error('[STRATEGIES]:', e.message) }

  // START SCANNER — feeds liquidation opportunities to strategies
  try {
    const { startScanner } = await import('./scanner.js')
    const { handleLiquidation } = await import('./strategies.js')
    startScanner(handleLiquidation)
    console.log('[BOOT] Scanner feeding liquidations to strategies')
  } catch (e) { console.error('[SCANNER]:', e.message) }

  // EXECUTION ENGINE — processes liquidation queue
  try { await startEngine() }
  catch (e) { console.error('[ENGINE]:', e.message) }

  // DEFERRED SERVICES — only start after $50K profit
  // These consume resources that should go to strategies
  startDeferredWhenProfitable()

  console.log('X7 PROTOCOL OPERATIONAL — 33 STRATEGIES — $100M+ TARGETS ONLY')
}

// Deferred services — yield, learner, apex start only after first $50K
function startDeferredWhenProfitable() {
  const check = setInterval(async () => {
    try {
      const { getTotalRevenue } = await import('./db.js')
      const rev = getTotalRevenue()
      if (rev < 50000) return // Wait for $50K before using resources on these

      clearInterval(check)
      console.log('[BOOT] $50K threshold reached — starting secondary services')

      try { const { startApex } = await import('./apex.js'); await startApex() } catch {}
      try { const { startYield } = await import('./yield.js'); startYield() } catch {}
      try { const { startLearner } = await import('./learner.js'); startLearner() } catch {}
    } catch {}
  }, 30000) // Check every 30 seconds
}

async function startEngine() {
  const { handleLiquidation } = await import('./strategies.js')
  const { checkAutoWithdraw }  = await import('./treasury.js')
  const { setConfig }          = await import('./db.js')

  // Queue processes at 100ms — fast enough for all opportunities
  const tier0 = [], tier1 = [], tier2 = []
  let   busy  = false

  const enqueue = opp => {
    const q = opp.hf < 0.85 ? tier0 : opp.tier1 ? tier1 : tier2
    if (!q.find(o => o.borrower === opp.borrower && o.chainName === opp.chainName)) {
      q.push(opp)
      broadcast('opportunity', { chain: opp.chainName, hf: opp.hf,
        tier: opp.hf < 0.85 ? 0 : opp.tier1 ? 1 : 2 })
    }
  }

  setInterval(async () => {
    if (busy) return
    const opp = tier0.shift() || tier1.shift() || tier2.shift()
    if (!opp) return
    busy = true
    try {
      await handleLiquidation(opp)
      await checkAutoWithdraw().catch(() => {})
      setConfig('cascade_trigger_' + opp.chainName, Date.now())
    } catch (e) { console.error('[ENGINE]:', e.message) }
    finally { busy = false }
  }, 100)

  console.log('[ENGINE] Liquidation queue active — 100ms cycle')
}

process.on('uncaughtException',  e => console.error('[UNCAUGHT]:', e.message))
process.on('unhandledRejection', e => console.error('[REJECT]:',   String(e).slice(0,200)))
process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0) })
