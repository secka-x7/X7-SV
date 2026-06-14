// X7 PROTOCOL — DEPLOYER
// Uses Arachnid CREATE2 factory (0x4e59b44847b379578588920cA78FbF26c0B4956C)
// Pre-deployed by Ethereum Foundation on ALL EVM chains including Polygon, Arbitrum, Avalanche
// ERC-4337 UserOps require a real `to` address — CREATE2 factory provides it
// Pimlico verifying paymaster pays gas from your 10M free credits
// Zero MATIC, zero ETH, zero USDC ever needed

import { encodeAbiParameters, parseAbiParameters, keccak256, concat, toBytes } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { sendViaPimlico, getPublicClient } from './pimlico.js'
import { compile } from './compiler.js'

// Arachnid CREATE2 factory — same address on every EVM chain
// Verified: etherscan, polygonscan, arbiscan, snowtrace
const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

// Deterministic salt — same contract address every time on every chain
const SALT = '0x0000000000000000000000000000000000000000000000000000000000000001'

// Predict the CREATE2 address before deploying
// address = keccak256(0xff ++ factory ++ salt ++ keccak256(bytecode))[12:]
function predictAddress(bytecode) {
  const bytecodeHash = keccak256(bytecode)
  const packed = concat([
    '0xff',
    CREATE2_FACTORY,
    SALT,
    bytecodeHash
  ])
  const hash = keccak256(packed)
  return ('0x' + hash.slice(26)) // last 20 bytes = address
}

// Encode calldata for CREATE2 factory: salt (32 bytes) + bytecode
function encodeCreate2Data(bytecode) {
  // Factory expects: salt (bytes32) concatenated with bytecode
  return concat([SALT, bytecode])
}

export async function deployToChain(chainName) {
  const existing = getConfig('contract_' + chainName)
  if (existing && existing.startsWith('0x') && existing.length === 42 && existing !== 'failed') {
    console.log('[DEPLOY] ' + chainName + ': already at ' + existing)
    return existing
  }

  const chain = CHAINS[chainName]
  if (!chain) return null

  const artifact = await compile()
  if (!artifact) { console.error('[DEPLOY] compile failed'); return null }

  // Build full bytecode with constructor args
  const { encodeDeployData } = await import('viem')
  const fullBytecode = encodeDeployData({
    abi:      artifact.abi,
    bytecode: artifact.bytecode,
    args: [
      chain.aavePool || '0x0000000000000000000000000000000000000001',
      chain.router,
      chain.usdc
    ]
  })

  // Predict the deployment address — deterministic
  const predicted = predictAddress(fullBytecode)
  console.log('[DEPLOY] ' + chainName + ': predicted address → ' + predicted)

  // Check if already deployed at predicted address
  const client = getPublicClient(chainName)
  try {
    const code = await client.getBytecode({ address: predicted })
    if (code && code !== '0x' && code.length > 2) {
      console.log('[DEPLOY] ' + chainName + ': already deployed at predicted address')
      setConfig('contract_' + chainName, predicted)
      return predicted
    }
  } catch {}

  console.log('[DEPLOY] ' + chainName + ': deploying via CREATE2 factory (Pimlico pays gas)...')

  try {
    // Encode factory calldata: salt + bytecode
    const calldata = encodeCreate2Data(fullBytecode)

    // Send to CREATE2 factory via Pimlico smart account
    // This is a CALL to the factory, not a contract creation
    // UserOp has real to address = Pimlico accepts it = free credits pay gas
    const txHash = await sendViaPimlico(chainName, CREATE2_FACTORY, calldata)
    if (!txHash) throw new Error('sendViaPimlico returned null')

    console.log('[DEPLOY] ' + chainName + ': tx submitted → ' + txHash)

    // Wait for confirmation and verify bytecode exists
    await client.waitForTransactionReceipt({ hash: txHash, timeout: 120000 })

    // Verify contract actually deployed
    const code = await client.getBytecode({ address: predicted })
    if (!code || code === '0x' || code.length <= 2) {
      throw new Error('bytecode not found at predicted address after tx')
    }

    setConfig('contract_' + chainName, predicted)
    console.log('[DEPLOY] ' + chainName + ': SUCCESS → ' + predicted)
    return predicted

  } catch (e) {
    console.log('[DEPLOY] ' + chainName + ': failed — ' + e.message?.slice(0, 200))
    return null
  }
}

export async function deployAll() {
  console.log('[DEPLOY] Deploying to all chains via CREATE2 + Pimlico free credits...')
  const order = ['polygon', 'arbitrum', 'avalanche', 'ethereum']
  for (const chainName of order) {
    if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue
    await deployToChain(chainName).catch(e =>
      console.log('[DEPLOY] ' + chainName + ': ' + e.message?.slice(0, 100))
    )
    await new Promise(r => setTimeout(r, 3000))
  }
}
