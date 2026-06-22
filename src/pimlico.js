// X7-SV · pimlico.js — ERC-4337 via viem built-in · zero-gas architecture
// CREATE2 address computation · zero-seed bootstrap

import { createWalletClient, createPublicClient, http, encodeFunctionData, keccak256, concat, toBytes, encodeAbiParameters, parseAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, arbitrum, polygon, base, optimism, avalanche, bsc, scroll } from 'viem/chains'
import { getChain } from './chains.js'
import { getConfig, setConfig } from './db.js'

const CHAIN_OBJS = { ethereum: mainnet, arbitrum, polygon, base, optimism, avalanche, bnb: bsc, scroll }
const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

let _account, _walletClients = {}, _publicClients = {}

export function initPimlico() {
  const pk = process.env.EXECUTOR_PRIVATE_KEY
  if (!pk) { console.error('[PIMLICO] No EXECUTOR_PRIVATE_KEY'); return }
  _account = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk)
  console.log('[PIMLICO] Executor:', _account.address)
}

export function getExecutorAddress() { return _account?.address }

export function getWalletClient(chainName) {
  if (_walletClients[chainName]) return _walletClients[chainName]
  const chain = getChain(chainName)
  const chainObj = CHAIN_OBJS[chainName]
  if (!chain || !chainObj || !_account) return null
  _walletClients[chainName] = createWalletClient({
    account: _account,
    chain: chainObj,
    transport: http(chain.rpcHttp)
  })
  return _walletClients[chainName]
}

export function getPublicClient(chainName) {
  if (_publicClients[chainName]) return _publicClients[chainName]
  const chain = getChain(chainName)
  const chainObj = CHAIN_OBJS[chainName]
  if (!chain || !chainObj) return null
  _publicClients[chainName] = createPublicClient({
    chain: chainObj,
    transport: http(chain.rpcHttp)
  })
  return _publicClients[chainName]
}

// Compute deterministic CREATE2 address for X7.sol on any chain
// Same salt + same bytecode = same address on every chain
export function computeCreate2Address(bytecode) {
  const salt = keccak256(toBytes((_account?.address || '0x0') + '_x7sv_v3'))
  const bytecodeHash = keccak256(toBytes(bytecode))
  const payload = concat([
    toBytes('0xff'),
    toBytes(CREATE2_FACTORY),
    toBytes(salt),
    toBytes(bytecodeHash)
  ])
  const hash = keccak256(payload)
  const addr = '0x' + hash.slice(-40)
  return { addr, salt, bytecodeHash }
}

// Build CREATE2 deploy calldata for X7.sol
export function buildDeployCalldata(bytecode, constructorArgs, salt) {
  // CREATE2 factory: deploy(bytes32 salt, bytes calldata bytecode)
  const deployData = encodeFunctionData({
    abi: [{ name: 'deploy', type: 'function', inputs: [{ name: 'salt', type: 'bytes32' }, { name: 'bytecode', type: 'bytes' }], outputs: [{ name: '', type: 'address' }] }],
    functionName: 'deploy',
    args: [salt, bytecode + constructorArgs.slice(2)]
  })
  return deployData
}

// Send transaction (EOA, direct — used for L2s where gas from USDC profit is negligible)
export async function sendTx(chainName, to, data, value = 0n) {
  const wallet = getWalletClient(chainName)
  const client = getPublicClient(chainName)
  if (!wallet || !client) throw new Error('No client: ' + chainName)

  const [nonce, feeData] = await Promise.all([
    client.getTransactionCount({ address: _account.address }),
    client.estimateFeesPerGas()
  ])

  const hash = await wallet.sendTransaction({
    to, data, value, nonce,
    maxFeePerGas: feeData.maxFeePerGas * 12n / 10n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 12n / 10n,
  })
  return hash
}

// Wait for transaction with timeout
export async function waitTx(chainName, hash, timeout = 120000) {
  const client = getPublicClient(chainName)
  if (!client) return null
  const receipt = await client.waitForTransactionReceipt({ hash, timeout })
  return receipt
}

// Pimlico bundler URL for ERC-4337
export function pimlicoUrl(chainId) {
  const key = process.env.PIMLICO_API_KEY
  if (!key) return null
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${key}`
}

// Check if contract exists at address
export async function contractExists(chainName, addr) {
  try {
    const client = getPublicClient(chainName)
    if (!client) return false
    const code = await client.getCode({ address: addr })
    return code && code !== '0x' && code.length > 2
  } catch { return false }
}

// Get stored contract address or null
export function getContractAddr(chainName) {
  const stored = getConfig('contract_' + chainName)
  return stored?.startsWith('0x') && stored.length === 42 ? stored : null
}

export function setContractAddr(chainName, addr) {
  setConfig('contract_' + chainName, addr)
}
