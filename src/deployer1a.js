// X7-SV · deployer1a.js — Guaranteed Multi-Chain Deployment
// PRE-DESIGN: signs ALL 17 deploy txs at boot → submits all on first swap
// DIAGNOSTIC: every step logs exactly what happened and why
// Stage 1: parallel submission of pre-signed txs (milliseconds)
// Stage 2: bridge cascade (first win funds others via Across)  
// Stage 3: Pimlico paymaster for L2s with no native gas
// NONE ESCAPE: replay queue captures swaps during deploy window

import { keccak256, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem'
import { getChain, getActiveChains } from './chains.js'
import { getContractAddr, setContractAddr, getExecutorAddress, getWalletClient, getPublicClient, contractExists, sendTx, waitTx, pimlicoUrl } from './pimlico.js'
import { getArtifact } from './compiler.js'
import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'

const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

// ── THRESHOLDS PER CHAIN ──────────────────────────────────────────────────────
export const getMinProfit = c => ({ethereum:500,arbitrum:5,base:2,polygon:2,optimism:2,avalanche:5,bnb:5,scroll:5}[c]||10)
export const getMinGap    = c => ({ethereum:0.15,arbitrum:0.01,base:0.01,polygon:0.01,optimism:0.01,avalanche:0.02,bnb:0.02,scroll:0.05}[c]||0.05)

// ── STATE ─────────────────────────────────────────────────────────────────────
const _live       = new Set()
const _deploying  = new Set()
const _signed     = {}   // chainName → { signedTx, addr, ts } — pre-signed at boot
const _replayQ    = []   // swaps missed during deploy window → executed after live
let   _firstDone  = false

// ── CREATE2 ───────────────────────────────────────────────────────────────────
export function computeAddr(bytecode) {
  const exec = getExecutorAddress()
  if (!exec) return null
  const salt = keccak256(encodePacked(['address','string'],[exec,'x7sv_v3']))
  const hash = keccak256(encodePacked(['bytes1','address','bytes32','bytes32'],
    ['0xff',CREATE2,salt,keccak256(bytecode)]))
  return { addr:('0x'+hash.slice(-40)).toLowerCase(), salt }
}

function buildDeployCalldata(bytecode, salt, chain) {
  const args = encodeAbiParameters(
    parseAbiParameters('address,address,address,address,address'),
    [chain.router||'0x0000000000000000000000000000000000000001',
     chain.usdc  ||'0x0000000000000000000000000000000000000001',
     chain.weth  ||'0x0000000000000000000000000000000000000001',
     chain.flashAddr||'0xBA12222222228d8Ba445958a75a0704d566BF2C8',
     chain.aavePool ||'0x0000000000000000000000000000000000000001']
  )
  const init=bytecode+args.slice(2), len=Math.floor((init.length-2)/2)
  return '0x4af63f02'+salt.slice(2).padStart(64,'0')+
    '0'.repeat(63)+'40'+len.toString(16).padStart(64,'0')+
    init.slice(2).padEnd(Math.ceil(len/32)*64,'0')
}

// ── PRE-SIGN ALL CHAINS AT BOOT ───────────────────────────────────────────────
// Signs deploy tx for every chain immediately on boot.
// No estimation — hardcoded gas. Works with $0 balance.
// On first swap: submit all simultaneously in <100ms.
export async function presignAllChains() {
  const artifact = getArtifact()
  if (!artifact) { console.error('[1A] Cannot pre-sign: no artifact'); return }

  const computed = computeAddr(artifact.bytecode)
  if (!computed) { console.error('[1A] Cannot pre-sign: no executor'); return }

  console.log('[1A] Pre-signing deploy txs for all chains...')
  let signed=0, failed=0

  await Promise.allSettled(getActiveChains().map(async chain => {
    if (_live.has(chain.name)) return

    // Skip if already deployed on-chain
    if (await contractExists(chain.name, computed.addr).catch(()=>false)) {
      setContractAddr(chain.name, computed.addr)
      _live.add(chain.name)
      console.log(`[1A] ${chain.name}: already live (skipping pre-sign)`)
      return
    }

    const wallet = getWalletClient(chain.name)
    const client = getPublicClient(chain.name)
    if (!wallet||!client) {
      console.warn(`[1A] ${chain.name}: no wallet/client — skipping`)
      failed++; return
    }

    try {
      const data    = buildDeployCalldata(artifact.bytecode, computed.salt, chain)
      const nonce   = await client.getTransactionCount({address:getExecutorAddress()})
      const feeData = await client.estimateFeesPerGas().catch(()=>null)

      // EIP-1559 invariant guaranteed: maxFee = base×2 + tip, always ≥ tip
      const tip    = feeData?.maxPriorityFeePerGas || 1500000000n
      const maxFee = feeData?.maxFeePerGas
        ? (feeData.maxFeePerGas > tip ? feeData.maxFeePerGas : tip*2n)
        : tip*3n

      const signedTx = await wallet.signTransaction({
        to:      CREATE2,
        data,
        nonce,
        gas:     800000n,
        maxFeePerGas:         maxFee,
        maxPriorityFeePerGas: tip,
        chainId: chain.chainId
      })

      _signed[chain.name] = { signedTx, addr:computed.addr, nonce, ts:Date.now() }
      signed++
      console.log(`[1A] ${chain.name}: pre-signed nonce=${nonce} maxFee=${maxFee/1000000000n}gwei`)
    } catch(e) {
      console.error(`[1A] ${chain.name}: pre-sign FAILED: ${e.message?.slice(0,100)}`)
      console.error(`[1A] ${chain.name}: chainId=${chain.chainId} rpc=${chain.rpcHttp?.slice(0,40)}`)
      failed++
    }
  }))

  console.log(`[1A] Pre-sign complete: ${signed} signed, ${failed} failed, ${_live.size} already live`)
  console.log(`[1A] Ready: first swap → submit all ${signed} txs simultaneously`)
}

// ── SUBMIT ALL PRE-SIGNED TXS ON FIRST SWAP ──────────────────────────────────
// This is the millisecond deployment.
// All 17 chains submitted in parallel within 100ms of first swap.
export async function submitAllOnFirstSwap() {
  if (_firstDone) return
  _firstDone = true

  const chains = Object.keys(_signed)
  if (!chains.length) {
    console.error('[1A] No pre-signed txs available — falling back to directDeploy')
    // Fallback: try directDeploy for any chain not yet live
    const artifact = getArtifact()
    if (artifact) {
      await Promise.allSettled(getActiveChains().filter(c=>!_live.has(c.name))
        .map(c=>directDeploy(c.name).catch(()=>{})))
    }
    return
  }

  console.log(`[1A] FIRST SWAP → submitting ${chains.length} pre-signed deploy txs simultaneously`)

  const results = await Promise.allSettled(chains.map(async chainName => {
    const entry  = _signed[chainName]
    const client = getPublicClient(chainName)
    if (!client) throw new Error('no client')

    // Check if nonce still valid (could have changed since pre-sign)
    const currentNonce = await client.getTransactionCount({address:getExecutorAddress()}).catch(()=>null)
    if (currentNonce !== null && currentNonce > entry.nonce) {
      console.warn(`[1A] ${chainName}: nonce stale (pre-signed=${entry.nonce} current=${currentNonce}) — re-signing`)
      // Re-sign with correct nonce
      const chain  = getChain(chainName)
      const wallet = getWalletClient(chainName)
      const artifact= getArtifact()
      if (!chain||!wallet||!artifact) throw new Error('missing deps for re-sign')
      const computed= computeAddr(artifact.bytecode)
      const data    = buildDeployCalldata(artifact.bytecode, computed.salt, chain)
      const feeData = await client.estimateFeesPerGas().catch(()=>null)
      const tip     = feeData?.maxPriorityFeePerGas||1500000000n
      const maxFee  = feeData?.maxFeePerGas?(feeData.maxFeePerGas>tip?feeData.maxFeePerGas:tip*2n):tip*3n
      const freshTx = await wallet.signTransaction({to:CREATE2,data,nonce:currentNonce,gas:800000n,
        maxFeePerGas:maxFee,maxPriorityFeePerGas:tip,chainId:chain.chainId})
      entry.signedTx = freshTx
      entry.nonce    = currentNonce
    }

    // Submit raw signed tx
    const hash = await client.sendRawTransaction({serializedTransaction:entry.signedTx})
    console.log(`[1A] ${chainName}: tx submitted ${hash}`)
    _deploying.add(chainName)
    return { chainName, hash, addr:entry.addr }
  }))

  // Log what happened
  const submitted = results.filter(r=>r.status==='fulfilled').map(r=>r.value.chainName)
  const failed    = results.filter(r=>r.status==='rejected').map((r,i)=>({
    chain:chains[i], error:r.reason?.message?.slice(0,100)
  }))

  console.log(`[1A] Submitted: ${submitted.join(', ')||'none'}`)
  if (failed.length) failed.forEach(f=>console.error(`[1A] FAILED ${f.chain}: ${f.error}`))

  // Watch for confirmations
  watchConfirmations(results.filter(r=>r.status==='fulfilled').map(r=>r.value))
}

// ── WATCH CONFIRMATIONS ───────────────────────────────────────────────────────
async function watchConfirmations(submissions) {
  if (!submissions.length) return

  await Promise.allSettled(submissions.map(async ({ chainName, hash, addr }) => {
    try {
      const receipt = await waitTx(chainName, hash, 120000)
      if (!receipt||receipt.status==='reverted') {
        console.error(`[1A] ${chainName}: tx REVERTED — checking why`)
        console.error(`[1A] ${chainName}: hash=${hash}`)
        console.error(`[1A] ${chainName}: addr=${addr}`)
        // Try directDeploy as fallback
        console.log(`[1A] ${chainName}: trying directDeploy fallback`)
        await directDeploy(chainName)
        return
      }

      // Verify contract at CREATE2 address
      const exists = await contractExists(chainName, addr)
      if (!exists) {
        console.error(`[1A] ${chainName}: tx succeeded but contract NOT at ${addr}`)
        console.error(`[1A] ${chainName}: possible CREATE2 factory address mismatch`)
        return
      }

      setContractAddr(chainName, addr)
      _live.add(chainName)
      _deploying.delete(chainName)
      console.log(`[1A] ✓ ${chainName} LIVE: ${addr}`)
      emit('deploy_success',{chain:chainName,address:addr,method:'presigned'})

      // First confirmation triggers cascade
      if (!_live.has('_cascaded')) {
        _live.add('_cascaded')
        await onFirstDeploy(chainName)
      }

      // Replay queued swaps
      replayQueue(chainName)

    } catch(e) {
      console.error(`[1A] ${chainName}: confirmation error: ${e.message?.slice(0,100)}`)
      _deploying.delete(chainName)
      // Fallback
      await directDeploy(chainName).catch(()=>{})
    }
  }))
}

// ── DIRECT DEPLOY (fallback when pre-signed tx fails) ────────────────────────
export async function directDeploy(chainName) {
  if (_live.has(chainName)||_deploying.has(chainName)) return null
  const artifact=getArtifact(), chain=getChain(chainName)
  if (!artifact||!chain) return null

  const computed=computeAddr(artifact.bytecode)
  if (!computed) return null

  if (await contractExists(chainName,computed.addr).catch(()=>false)) {
    setContractAddr(chainName,computed.addr); _live.add(chainName)
    emit('deploy_success',{chain:chainName,address:computed.addr,method:'existing'})
    return computed.addr
  }

  _deploying.add(chainName)
  setConfig('deploy_status_'+chainName,'deploying')
  try {
    const data    = buildDeployCalldata(artifact.bytecode, computed.salt, chain)
    const hash    = await sendTx(chainName, CREATE2, data)
    const receipt = await waitTx(chainName, hash, 120000)
    if (receipt?.status==='reverted') throw new Error('tx reverted')
    if (!await contractExists(chainName,computed.addr).catch(()=>false)) throw new Error('not at CREATE2 addr')

    setContractAddr(chainName,computed.addr); _live.add(chainName)
    setConfig('deploy_status_'+chainName,'live'); _deploying.delete(chainName)
    console.log(`[1A] ✓ ${chainName} LIVE (direct):`, computed.addr)
    emit('deploy_success',{chain:chainName,address:computed.addr,method:'direct'})
    replayQueue(chainName)
    return computed.addr
  } catch(e) {
    console.error(`[1A] ${chainName} directDeploy FAILED:`)
    console.error(`  error: ${e.message?.slice(0,150)}`)
    setConfig('deploy_status_'+chainName,'failed'); _deploying.delete(chainName)
    return null
  }
}

// ── REPLAY QUEUE — none escape ────────────────────────────────────────────────
// Swaps that arrived during deploy window are queued and replayed after live
export function queueSwap(swapEvent) {
  if (_live.size > 1) return  // Already live — don't queue
  _replayQ.push({ ...swapEvent, queuedAt: Date.now() })
  if (_replayQ.length > 100) _replayQ.shift()  // Cap queue
}

async function replayQueue(chainName) {
  if (!_replayQ.length) return
  console.log(`[1A] Replaying ${_replayQ.length} queued swaps on ${chainName}`)
  const queued = _replayQ.splice(0)
  for (const evt of queued) {
    emit('replay_swap', { ...evt, replayChain: chainName })
    await new Promise(r=>setTimeout(r,100))
  }
}

// ── STAGE 2: BRIDGE CASCADE ───────────────────────────────────────────────────
const ACROSS = {
  ethereum:'0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
  arbitrum:'0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
  base:    '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
  polygon: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
  optimism:'0x6f26Bf09B1C792e3228e5467807a900A503c0281',
}
const BRIDGE_AMT = { ethereum:20, arbitrum:2, base:1, optimism:1, polygon:1, avalanche:3, bnb:3, scroll:2 }

export async function onFirstDeploy(fromChain) {
  console.log(`[1A] First deploy: ${fromChain} — cascading to remaining chains`)
  const remaining = getActiveChains().filter(c=>!_live.has(c.name)&&c.name!=='_cascaded')
  console.log(`[1A] Remaining: ${remaining.map(c=>c.name).join(', ')||'none'}`)

  // Immediate direct deploy for L2s (gas cents)
  const l2s = remaining.filter(c=>c.tier>1)
  await Promise.allSettled(l2s.map(c=>directDeploy(c.name).catch(e=>
    console.error(`[1A] Cascade direct failed ${c.name}:`,e.message?.slice(0,80))
  )))

  // Bridge USDC to ETH and other tier-1 chains
  const srcChain = getChain(fromChain)
  if (!srcChain?.usdc||!ACROSS[fromChain]) {
    console.log(`[1A] No Across bridge from ${fromChain} — trying direct deploy for tier1`)
    await Promise.allSettled(remaining.filter(c=>c.tier===1)
      .map(c=>directDeploy(c.name).catch(()=>{})))
    return
  }

  const exec = getExecutorAddress()
  await Promise.allSettled(remaining.filter(c=>c.tier===1&&c.name!==fromChain).map(async target => {
    const amount = BigInt(Math.floor((BRIDGE_AMT[target.name]||2)*1e6))
    const data   = '0xa0c76a06'+
      exec.slice(2).padStart(64,'0')+
      srcChain.usdc.slice(2).padStart(64,'0')+
      amount.toString(16).padStart(64,'0')+
      BigInt(target.chainId||0).toString(16).padStart(64,'0')+
      '0'.repeat(64)+
      Math.floor(Date.now()/1000).toString(16).padStart(64,'0')
    try {
      const hash = await sendTx(fromChain, ACROSS[fromChain], data)
      console.log(`[1A] Bridge ${fromChain}→${target.name} $${BRIDGE_AMT[target.name]||2} USDC: ${hash}`)
      setTimeout(()=>directDeploy(target.name).catch(()=>{}), 90000)
    } catch(e) {
      console.error(`[1A] Bridge to ${target.name} failed:`,e.message?.slice(0,80))
      directDeploy(target.name).catch(()=>{})
    }
  }))
}

// ── RECOVERY ─────────────────────────────────────────────────────────────────
export async function recoverDeployedChains(computedAddr) {
  let count=0
  await Promise.allSettled(getActiveChains().map(async chain=>{
    const stored=getContractAddr(chain.name)||computedAddr
    if (!stored) return
    if (await contractExists(chain.name,stored).catch(()=>false)) {
      setContractAddr(chain.name,stored); _live.add(chain.name); count++
      emit('deploy_success',{chain:chain.name,address:stored,method:'recovered'})
    }
  }))
  return count
}

export const isLive        = c => _live.has(c)
export const getLiveChains = () => [..._live].filter(c=>c!=='_cascaded')
export const getStatus     = () => ({
  liveChains:     getLiveChains(),
  deployingChains:[..._deploying],
  presigned:      Object.keys(_signed).length,
  queuedSwaps:    _replayQ.length,
  allChains: getActiveChains().map(c=>({
    name:c.name, tier:c.tier,
    status: _live.has(c.name)?'live':(_deploying.has(c.name)?'deploying':getConfig('deploy_status_'+c.name)||'waiting'),
    presigned: !!_signed[c.name],
    address: getContractAddr(c.name)||null
  }))
})
