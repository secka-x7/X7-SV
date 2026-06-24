// X7-SV · treasury.js — USDC tracking · LP vault · Modem Pay Wave withdrawal

import { getConfig, setConfig, recordWithdrawal } from './db.js'
import { getActiveChains, getChain } from './chains.js'
import { rpcCall } from './rpc.js'
import { getExecutorAddress } from './pimlico.js'

export async function getUSDCBalance(chainName) {
  const chain = getChain(chainName)
  const exec  = getExecutorAddress()
  if (!chain?.usdc || !exec) return 0
  try {
    const hex = await rpcCall(chainName, 'eth_call', [{
      to:   chain.usdc,
      data: '0x70a08231' + exec.slice(2).padStart(64,'0')
    }, 'latest'])
    return Number(BigInt(hex||'0x0')) / 1e6
  } catch { return 0 }
}

export async function getAllBalances() {
  const balances = {}
  const exec = getExecutorAddress()
  if (!exec) return balances
  await Promise.allSettled(getActiveChains().map(async c => {
    try {
      const hex = await rpcCall(c.name, 'eth_getBalance', [exec, 'latest'])
      balances[c.name] = (Number(BigInt(hex||'0x0'))/1e18).toFixed(8)
    } catch { balances[c.name] = '0' }
  }))
  return balances
}

export async function withdraw(amountUSDC) {
  if (!amountUSDC || amountUSDC <= 0) throw new Error('Invalid amount')
  const key  = process.env.MODEM_PAY_SECRET_KEY
  const wave = process.env.MODEM_PAY_WAVE_NUMBER
  if (!key || !wave) throw new Error('MODEM_PAY credentials not configured')

  const r = await fetch('https://api.modempay.com/v1/transfer', {
    method:  'POST',
    headers: { 'Authorization':'Bearer '+key, 'Content-Type':'application/json' },
    body:    JSON.stringify({ amount:amountUSDC, currency:'USDC', recipient:wave, network:'wave' }),
    signal:  AbortSignal.timeout(30000)
  })

  if (!r.ok) throw new Error('Modem Pay error: ' + r.status)
  const d   = await r.json()
  const gmd = amountUSDC * 570

  recordWithdrawal({ usdcAmount:amountUSDC, gmdAmount:gmd, txId:d.id||'pending', status:'completed' })
  setConfig('last_withdrawal', JSON.stringify({ amount:amountUSDC, ts:Date.now() }))
  console.log(`[TREASURY] $${amountUSDC} USDC → ${gmd.toFixed(0)} GMD via Wave`)
  return { success:true, gmd, txId:d.id }
}

export function startTreasury() {
  console.log('[TREASURY] USDC sweep · LP vault · Modem Pay active')

  // Auto-withdraw 30% when threshold crossed
  setInterval(async () => {
    if (getConfig('auto_withdraw') !== 'true') return
    const threshold = parseFloat(getConfig('auto_withdraw_threshold')||'500')
    const total     = parseFloat(getConfig('sv_total')||'0')
    const lastWD    = JSON.parse(getConfig('last_withdrawal')||'{"amount":0}')
    const earned    = total - (lastWD.amount||0)
    if (earned >= threshold) {
      withdraw(earned * 0.3).catch(e => console.error('[TREASURY] Auto-withdraw:', e.message))
    }
  }, 60000)
}
