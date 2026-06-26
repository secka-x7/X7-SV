// X7-SV · scanner.js — cross-pool gap detector (secondary trigger)
// Primary trigger is now mega_swap in bootstrap.js (no price decode needed)
// Scanner provides more precise parameters when WebSocket prices available
// Removed circuit breaker — was just noise, not actionable

import { emit, on } from './events.js'
import { getConfig, setConfig } from './db.js'
import { getWS } from './rpc.js'
import { getMinProfit, getMinGap } from './deployer1a.js'

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

const PAIRS = [
  { chain:'ethereum', name:'ETH/USDC-E-A-B', asset:'weth', ft:'usdc',
    A:{addr:'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',fee:500, tvl:150e6,t0u:true},
    B:{addr:'0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',fee:3000,tvl:80e6, t0u:true}},
  { chain:'ethereum', name:'ETH/USDC-E-A-C', asset:'weth', ft:'usdc',
    A:{addr:'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',fee:500, tvl:150e6,t0u:true},
    B:{addr:'0x4585FE77225b41b697C938B018E2ac67Ac5a20c0',fee:3000,tvl:60e6, t0u:true}},
  { chain:'arbitrum', name:'ETH/USDC-ARB',   asset:'weth', ft:'usdc',
    A:{addr:'0xC6962004f452bE9203591991D15f6b388e09E8D0',fee:500, tvl:80e6, t0u:true},
    B:{addr:'0x2f5e87C9312fa29aed5c179E456625D79015299c',fee:3000,tvl:30e6, t0u:true}},
  { chain:'base',     name:'ETH/USDC-BASE',  asset:'weth', ft:'usdc',
    A:{addr:'0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5',fee:500, tvl:50e6, t0u:true},
    B:{addr:'0xd0b53D9277642d899DF5C87A3966A349A798F224',fee:3000,tvl:20e6, t0u:true}},
  { chain:'polygon',  name:'ETH/USDC-POL',   asset:'weth', ft:'usdc',
    A:{addr:'0x45dDa9cb7c25131DF268515131f647d726f50608',fee:500, tvl:30e6, t0u:true},
    B:{addr:'0x50eaEDB835021E4A108B7290636d62E9765cc6d7',fee:3000,tvl:15e6, t0u:true}},
]

const TOKENS = {
  ethereum:{ usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', weth:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  arbitrum:{ usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  base:    { usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth:'0x4200000000000000000000000000000000000006' },
  polygon: { usdc:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', weth:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' },
}

const BY_ADDR = new Map()
PAIRS.forEach(p=>{
  BY_ADDR.set(p.A.addr.toLowerCase(),{pair:p,pool:p.A})
  BY_ADDR.set(p.B.addr.toLowerCase(),{pair:p,pool:p.B})
})

const _prices   = new Map()
const _lastEmit = new Map()
let   _total    = 0

function price(log, t0u) {
  try {
    const d = (log.data||'').replace('0x','')
    if (d.length<320) return null
    const sq = BigInt('0x'+d.slice(128,192))
    if (!sq) return null
    const f = Number(sq)/2**96, r = f*f
    const p = t0u?(1/r)*1e12:r*1e12
    if (p<100||p>1e6) return null
    return { price:p, ts:Date.now() }
  } catch {
    // Fallback: amounts
    try {
      const d = (log.data||'').replace('0x','')
      if (d.length<128) return null
      const H=2n**255n,F=2n**256n
      let a0=BigInt('0x'+d.slice(0,64)), a1=BigInt('0x'+d.slice(64,128))
      if(a0>H)a0-=F; if(a1>H)a1-=F
      a0=a0<0n?-a0:a0; a1=a1<0n?-a1:a1
      if(!a0||!a1) return null
      const p = t0u?(Number(a0)/1e6)/(Number(a1)/1e18):(Number(a1)/1e6)/(Number(a0)/1e18)
      return (p>100&&p<1e6)?{price:p,ts:Date.now()}:null
    } catch { return null }
  }
}

function evaluate(pair) {
  const pA=_prices.get(pair.A.addr.toLowerCase())
  const pB=_prices.get(pair.B.addr.toLowerCase())
  if (!pA||!pB) return
  const gap = Math.abs(pA.price-pB.price)/Math.min(pA.price,pB.price)*100
  setConfig('gap_'+pair.name, gap.toFixed(4))
  if (gap < getMinGap(pair.chain)) return

  const buyA    = pA.price<pB.price
  const buy     = buyA?pair.A:pair.B
  const sell    = buyA?pair.B:pair.A
  const flash   = Math.min(Math.min(buy.tvl,sell.tvl)*0.08, 20e6)
  if (flash<1e5) return

  const cost   = (buy.fee/10000+sell.fee/10000)*100+(flash/buy.tvl)*50+(flash/sell.tvl)*50
  const profit = Math.floor(flash*Math.max(0,gap-cost)/100)
  if (profit < getMinProfit(pair.chain)) return

  const now = Date.now()
  if (now-(_lastEmit.get(pair.name)||0) < 3000) return
  _lastEmit.set(pair.name, now)
  _total++
  setConfig('scanner_gaps', String(_total))

  const T  = TOKENS[pair.chain]||{}
  const bp = (buyA?pA:pB).price

  const opp = {
    chain:pair.chain, pairName:pair.name,
    flashToken:T[pair.ft], assetToken:T[pair.asset],
    flashAmountWei:BigInt(Math.floor(flash*1e6)), flashAmountUsdc:flash,
    poolBuy:buy.addr, poolSell:sell.addr,
    buyFee:buy.fee, sellFee:sell.fee,
    gapPct:+gap.toFixed(4), estimatedProfit:profit,
    minBuyAmount:BigInt(Math.floor((flash/bp)*0.985*1e18)),
    minSellUsdc: BigInt(Math.floor((flash+profit*0.5)*1e6)),
    ts:now
  }
  if (!opp.flashToken||!opp.assetToken) return
  console.log(`[SCANNER] ✓ ${pair.name}: ${gap.toFixed(3)}% flash=$${(flash/1e6).toFixed(1)}M profit~$${profit.toLocaleString()}`)
  emit('arb_opportunity', opp)
}

export const getScannerStats = () => ({
  gapsDetected:_total, trackedPools:_prices.size, activePairs:PAIRS.length,
  gaps:PAIRS.map(p=>({pair:p.name,chain:p.chain,gap:+(getConfig('gap_'+p.name)||0)}))
})

export function startScanner() {
  // WebSocket subscriptions
  PAIRS.forEach(pair=>{
    const ws=getWS(pair.chain)
    if(!ws){setTimeout(()=>startScanner(),30000);return}
    ;[pair.A,pair.B].forEach(pool=>
      ws.subscribe({jsonrpc:'2.0',id:Math.random()*999999|0,
        method:'eth_subscribe',params:['logs',{address:pool.addr,topics:[SWAP_TOPIC]}]})
    )
    ws.on('log',log=>{
      if(log.topics?.[0]!==SWAP_TOPIC)return
      const addr=log.address?.toLowerCase()
      const e=BY_ADDR.get(addr)
      if(!e)return
      const p=price(log,e.pool.t0u)
      if(!p)return
      _prices.set(addr,p)
      evaluate(e.pair)
    })
  })

  // mega_swap bridge: extract price from log passed by vaults.js
  on('mega_swap',({log,poolAddr})=>{
    if(!log||!poolAddr)return
    const addr=poolAddr.toLowerCase()
    const e=BY_ADDR.get(addr)
    if(!e)return
    const p=price(log,e.pool.t0u)
    if(p){ _prices.set(addr,p); evaluate(e.pair) }
  })

  // CEX bridge: synthetic price for unpopulated pool
  on('cex_price',({symbol,price:cexP})=>{
    if(symbol!=='ETH'||!cexP)return
    PAIRS.filter(p=>p.asset==='weth').forEach(pair=>{
      const pA=_prices.get(pair.A.addr.toLowerCase())
      const pB=_prices.get(pair.B.addr.toLowerCase())
      const syn={price:cexP,ts:Date.now()}
      if(pA&&!pB){_prices.set(pair.B.addr.toLowerCase(),syn);evaluate(pair);_prices.delete(pair.B.addr.toLowerCase())}
      else if(pB&&!pA){_prices.set(pair.A.addr.toLowerCase(),syn);evaluate(pair);_prices.delete(pair.A.addr.toLowerCase())}
      else if(pA&&pB) evaluate(pair)
    })
  })

  setInterval(()=>PAIRS.forEach(evaluate), 2000)

  console.log(`[SCANNER] ${PAIRS.length} pairs · 5 chains · secondary trigger`)
  console.log('[SCANNER] Primary trigger: mega_swap → bootstrap.js (no price needed)')
      }
