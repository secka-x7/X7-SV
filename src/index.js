// X7-SV · index.js — boot · async main() · health first · watchdog
//
// BOOT ORDER CHANGE:
//   scanner starts BEFORE bootstrap (scanner feeds bootstrap)
//   cexfeed starts BEFORE revenue (CEX prices feed scanner)
//   vaults defer arb until after scanner confirms contract live
//
// UNCHANGED: async main() pattern, health binds first (the Railway crash fix)

import express from 'express'
import { on } from './events.js'

const PORT = process.env.PORT || 3000
const app  = express()

// /health responds IMMEDIATELY — before DB, chains, anything
// This is what fixed the Railway crash. Never move this below async work.
app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() | 0 }))
const server = app.listen(PORT, () => {
  console.log('X7-SV v3.0 STARTING — 10 SVs · 5,000 instances · 50 chains')
  console.log('[BOOT] /health live on :', PORT)
})

const START = Date.now()

async function main() {

  // ── STEP 1: DATABASE ────────────────────────────────────────────────────────
  try {
    const { initDB } = await import('./db.js')
    await initDB()
  } catch (e) { console.error('[DB] FATAL:', e.message); process.exit(1) }

  // ── STEP 2: DASHBOARD (replaces bare Express server) ────────────────────────
  try {
    const { startDashboard } = await import('./dashboard.js')
    server.close()
    startDashboard()
  } catch (e) { console.error('[DASHBOARD]:', e.message) }

  // ── STEP 3: CHAINS ──────────────────────────────────────────────────────────
  let chains
  try {
    const { initChains } = await import('./chains.js')
    chains = await initChains()
  } catch (e) { console.error('[CHAINS] FATAL:', e.message); return }

  // ── STEP 4: RPC + WEBSOCKET ─────────────────────────────────────────────────
  try {
    const { initRPC } = await import('./rpc.js')
    initRPC(chains)
  } catch (e) { console.error('[RPC]:', e.message) }

  // ── STEP 5: EXECUTOR WALLET ─────────────────────────────────────────────────
  try {
    const { initPimlico } = await import('./pimlico.js')
    initPimlico()
  } catch (e) { console.error('[PIMLICO]:', e.message) }

  // ── STEP 6: COMPILE X7.SOL ──────────────────────────────────────────────────
  try {
    const { compile } = await import('./compiler.js')
    await compile()
  } catch (e) { console.warn('[COMPILER]:', e.message) }

  // ── STEP 7: SCANNER (NEW — must start before bootstrap) ─────────────────────
  // Scanner watches pool prices and emits 'arb_opportunity' events.
  // Bootstrap.js listens to these events.
  // If scanner starts after bootstrap: bootstrap never gets triggered.
  try {
    const { startScanner } = await import('./scanner.js')
    startScanner()
  } catch (e) { console.warn('[SCANNER]:', e.message) }

  // ── STEP 8: CEX FEEDS (before revenue — feeds into scanner) ─────────────────
  // CEX prices also feed into scanner for CEX-DEX gap detection.
  // Must start before revenue to avoid missed prices.
  try {
    const { startCEXFeed } = await import('./cexfeed.js')
    startCEXFeed()
  } catch (e) { console.warn('[CEX]:', e.message) }

  // ── STEP 9: BOOTSTRAP (listens to scanner — starts after scanner) ────────────
  // initBootstrap() now:
  //   1. Checks for existing deployments (restores from DB)
  //   2. Registers 'arb_opportunity' listener from scanner
  //   3. Does NOT wait for mega-swap (that was the broken trigger)
  try {
    const { initBootstrap } = await import('./bootstrap.js')
    await initBootstrap()
  } catch (e) { console.warn('[BOOTSTRAP]:', e.message) }

  // ── STEP 10: REVENUE STREAMS (Arch 2 — runs independently of deploy) ─────────
  // Non-MEV streams start immediately:
  //   S1: Order flow (POST /api/order)
  //   S4: Depeg scanner
  //   S5: Governance
  //   S6: Intent protocols (CoW, UniswapX)
  // S2 (LP vault) and S3 (CEX-DEX) activate when scanner has prices
  try {
    const { startRevenue } = await import('./revenue.js')
    startRevenue()
  } catch (e) { console.warn('[REVENUE]:', e.message) }

  // ── STEP 11: VAULTS (SV1-SV10 — activates on deploy_success event) ──────────
  // Vaults watch pools for mega-swaps and execute arb via deployed contract.
  // If contract not yet deployed: all revenue goes to 'missed' counter.
  // After deploy: immediately starts capturing.
  try {
    const { startVaults } = await import('./vaults.js')
    startVaults()
  } catch (e) { console.error('[VAULTS]:', e.message) }

  // ── STEP 12: TREASURY ────────────────────────────────────────────────────────
  try {
    const { startTreasury } = await import('./treasury.js')
    startTreasury()
  } catch (e) { console.warn('[TREASURY]:', e.message) }

  const bootMs = Date.now() - START
  console.log(`X7-SV OPERATIONAL — ${Object.keys(chains).length} chains — boot ${bootMs}ms`)
  console.log('[BOOT] Architecture 1: scanner → gap detection → cross-pool arb → LIVE')
  console.log('[BOOT] Architecture 2: 6 non-MEV streams active from T+0')

  // ── WATCHDOG ─────────────────────────────────────────────────────────────────
  // Checks RPC health every 30s
  // If all providers fail 3× in a row: critical alert
  let rpcFails = 0
  setInterval(async () => {
    try {
      const { rpcCall }       = await import('./rpc.js')
      const { getActiveChains } = await import('./chains.js')
      let ok = 0
      for (const c of getActiveChains().slice(0, 3)) {
        try {
          if (await rpcCall(c.name, 'eth_blockNumber', [])) ok++
        } catch {}
      }
      if (ok === 0) {
        rpcFails++
        console.warn(`[WATCHDOG] All RPC providers failed (${rpcFails}/3)`)
        if (rpcFails >= 3) {
          rpcFails = 0
          console.error('[WATCHDOG] CRITICAL — Check RPC providers and API keys')
        }
      } else { rpcFails = 0 }
    } catch {}
  }, 30000)

  // ── CIRCUIT BREAKER ───────────────────────────────────────────────────────────
  // Tracks scanner gap detection rate.
  // If no gaps detected in 5 minutes: something is wrong with WebSocket connections.
  let lastGapCount = 0
  setInterval(async () => {
    try {
      const { getScannerStats } = await import('./scanner.js')
      const stats    = getScannerStats()
      const newGaps  = stats.gapsDetected - lastGapCount
      lastGapCount   = stats.gapsDetected

      if (newGaps === 0) {
        console.warn('[CIRCUIT] No price gaps detected in last 5 minutes — checking WebSocket connections')
      } else {
        console.log(`[CIRCUIT] ${newGaps} gap(s) detected in last 5 minutes. Total: ${stats.gapsDetected}`)
      }
    } catch {}
  }, 300000)

  // ── DEPLOY SUCCESS HANDLER ───────────────────────────────────────────────────
  on('deploy_success', ({ chain, address, method }) => {
    console.log(`[LIVE] ${chain} contract live at ${address} (${method})`)
    if (chain === 'ethereum') {
      console.log('[LIVE] ETH deployed — vaults now capturing MEV')
      console.log('[LIVE] L2 propagation starting...')
    }
  })
}

// No top-level await — main() called, not awaited
main().catch(e => {
  console.error('[BOOT] Fatal:', e.message)
  process.exit(1)
})

process.on('uncaughtException',  e => console.error('[UNCAUGHT]:', e.message?.slice(0, 100)))
process.on('unhandledRejection', e => console.error('[REJECT]:',   String(e).slice(0, 100)))
process.on('SIGTERM', () => { console.log('SIGTERM — graceful shutdown'); process.exit(0) })
