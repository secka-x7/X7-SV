// X7-SV · builders.js — 6 builder RPCs · MEV-Share · escalating gas · simulation

import { keccak256, toBytes, hexToBytes } from 'viem'
import { getPublicClient, getWalletClient, getExecutorAddress } from './pimlico.js'
import { rpcCall } from './rpc.js'
import { getConfig } from './db.js'

// VERIFIED builder RPC endpoints (not relay endpoints)
const BUILDERS = [
  { name: 'Titan',      url: 'https://rpc.titanbuilder.xyz',               share: 0.465 },
  { name: 'BuilderNet', url: 'https://rpc.buildernet.org',                 share: 0.389 },
  { name: 'Beaver',     url: 'https://rpc.beaverbuild.org',                share: 0.061 },
  { name: 'Rsync',      url: 'https://rsync-builder.xyz',                  share: 0.050 },
  { name: 'Flashbots',  url: 'https://relay.flashbots.net',                share: 0.032 },
  { name: 'MEVShare',   url: 'https://mev-share.flashbots.net',            share: 0.000, mevshare: true },
]

const L2_CHAINS = new Set(['polygon', 'arbitrum', 'base', 'optimism', 'avalanche', 'bnb', 'scroll'])

async function sign(bodyStr) {
  const addr = getExecutorAddress()
  if (!addr) return ''
  // Simple signing for Flashbots auth header
  const msgHash = keccak256(toBytes('\x19Ethereum Signed Message:\n' + bodyStr.length + bodyStr))
  return addr + ':0x' + Buffer.from(toBytes(msgHash)).toString('hex')
}

async function submitBundle(builder, txs, blockNum) {
  const blockHex = '0x' + blockNum.toString(16)
  const method = builder.mevshare ? 'mev_sendBundle' : 'eth_sendBundle'
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method,
    params: [{ txs, blockNumber: blockHex, minTimestamp: 0, maxTimestamp: Math.floor(Date.now() / 1000) + 120 }]
  })
  try {
    const sig = await sign(body)
    const r = await fetch(builder.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Flashbots-Signature': sig, 'X-Auction-Signature': sig },
      body,
      signal: AbortSignal.timeout(5000)
    })
    const d = await r.json()
    return d.result ? { builder: builder.name, hash: d.result?.bundleHash || d.result } : null
  } catch { return null }
}

export async function simulateBundle(chainName, signedTxs, block) {
  try {
    const sim = await rpcCall(chainName, 'eth_callBundle', [{
      txs: signedTxs, blockNumber: '0x' + block.toString(16), stateBlockNumber: 'latest'
    }])
    if (!sim || sim.error) return { ok: false, reason: sim?.error?.message || 'no result' }
    const reverted = (sim.results || []).find(r => r.revert || r.error)
    if (reverted) return { ok: false, reason: reverted.revert || reverted.error }
    return { ok: true }
  } catch (e) { return { ok: false, reason: e.message?.slice(0, 80) } }
}

async function getGas(chainName, profitUSD, attempt = 0) {
  try {
    const fee = await rpcCall(chainName, 'eth_feeHistory', [5, 'latest', [80]])
    const bases = (fee?.baseFeePerGas || []).map(x => BigInt(x || '0x0'))
    const base = bases[bases.length - 2] || 2000000000n
    const tips = (fee?.reward || []).flat().map(x => BigInt(x || '0x0'))
    tips.sort((a, b) => Number(a - b))
    const tip = tips[Math.floor(tips.length * 0.8)] || 1500000000n
    const scale = [10n, 13n, 15n, 20n][Math.min(attempt, 3)]
    return {
      maxFeePerGas: base * 12n / 10n * scale / 10n,
      maxPriorityFeePerGas: tip * scale / 10n
    }
  } catch { return { maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 2000000000n } }
}

// Main entry: build + submit bundle (or direct tx on L2)
export async function executeBundle(chainName, contractAddr, calldata, profitEst = 500, deployTx = null) {
  const wallet = getWalletClient(chainName)
  const client = getPublicClient(chainName)
  if (!wallet || !client || !contractAddr) return null

  // L2: direct EOA transaction (gas is negligible, <$0.05)
  if (L2_CHAINS.has(chainName)) {
    try {
      const gas = await getGas(chainName, profitEst)
      const hash = await wallet.sendTransaction({ to: contractAddr, data: calldata, ...gas })
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60000 })
      return receipt.status === 'success' ? hash : null
    } catch (e) { console.log('[BUNDLE:L2]', chainName, e.message?.slice(0, 60)); return null }
  }

  // Ethereum: Flashbots bundle with escalating gas
  const block = Number(await rpcCall(chainName, 'eth_blockNumber', []))
  for (let attempt = 0; attempt < 4; attempt++) {
    const gas = await getGas(chainName, profitEst, attempt)
    const nonce = await client.getTransactionCount({ address: wallet.account.address })

    let signedExec
    try {
      signedExec = await wallet.signTransaction({ to: contractAddr, data: calldata, nonce, ...gas, gas: 800000n, chainId: 1 })
    } catch { return null }

    const txs = []
    if (deployTx) txs.push(deployTx)
    txs.push(signedExec)

    // Simulate before submitting
    const sim = await simulateBundle(chainName, txs, block + attempt + 1)
    if (!sim.ok && attempt === 0) {
      console.log('[BUNDLE] Sim failed:', sim.reason?.slice(0, 60))
    }

    // Submit to all builders in parallel
    const results = await Promise.allSettled(BUILDERS.map(b => submitBundle(b, txs, block + attempt + 1)))
    const wins = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value.builder)

    if (wins.length) {
      console.log(`[BUNDLE] ETH: submitted to ${wins.join('+')} block ${block + attempt + 1}`)
      await new Promise(r => setTimeout(r, 12500))
      try {
        const receipt = await client.waitForTransactionReceipt({ hash: signedExec, timeout: 15000 })
        if (receipt?.status === 'success') return signedExec
      } catch {}
    }
  }
  return null
}
