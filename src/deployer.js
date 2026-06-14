// X7 PROTOCOL — DEPLOYER
//
// ZERO MATIC / ETH / AVAX NEEDED — EVER.
//
// How: The smart account (owned by EXECUTOR_PRIVATE_KEY) calls the
// Deterministic Deployment Proxy (DDP) — a CREATE2 factory deployed
// at the same address on every EVM chain. The smart account tx is
// sponsored by Pimlico verifying paymaster (10M free credits).
//
// Flow:
//   smart account → DDP factory → X7 contract deployed via CREATE2
//   Pimlico pays the gas from free credits
//   Zero native token (MATIC/ETH/AVAX) ever needed
//
// Address is deterministic — same across all chains with same bytecode+salt.

import { keccak256, concat, pad, getContractAddress } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { sendViaPimlico, getPublicClient, getSmartAddress } from './pimlico.js'
import { compile } from './compiler.js'

// Deterministic Deployment Proxy — deployed on every EVM chain
// https://github.com/Arachnid/deterministic-deployment-proxy
const DDP_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

// Salt — fixed so address is same across all chains
const SALT = pad('0x58375f50524f544f434f4c5f5631', { size: 32 }) // "X7_PROTOCOL_V1"

// Predict the deployed address from bytecode alone (before deploying)
function predictAddress(bytecode) {
  return getContractAddress({
    opcode:       'CREATE2',
    from:         DDP_FACTORY,
    salt:         SALT,
    bytecodeHash: keccak256(bytecode)
  })
}

// Build the constructor-encoded initcode for X7.sol
function buildInitcode(artifact, chain) {
  // encodeDeployData from viem builds: bytecode + abi-encoded constructor args
  const { encodeDeployData } = require('viem') // dynamic to avoid circular
  return encodeDeployData({
    abi:      artifact.abi,
    bytecode: artifact.bytecode,
    args: [
      chain.aavePool || '0x0000000000000000000000000000000000000001',
      chain.router,
      chain.usdc
    ]
  })
}

// DDP calldata = salt (32 bytes) + initcode
// No ABI — DDP reads raw calldata: first 32 bytes = salt, rest = initcode
function buildDDPCalldata(initcode) {
  return concat([SALT, initcode])
}

export async function deployToChain(chainName) {
  const existing = getConfig('contract_' + chainName)
  if (existing && existing.startsWith('0x') && existing !== 'failed') {
    console.log('[DEPLOY] ' + chainName + ': already deployed at ' + existing)
    return existing
  }

  const chain = CHAINS[chainName]
  if (!chain) return null

  console.log('[DEPLOY] ' + chainName + ': compiling X7.sol...')
  const artifact = await compile()
  if (!artifact) { console.error('[DEPLOY] compile failed'); return null }

  // Build initcode with constructor args for this chain
  const { encodeDeployData } = await import('viem')
  const initcode = encodeDeployData({
    abi:      artifact.abi,
    bytecode: artifact.bytecode,
    args: [
      chain.aavePool || '0x0000000000000000000000000000000000000001',
      chain.router,
      chain.usdc
    ]
  })

  // Predict address deterministically
  const predicted = predictAddress(initcode)
  console.log('[DEPLOY] ' + chainName + ': predicted address → ' + predicted)

  // Check if already deployed at predicted address (previous run)
  try {
    const client = getPublicClient(chainName)
    const code   = await client.getCode({ address: predicted })
    if (code && code !== '0x') {
      console.log('[DEPLOY] ' + chainName + ': already on-chain at ' + predicted)
      setConfig('contract_' + chainName, predicted)
      return predicted
    }
  } catch {}

  console.log('[DEPLOY] ' + chainName + ': deploying via DDP (Pimlico pays gas, zero MATIC)...')

  // Build DDP calldata: salt + initcode
  const ddpCalldata = buildDDPCalldata(initcode)

  try {
    // Smart account calls DDP factory — Pimlico verifying paymaster sponsors gas
    const txHash = await sendViaPimlico(chainName, DDP_FACTORY, ddpCalldata)
    if (!txHash) throw new Error('no tx hash returned')

    console.log('[DEPLOY] ' + chainName + ': tx submitted → ' + txHash)

    // Wait for receipt
    const client  = getPublicClient(chainName)
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })

    if (receipt.status !== 'success') throw new Error('tx reverted')

    // Verify deployment at predicted address
    const code = await client.getCode({ address: predicted })
    if (!code || code === '0x') throw new Error('no code at predicted address')

    setConfig('contract_' + chainName, predicted)
    console.log('[DEPLOY] ' + chainName + ': SUCCESS → ' + predicted + ' (zero gas paid)')
    return predicted

  } catch (e) {
    console.log('[DEPLOY] ' + chainName + ': failed — ' + (e.message || '').slice(0, 200))
    setConfig('contract_' + chainName, 'failed')
    return null
  }
}

export async function deployAll() {
  console.log('[DEPLOY] Deploying all chains via Pimlico verifying paymaster (zero native gas)...')
  // Polygon first — cheapest, most liquidations
  for (const chainName of ['polygon', 'arbitrum', 'avalanche', 'ethereum']) {
    if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) {
      console.log('[DEPLOY] ' + chainName + ': skipped (not in ACTIVE_CHAINS — check Alchemy key in Railway vars)')
      continue
    }
    await deployToChain(chainName).catch(e =>
      console.log('[DEPLOY] ' + chainName + ': ' + (e.message || '').slice(0, 100))
    )
    await new Promise(r => setTimeout(r, 3000))
  }
    }
