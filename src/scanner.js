// X7-SV · scanner.js — cross-pool price gap detector
// Per-chain thresholds: ETH=0.15%/$500, L2s=0.01%/$2
// Sources: WebSocket Swap logs + mega_swap bridge + CEX price bridge
// Output: 'arb_opportunity' events → bootstrap.js

import { emit, on } from './events.js'
import { getConfig, setConfig } from './db.js'
import { getWS } from './rpc.js'
import { getMinProfit, getMinGap } from './deployer1a.js'

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// ── POOL PAIRS ────────────────────────────────────────────────────────────────
// Each pair: two pools tracking the same asset on the same chain
// Gap between them = arb opportunity
const PAIRS = [
  // Ethereum
  { chain:'ethereum', name:'ETH/USDC-E-A-B', asset:'weth', ft:'usdc',
    A:{ addr:'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee:500,  tvl:150e6, t0usdc:true  },
    B:{ addr:'0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', fee:3000, tvl:80e6,  t0usdc:true  } },
  { chain:'ethereum', name:'ETH/USDC-E-A-C', asset:'weth', ft:'usdc',
    A:{ addr:'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee:500,  tvl:150e6, t0usdc:true  },
    B:{ addr:'0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee:3000, tvl:60e6,  t0usdc:true  } },
  { chain:'ethereum', name:'ETH/USDT-E-A-B', asset:'weth', ft:'usdt',
    A:{ addr:'0x11b815efB8f581194ae79006d24E0d814B7697F6', fee:500,  tvl:90e6,  t0usdc:false },
    B:{ addr:'0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36', fee:3000, tvl:40e6,  t0usdc:false } },
  { chain:'ethereum', name:'WBTC/USDC-E-A-B', asset:'wbtc', ft:'usdc',
    A:{ addr:'0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35', fee:3000, tvl:60e6,  t0usdc:false },
    B:{ addr:'0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee:3000, tvl:60e6,  t0usdc:false } },
  // Arbitrum
  { chain:'arbitrum', name:'ETH/USDC-ARB-A-B', asset:'weth', ft:'usdc',
    A:{ addr:'0xC6962004f452bE9203591991D15f6b388e09E8D0', fee:500,  tvl:80e6,  t0usdc:true  },
    B:{ addr:'0x2f5e87C9312fa29aed5c179E456625D79015299c', fee:3000, tvl:30e6,  t0usdc:true  } },
  // Base
  { chain:'base', name:'ETH/USDC-BASE-A-B', asset:'weth', ft:'usdc',
    A:{ addr:'0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5', fee:500,  tvl:50e6,  t0usdc:true  },
    B:{ addr:'0xd0b53D9277642d899DF5C87A3966A349A798F224', fee:3000, tvl:20e6,  t0usdc:true  } },
  // Polygon ← NEW: covers the constant $1B+ swaps seen in logs
  { chain:'polygon', name:'ETH/USDC-POL-A-B', asset:'weth', ft:'usdc',
    A:{ addr:'0x45dDa9cb7c25131DF268515131f647d726f50608', fee:500,  tvl:30e6,  t0usdc:true  },
    B:{ addr:'0x50eaEDB835021E4A108B7290636d62E9765cc6d7', fee:3000, tvl:15e6,  t0usdc:true  } },
  // Optimism
  { chain:'optimism', name:'ETH/USDC-OP-A-B', asset:'weth', ft:'usdc',
    A:{ addr:'0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7', fee:500,  tvl:25e6,  t0usdc:true  },
    B:{ addr:'0x85149247691df622eaF1a8Bd0CaFd40BC45154a', fee:3000, tvl:10e6,  t0usdc:true  } },
]

// Token addresses per chain
const TOKENS = {
  ethereum:{ usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', usdt:'0xdAC17F958D2ee523a2206206994597C13D831ec7', weth:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', wbtc:'0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  arbitrum:{ usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  base:    { usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth:'0x4200000000000000000000000000000000000006' },
  polygon: { usdc:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', weth:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' },
  optimism:{ usdc:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', weth:'0x4200000000000000000000000000000000000006' },
}

// Build lookup maps
const BY_ADDR = new Map()
PAIRS.forEach(p => {
  BY_ADDR.set(p.A.addr.toLowerCase(), { pair:p, pool:p.A, isA:true  })
  BY_ADDR.set(p.B.addr.toLowerCase(), { pair:p, pool:p.B, isA:false })
})

const _prices  = new Map() // poolAddr → { price, ts }
const _lastEmit= new Map() // pairName → ts
let   _total   = 0

// ── PRICE DECODE ──────────────────────────────────────────────────────────────
function priceFromLog(log, t0usdc) {
  try {
    const d = (log.data||'').replace('0x','')
    if (d.length < 320) return null
    // sqrtPriceX96 at bytes 64-95 (hex chars 128-191)
    const sq = BigInt('0x'+d.slice(128,192))
    if (!sq) return null
    const f  = Number(sq) / 2**96
    const r  = f * f
    const p  = t0usdc ? (1/r)*1e12 : r*1e12
    return (p>100 && p<1e6) ? { price:p, ts:Date.now() } : null
  } catch { return null }
}

function priceFromAmounts(log, t0usdc) {
  try {
    const d    = (log.data||'').replace('0x','')
    if (d.length < 128) return null
    const HALF = 2n**255n, FULL = 2n**256n
    let a0 = BigInt('0x'+d.slice(0,64)),  a1 = BigInt('0x'+d.slice(64,128))
    if (a0>HALF) a0-=FULL;  if (a1>HALF) a1-=FULL
    a0 = a0<0n?-a0:a0;      a1 = a1<0n?-a1:a1
    if (!a0||!a1) return null
    const p = t0usdc ? (Number(a0)/1e6)/(Number(a1)/1e18) : (Number(a1)/1e6)/(Number(a0)/1e18)
    return (p>100 && p<1e6) ? { price:p, ts:Date.now() } : null
  } catch { return null }
}

// ── GAP EVALUATION ────────────────────────────────────────────────────────────
function evaluate(pair) {
  const pA = _prices.get(pair.A.addr.toLowerCase())
  const pB = _prices.get(pair.B.addr.toLowerCase())
  if (!pA||!pB) return

  const gap    = Math.abs(pA.price-pB.price)
  const gapPct = gap / Math.min(pA.price,pB.price) * 100
  setConfig('gap_'+pair.name, gapPct.toFixed(4))

  const minGap = getMinGap(pair.chain)
  if (gapPct < minGap) return

  // Size flash to 8% of smaller pool, capped at $20M
  const buyFromA  = pA.price < pB.price
  const buy = buyFromA ? pair.A : pair.B
  const sell= buyFromA ? pair.B : pair.A
  const flash= Math.min(Math.min(buy.tvl,sell.tvl)*0.08, 20e6)
  if (flash < 1e5) return

  // Profit after fees + slippage
  const cost   = (buy.fee/10000 + sell.fee/10000)*100 +
                 (flash/buy.tvl)*50 + (flash/sell.tvl)*50
  const profit = Math.floor(flash * Math.max(0, gapPct-cost) / 100)
  if (profit < getMinProfit(pair.chain)) return

  // Deduplicate
  const now = Date.now()
  if (now - (_lastEmit.get(pair.name)||0) < 3000) return
  _lastEmit.set(pair.name, now)

  _total++
  setConfig('scanner_gaps', String(_total))

  const T = TOKENS[pair.chain]||{}
  const opp = {
    chain:         pair.chain,
    pairName:      pair.name,
    flashToken:    T[pair.ft],
    flashAmountWei:BigInt(Math.floor(flash*1e6)),
    flashAmountUsdc:flash,
    poolBuy:       buy.addr,
    poolSell:      sell.addr,
    assetToken:    T[pair.asset],
    buyFee:        buy.fee,
    sellFee:       sell.fee,
    gapPct:        +gapPct.toFixed(4),
    buyPrice:      +(buyFromA?pA:pB).price.toFixed(2),
    sellPrice:     +(buyFromA?pB:pA).price.toFixed(2),
    estimatedProfit:profit,
    minBuyAmount:  BigInt(Math.floor((flash/((buyFromA?pA:pB).price))*0.985*1e18)),
    minSellUsdc:   BigInt(Math.floor((flash+profit*0.5)*1e6)),
    ts:            now
  }

  if (!opp.flashToken||!opp.assetToken) return

  console.log(`[SCANNER] ✓ ${pair.name} ${pair.chain}: ${gapPct.toFixed(3)}% flash=$${(flash/1e6).toFixed(1)}M profit~$${profit.toLocaleString()}`)
  emit('arb_opportunity', opp)
}

function updatePrice(addr, p) {
  if (!p) return
  _prices.set(addr.toLowerCase(), p)
  const e = BY_ADDR.get(addr.toLowerCase())
  if (e) evaluate(e.pair)
}

// ── WEBSOCKET SUBSCRIPTIONS ───────────────────────────────────────────────────
function watchPair(pair) {
  const ws = getWS(pair.chain)
  if (!ws) { setTimeout(()=>watchPair(pair), 30000); return }
  ;[pair.A,pair.B].forEach(pool =>
    ws.subscribe({ jsonrpc:'2.0', id:Math.random()*999999|0,
      method:'eth_subscribe', params:['logs',{ address:pool.addr, topics:[SWAP_TOPIC] }] })
  )
  ws.on('log', log => {
    if (log.topics?.[0]!==SWAP_TOPIC) return
    const addr = log.address?.toLowerCase()
    const e    = BY_ADDR.get(addr)
    if (!e) return
    updatePrice(addr, priceFromLog(log,e.pool.t0usdc) || priceFromAmounts(log,e.pool.t0usdc))
  })
}

// ── EVENT BRIDGES ─────────────────────────────────────────────────────────────
// Bridge 1: vaults.js mega_swap → price extraction
// Ensures scanner sees ALL swaps even before WebSocket handshake completes
on('mega_swap', ({ chain, log }) => {
  if (!log?.address) return
  const addr = log.address.toLowerCase()
  const e    = BY_ADDR.get(addr)
  if (!e) return
  updatePrice(addr, priceFromLog(log,e.pool.t0usdc) || priceFromAmounts(log,e.pool.t0usdc))
})

// Bridge 2: CEX price → compare against any known pool price
// Fires gap evaluation using CEX as virtual counterpart pool
on('cex_price', ({ symbol, price }) => {
  if (symbol!=='ETH'||!price) return
  PAIRS.filter(p=>p.asset==='weth').forEach(pair => {
    const pA = _prices.get(pair.A.addr.toLowerCase())
    const pB = _prices.get(pair.B.addr.toLowerCase())
    // Inject CEX price as synthetic for whichever pool lacks data
    if (pA && !pB) { _prices.set(pair.B.addr.toLowerCase(),{price,ts:Date.now()}); evaluate(pair); _prices.delete(pair.B.addr.toLowerCase()) }
    else if (pB && !pA) { _prices.set(pair.A.addr.toLowerCase(),{price,ts:Date.now()}); evaluate(pair); _prices.delete(pair.A.addr.toLowerCase()) }
    else if (pA && pB) evaluate(pair)
  })
})

// ── EXPORTS ───────────────────────────────────────────────────────────────────
export const getScannerStats = () => ({
  gapsDetected: _total, trackedPools: _prices.size,
  activePairs: PAIRS.length,
  gaps: PAIRS.map(p=>({ pair:p.name, chain:p.chain, gap:+( getConfig('gap_'+p.name)||0) }))
})

export function startScanner() {
  PAIRS.forEach(watchPair)
  setInterval(() => PAIRS.forEach(evaluate), 2000)  // periodic fallback
  console.log(`[SCANNER] ${PAIRS.length} pairs · 4 chains · L2 threshold 0.01% · ETH 0.15%`)
  console.log('[SCANNER] Sources: WebSocket + mega_swap bridge + CEX bridge')
   }
