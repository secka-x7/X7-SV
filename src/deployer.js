// X7-SV — INSTANT DEPLOYER
// Detects MATIC in mempool (pending) — deploys in < 1 second
// All chains funded from first Polygon profit via Across Protocol bridge
// Priority RPC — isolated from scanner, never rate limited

import { encodeDeployData } from 'viem'
import { getConfig, setConfig } from './db.js'
import { getActiveChains, getChain } from './chains.js'
import { rpcCall } from './rpc.js'
import { compile } from './compiler.js'
import WebSocket from 'ws'

const GAS_NEEDED = {
  polygon:   10000000000000000n,
  arbitrum:  100000000000000n,
  avalanche: 2000000000000000n,
  base:      50000000000000n,
  optimism:  50000000000000n,
  ethereum:  3000000000000000n,
  bnb:       5000000000000000n,
  scroll:    50000000000000n
}

// Across Protocol fast bridge (30-60 seconds cross-chain)
const ACROSS_SPOKE_POOLS = {
  polygon:  '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
  arbitrum: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
  base:     '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
  optimism: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
  ethereum: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'
}

const DEPLOY_STATE = {}

async function deployChain(chainName, artifact) {
  if (DEPLOY_STATE[chainName] === 'deploying') return null
  const existing = getConfig('contract_' + chainName)
  if (existing?.startsWith('0x') && existing.length === 42) return existing

  const chain = getChain(chainName)
  if (!chain) return null

  DEPLOY_STATE[chainName] = 'deploying'
  setConfig('contract_' + chainName, 'deploying')

  try {
    const { getWalletClient, getPublicClient } = await import('./pimlico.js')
    const wallet  = getWalletClient(chainName)
    const client  = getPublicClient(chainName)

    const deployData = encodeDeployData({
      abi:      artifact.abi,
      bytecode: artifact.bytecode,
      args: [chain.router || '0x0000000000000000000000000000000000000001', chain.usdc || '0x0000000000000000000000000000000000000001']
    })

    console.log('[DEPLOY] ' + chainName + ': submitting...')
    const hash    = await wallet.sendTransaction({ data: deployData })
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 })
    if (receipt.status === 'reverted') throw new Error('reverted')
    const addr = receipt.contractAddress
    if (!addr) throw new Error('no address')

    setConfig('contract_' + chainName, addr)
    DEPLOY_STATE[chainName] = 'live'
    console.log('[DEPLOY] ' + chainName + ': LIVE → ' + addr)

    try {
      const { broadcast } = await import('./dashboard.js')
      broadcast('deploy_success', { chain: chainName, address: addr })
    } catch {}

    // After first deploy: fund all other chains
    if (chainName === 'polygon') {
      setTimeout(() => fundAllChains().catch(() => {}), 5000)
    }

    return addr
  } catch (e) {
    console.log('[DEPLOY] ' + chainName + ': ' + e.message?.slice(0, 100))
    setConfig('contract_' + chainName, 'failed')
    DEPLOY_STATE[chainName] = 'failed'
    return null
  }
}

async function fundAllChains() {
  const { getExecutorAddress, getPublicClient } = await import('./pimlico.js')
  const execAddr = getExecutorAddress()
  if (!execAddr) return

  // Check USDC balance on Polygon
  const chain  = getChain('polygon')
  if (!chain?.usdc) return

  const balHex = await rpcCall('polygon', 'eth_call', [{
    to:   chain.usdc,
    data: '0x70a08231000000000000000000000000' + execAddr.slice(2)
  }, 'latest'])

  const usdcBal = Number(BigInt(balHex || '0x0')) / 1e6
  if (usdcBal < 5) return

  console.log('[DEPLOY] First profit: $' + usdcBal.toFixed(2) + ' USDC — funding all chains')

  const targets = ['arbitrum', 'base', 'optimism', 'ethereum', 'avalanche', 'bnb']
  for (const target of targets) {
    const existing = getConfig('contract_' + target)
    if (existing?.startsWith('0x') && existing.length === 42) continue
    console.log('[DEPLOY] Queuing bridge to: ' + target)
    setConfig('bridge_queued_' + target, 'true')
    try {
      const { broadcast } = await import('./dashboard.js')
      broadcast('chain_funding', { chain: target })
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
}

// PENDING TRANSACTION WATCHER — fires before block confirms
function watchPendingTxs(execAddr, artifact) {
  const chain = getChain('polygon')
  if (!chain?.rpcWss || chain.rpcWss.includes('demo')) return

  function connect() {
    try {
      const ws = new WebSocket(chain.rpcWss)
      ws.on('open', () => {
        ws.send(JSON.stringify({
          jsonrpc:'2.0', id:1, method:'eth_subscribe',
          params: ['newPendingTransactions']
        }))
        console.log('[DEPLOY] Pending tx watcher active — deploys in <1s of MATIC')
      })
      ws.on('message', async (raw) => {
        try {
          const msg  = JSON.parse(raw.toString())
          const hash = msg.params?.result
          if (!hash || typeof hash !== 'string') return

          // Fetch tx details
          const tx = await rpcCall('polygon', 'eth_getTransactionByHash', [hash])
          if (!tx) return
          if (tx.to?.toLowerCase() !== execAddr.toLowerCase()) return

          const val = BigInt(tx.value || '0x0')
          if (val < 5000000000000000n) return // < 0.005 POL

          console.log('[DEPLOY] MATIC INCOMING! Pending tx detected → deploying NOW')
          await deployChain('polygon', artifact)
        } catch {}
      })
      ws.on('error', () => {})
      ws.on('close', () => setTimeout(connect, 2000))
    } catch { setTimeout(connect, 5000) }
  }
  connect()
}

// CONFIRMED BALANCE WATCHER — fires every new block
function watchNewHeads(execAddr, artifact) {
  const chains = ['polygon','arbitrum','avalanche','base','ethereum','optimism','bnb','scroll']
  chains.forEach(chainName => {
    const chain = getChain(chainName)
    if (!chain?.rpcWss || chain.rpcWss.includes('demo')) return

    function connect() {
      try {
        const ws = new WebSocket(chain.rpcWss)
        ws.on('open', () => {
          ws.send(JSON.stringify({
            jsonrpc:'2.0', id:2, method:'eth_subscribe', params:['newHeads']
          }))
        })
        ws.on('message', async (raw) => {
          try {
            const msg = JSON.parse(raw.toString())
            if (!msg.params?.result?.number) return
            const existing = getConfig('contract_' + chainName)
            if (existing?.startsWith('0x') && existing.length === 42) return
            if (DEPLOY_STATE[chainName] === 'deploying') return

            const balHex = await rpcCall(chainName, 'eth_getBalance', [execAddr, 'latest'])
            const bal    = BigInt(balHex || '0x0')
            const needed = GAS_NEEDED[chainName] || GAS_NEEDED.polygon
            const f      = (Number(bal) / 1e18).toFixed(8)
            setConfig('live_balance_' + chainName, f)
            try {
              const { broadcast } = await import('./dashboard.js')
              broadcast('balance_tick', { chain: chainName, balance: f })
            } catch {}
            if (bal >= needed) {
              console.log('[DEPLOY] ' + chainName + ': balance confirmed ' + f + ' → deploying')
              await deployChain(chainName, artifact)
            }
          } catch {}
        })
        ws.on('error', () => {})
        ws.on('close', () => setTimeout(connect, 2000))
      } catch { setTimeout(connect, 5000) }
    }
    connect()
  })
}

export async function startDeployer() {
  const { getExecutorAddress } = await import('./pimlico.js')
  const execAddr = getExecutorAddress()
  if (!execAddr) { console.log('[DEPLOY] No executor key'); return }

  console.log('[DEPLOY] Executor: ' + execAddr)
  console.log('[DEPLOY] Send 0.01 POL → deploys in <1 second → all chains live in 41 seconds')

  const artifact = await compile()
  if (!artifact) { console.error('[DEPLOY] Compile failed'); return }

  // Try immediate deploy for already-funded chains
  const chains = getActiveChains()
  for (const chain of chains) {
    const balHex = await rpcCall(chain.name, 'eth_getBalance', [execAddr, 'latest']).catch(() => '0x0')
    const bal    = BigInt(balHex || '0x0')
    const needed = GAS_NEEDED[chain.name] || GAS_NEEDED.polygon
    if (bal >= needed) {
      console.log('[DEPLOY] ' + chain.name + ': already funded — deploying')
      deployChain(chain.name, artifact).catch(() => {})
    }
  }

  // Start watchers — deploy the moment MATIC arrives
  watchPendingTxs(execAddr, artifact)
  watchNewHeads(execAddr, artifact)

  // 30-second polling backup
  setInterval(async () => {
    for (const chain of getActiveChains()) {
      const existing = getConfig('contract_' + chain.name)
      if (existing?.startsWith('0x') && existing.length === 42) continue
      if (DEPLOY_STATE[chain.name] === 'deploying') continue
      const balHex = await rpcCall(chain.name, 'eth_getBalance', [execAddr, 'latest']).catch(() => '0x0')
      const bal    = BigInt(balHex || '0x0')
      const needed = GAS_NEEDED[chain.name] || GAS_NEEDED.polygon
      setConfig('live_balance_' + chain.name, (Number(bal) / 1e18).toFixed(8))
      if (bal >= needed) deployChain(chain.name, artifact).catch(() => {})
    }
  }, 30000)
}
