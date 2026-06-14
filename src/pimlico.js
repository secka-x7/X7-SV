import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon, arbitrum, mainnet, avalanche } from 'viem/chains'
import { createSmartAccountClient } from 'permissionless'
import { toSimpleSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { entryPoint07Address } from 'viem/account-abstraction'
import { CHAINS, EXEC_KEY } from './config.js'
import { getConfig, setConfig } from './db.js'

const VIEM_CHAINS = { polygon, arbitrum, ethereum: mainnet, avalanche }
const _pub = {}, _wal = {}, _smart = {}, _addrs = {}

function account() {
  if (!EXEC_KEY) throw new Error('EXECUTOR_PRIVATE_KEY not set')
  const k = EXEC_KEY.startsWith('0x') ? EXEC_KEY : '0x' + EXEC_KEY
  return privateKeyToAccount(k)
}

export function getPublicClient(chainName) {
  if (!_pub[chainName]) _pub[chainName] = createPublicClient({
    chain: VIEM_CHAINS[chainName], transport: http(CHAINS[chainName].rpcHttp)
  })
  return _pub[chainName]
}

export function getWalletClient(chainName) {
  if (!_wal[chainName]) _wal[chainName] = createWalletClient({
    account: account(), chain: VIEM_CHAINS[chainName],
    transport: http(CHAINS[chainName].rpcHttp)
  })
  return _wal[chainName]
}

async function getSmartClient(chainName) {
  // Always rebuild if cached client used old key
  const pimlicoUrl = CHAINS[chainName]?.pimlico  // getter — reads env fresh every time
  if (!pimlicoUrl) {
    console.log('[PIMLICO] ' + chainName + ': no API key')
    return null
  }

  // Check if we have a valid cached client for this URL
  if (_smart[chainName]?.url === pimlicoUrl) return _smart[chainName].client

  console.log('[PIMLICO] ' + chainName + ': initialising smart account...')

  try {
    const pub = getPublicClient(chainName)

    const smartAccount = await toSimpleSmartAccount({
      client:     pub,
      owner:      account(),
      entryPoint: { address: entryPoint07Address, version: '0.7' }
    })

    _addrs[chainName] = smartAccount.address
    setConfig('smart_addr_' + chainName, smartAccount.address)
    console.log('[PIMLICO] ' + chainName + ' smart account: ' + smartAccount.address)

    const pimlico = createPimlicoClient({
      transport:  http(pimlicoUrl),
      chain:      VIEM_CHAINS[chainName],
      entryPoint: { address: entryPoint07Address, version: '0.7' }
    })

    // Verifying paymaster — Pimlico sponsors gas from your free credits
    // No paymasterContext = verifying paymaster (NOT ERC-20, no USDC needed)
    const client = createSmartAccountClient({
      account:          smartAccount,
      chain:            VIEM_CHAINS[chainName],
      bundlerTransport: http(pimlicoUrl),
      paymaster:        pimlico
    })

    _smart[chainName] = { client, url: pimlicoUrl }
    return client
  } catch (e) {
    console.log('[PIMLICO] ' + chainName + ' init error: ' + e.message?.slice(0, 150))
    return null
  }
}

export async function sendViaPimlico(chainName, to, data, value = 0n) {
  try {
    const client = await getSmartClient(chainName)
    if (client) {
      const hash = await client.sendTransaction({ to, data, value })
      console.log('[PIMLICO] ' + chainName + ': sent → ' + hash)
      return hash
    }
  } catch (e) {
    console.log('[PIMLICO] ' + chainName + ' error: ' + e.message?.slice(0, 150))
  }
  return sendDirect(chainName, to, data, value)
}

async function sendDirect(chainName, to, data, value = 0n) {
  console.log('[PIMLICO] ' + chainName + ': falling back to direct EOA (needs native gas)')
  const w = getWalletClient(chainName)
  const c = getPublicClient(chainName)
  const h = await w.sendTransaction({ to, data, value })
  await c.waitForTransactionReceipt({ hash: h, timeout: 120000 })
  return h
}

export async function deployContract(chainName, abi, bytecode, args = []) {
  const w = getWalletClient(chainName)
  const c = getPublicClient(chainName)
  const h = await w.deployContract({ abi, bytecode, args })
  const r = await c.waitForTransactionReceipt({ hash: h, timeout: 120000 })
  return r.contractAddress
}

export function getExecutorAddress() {
  try { return account().address } catch { return null }
}

export async function getSmartAddress(chainName) {
  if (_addrs[chainName]) return _addrs[chainName]
  const cached = getConfig('smart_addr_' + chainName)
  if (cached) { _addrs[chainName] = cached; return cached }
  await getSmartClient(chainName).catch(() => {})
  return _addrs[chainName] || getExecutorAddress()
}
