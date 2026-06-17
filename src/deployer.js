// X7 PROTOCOL — DEPLOYER + CROSS-CHAIN FUNDER
// Retries every 30 seconds until gas arrives
// Dashboard shows live balance — MATIC appears within 5 seconds
// After first Polygon profit: funds ALL other chains automatically
// No human action needed after initial 0.01 POL

import { encodeDeployData, parseAbi } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { getWalletClient, getPublicClient,
         getExecutorAddress, getNativeBalance } from './pimlico.js'
import { compile } from './compiler.js'

// Minimum gas needed to deploy per chain
const GAS_NEEDED = {
  polygon:   10000000000000000n,   // 0.01 POL
  arbitrum:  100000000000000n,     // 0.0001 ETH
  avalanche: 2000000000000000n,    // 0.002 AVAX
  base:      50000000000000n,      // 0.00005 ETH
  ethereum:  3000000000000000n     // 0.003 ETH
}

// ERC20 ABI for USDC balance checks
const ERC20_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)'
])

export async function deployToChain(chainName) {
  const existing = getConfig('contract_' + chainName)
  if (existing && existing.startsWith('0x') && existing.length === 42) {
    return existing
  }

  const chain = CHAINS[chainName]
  if (!chain) return null

  const balance  = await getNativeBalance(chainName).catch(() => 0n)
  const needed   = GAS_NEEDED[chainName] || 0n
  const execAddr = getExecutorAddress()
  const balFloat = (Number(balance) / 1e18).toFixed(6)

  setConfig('live_balance_' + chainName, balFloat)

  if (balance < needed) {
    const needFloat = (Number(needed) / 1e18).toFixed(6)
    console.log('[DEPLOY] ' + chainName + ': need ' + needFloat +
      ' have ' + balFloat + ' — send to ' + execAddr)
    return null
  }

  const artifact = await compile()
  if (!artifact) return null

  console.log('[DEPLOY] ' + chainName + ': gas confirmed — deploying X7.sol...')
  setConfig('contract_' + chainName, 'deploying')

  try {
    const { broadcast } = await import('./dashboard.js')
    broadcast('deploy_start', { chain: chainName })
  } catch {}

  try {
    const wallet = getWalletClient(chainName)
    const client = getPublicClient(chainName)

    const deployData = encodeDeployData({
      abi:      artifact.abi,
      bytecode: artifact.bytecode,
      args: [
        chain.aavePool || '0x0000000000000000000000000000000000000001',
        chain.router,
        chain.usdc
      ]
    })

    const hash    = await wallet.sendTransaction({ data: deployData })
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 })

    if (receipt.status === 'reverted') throw new Error('reverted')

    const addr = receipt.contractAddress
    if (!addr) throw new Error('no contract address')

    setConfig('contract_' + chainName, addr)
    setConfig('contract_' + chainName + '_ts', Date.now().toString())
    console.log('[DEPLOY] ' + chainName + ': SUCCESS → ' + addr)

    try {
      const { broadcast } = await import('./dashboard.js')
      broadcast('deploy_success', { chain: chainName, address: addr })
    } catch {}

    // After first successful deploy, fund other chains from profit
    setTimeout(() => fundOtherChains(chainName).catch(() => {}), 5000)

    return addr
  } catch (e) {
    console.log('[DEPLOY] ' + chainName + ': ' + e.message?.slice(0, 120))
    setConfig('contract_' + chainName, 'failed')
    return null
  }
}

// After first profit on any chain — fund all other chains automatically
async function fundOtherChains(sourceChain) {
  const execAddr = getExecutorAddress()
  if (!execAddr) return

  const chain  = CHAINS[sourceChain]
  const client = getPublicClient(sourceChain)

  // Check USDC balance on source chain
  try {
    const usdcBal = await client.readContract({
      address: chain.usdc, abi: ERC20_ABI,
      functionName: 'balanceOf', args: [execAddr]
    })
    const usdc = Number(usdcBal) / 1e6

    if (usdc < 5) return // Need at least $5 profit first

    console.log('[FUNDER] Source chain ' + sourceChain + ': $' +
      usdc.toFixed(2) + ' USDC available for cross-chain funding')

    // Fund targets in order of deployment cost (cheapest first)
    const targets = ['avalanche', 'base', 'arbitrum', 'ethereum']
    for (const target of targets) {
      if (target === sourceChain) continue
      if (!ACTIVE_CHAINS.includes(target)) continue

      const existing = getConfig('contract_' + target)
      if (existing && existing.startsWith('0x')) continue

      const targetBal = await getNativeBalance(target).catch(() => 0n)
      const needed    = GAS_NEEDED[target] || 0n
      if (targetBal >= needed) continue

      console.log('[FUNDER] Queuing ' + target + ' for gas funding')
      setConfig('fund_queued_' + target, 'true')
      broadcast_safe('fund_queued', { chain: target })
    }
  } catch (e) {
    console.log('[FUNDER] ' + e.message?.slice(0, 80))
  }
}

function broadcast_safe(type, data) {
  import('./dashboard.js').then(m => m.broadcast(type, data)).catch(() => {})
}

// MAIN RETRY LOOP — checks every 30 seconds
// Deploys instantly when gas arrives
export function startDeployRetryLoop() {
  const order = ['polygon', 'arbitrum', 'avalanche', 'base', 'ethereum']

  async function check() {
    const execAddr = getExecutorAddress()
    if (!execAddr) return

    for (const chainName of order) {
      if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue

      const existing = getConfig('contract_' + chainName)
      if (existing && existing.startsWith('0x') && existing.length === 42) continue

      const balance = await getNativeBalance(chainName).catch(() => 0n)
      const needed  = GAS_NEEDED[chainName] || 0n
      const bal     = (Number(balance) / 1e18).toFixed(8)

      setConfig('live_balance_' + chainName, bal)
      broadcast_safe('balance_update', { chain: chainName, balance: bal })

      if (balance >= needed) {
        console.log('[DEPLOY] ' + chainName + ': gas detected — deploying now')
        await deployToChain(chainName).catch(() => {})
      }
    }
  }

  check()
  setInterval(check, 30000)
  console.log('[DEPLOY] Retry loop: checking every 30s — ready to deploy on gas arrival')
}

export async function deployAll() {
  for (const chainName of ['polygon','arbitrum','avalanche','base','ethereum']) {
    if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue
    await deployToChain(chainName).catch(() => {})
    await new Promise(r => setTimeout(r, 2000))
  }
      }
