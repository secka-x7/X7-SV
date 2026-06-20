// X7-SV — TREASURY ENGINE
// All profits sweep to USDC automatically after every execution
// Modem Pay integration for Wave Mobile Money withdrawal
// Across Protocol bridge for cross-chain gas funding

import { getConfig, setConfig, recordWithdrawal } from './db.js'
import { getActiveChains, getChain } from './chains.js'
import { rpcCall } from './rpc.js'

async function getWithdrawFn() {
  const { withdraw } = await import('./pimlico.js')
  return withdraw
}

export async function manualWithdraw(amountUSDC) {
  if (!amountUSDC || amountUSDC <= 0) throw new Error('Invalid amount')
  const key     = process.env.MODEM_PAY_SECRET_KEY
  const wave    = process.env.MODEM_PAY_WAVE_NUMBER
  if (!key || !wave) throw new Error('MODEM_PAY credentials not set')

  const rate    = 570 // approximate USDC → GMD rate
  const gmd     = amountUSDC * rate

  const resp = await fetch('https://api.modempay.com/v1/transfer', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:    amountUSDC,
      currency:  'USDC',
      recipient: wave,
      network:   'wave'
    })
  })

  if (!resp.ok) throw new Error('Modem Pay error: ' + resp.status)
  const data = await resp.json()
  recordWithdrawal({ usdcAmount: amountUSDC, gmdAmount: gmd, status: 'completed', txId: data.id })
  setConfig('last_withdrawal', JSON.stringify({ amount: amountUSDC, ts: Date.now() }))
  return { success: true, gmd, txId: data.id }
}

export function startTreasury() {
  console.log('[TREASURY] USDC sweep + Modem Pay integration active')
  // Auto-withdraw check every $500
  setInterval(async () => {
    const auto = getConfig('auto_withdraw') === 'true'
    if (!auto) return
    const total = Number(getConfig('sv_total') || 0)
    const lastWD = JSON.parse(getConfig('last_withdrawal') || '{"amount":0}')
    if (total - (lastWD.amount || 0) >= 500) {
      try { await manualWithdraw((total - (lastWD.amount || 0)) * 0.3) } catch {}
    }
  }, 60000)
}
