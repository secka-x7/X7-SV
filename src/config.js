// X7 PROTOCOL — CONFIG
// Supports both ALCHEMY_POL_KEY and ALCHEMY_POLY_KEY (whichever you set in Railway)

export const EXEC_KEY  = process.env.EXECUTOR_PRIVATE_KEY || null
export const OWNER_KEY = process.env.OWNER_PRIVATE_KEY    || null

export const DEPLOY_THRESHOLD = {
  polygon:   BigInt('10000000000000000'),
  arbitrum:  BigInt('100000000000000'),
  avalanche: BigInt('2000000000000000'),
  base:      BigInt('50000000000000'),
  optimism:  BigInt('50000000000000'),
  bnb:       BigInt('1000000000000000'),
  scroll:    BigInt('20000000000000'),
  ethereum:  BigInt('3000000000000000'),
}

export const NATIVE_SYMBOL = {
  polygon:'POL', arbitrum:'ETH', avalanche:'AVAX',
  base:'ETH', optimism:'ETH', bnb:'BNB', scroll:'ETH', ethereum:'ETH'
}

export const CROSS_CHAIN_SEED_USD = {
  arbitrum:2.00, avalanche:0.50, base:1.00,
  optimism:1.00, bnb:1.00, scroll:0.50, ethereum:10.00
}

function alKey(keys) {
  for (const k of keys) if (process.env[k] && process.env[k] !== 'demo') return process.env[k]
  return 'demo'
}

export const CHAINS = {
  polygon: {
    id:137, nativeName:'POL', gasMethod:'eoa',
    rpcHttp:`https://polygon-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_POL_KEY','ALCHEMY_POLY_KEY'])}`,
    rpcWss: `wss://polygon-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_POL_KEY','ALCHEMY_POLY_KEY'])}`,
    aavePool:'0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aaveData:'0x9441B65EE553F70df9C77d45d3283B6BC24F222d',
    compoundUsdc:'0xF25212E676D1F7F89Cd72fFEe66158f541246445',
    router:'0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    usdc:'0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    weth:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    wbtc:'0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    wmatic:'0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    link:'0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
    liquidationBonuses:{weth:500,wbtc:1000,usdc:450,wmatic:750,link:750},
    minProfit:5, flashFeeBps:5, active:true,
    explorer:'https://polygonscan.com/tx/'
  },
  arbitrum: {
    id:42161, nativeName:'ETH', gasMethod:'eoa',
    rpcHttp:`https://arb-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_ARB_KEY'])}`,
    rpcWss: `wss://arb-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_ARB_KEY'])}`,
    aavePool:'0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aaveData:'0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
    compoundUsdc:'0x9c4ec768c28032b0Fed380b8b8b6E8FeC4B2f67f',
    router:'0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    weth:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    wbtc:'0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0',
    link:'0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    dai:'0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    liquidationBonuses:{weth:500,wbtc:1000,usdc:450,link:750,dai:450},
    minProfit:10, flashFeeBps:5, active:true,
    explorer:'https://arbiscan.io/tx/'
  },
  base: {
    id:8453, nativeName:'ETH', gasMethod:'eoa',
    rpcHttp:`https://base-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_BASE_KEY'])}`,
    rpcWss: `wss://base-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_BASE_KEY'])}`,
    aavePool:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    aaveData:'0x2d8A3C5677189723C4cB8873CfC9C8976ddf54a3',
    router:'0x2626664c2603336E57B271c5C0b26F421741e481',
    quoter:'0x3d4e44Eb1374240CE5F1B136041efad1D79bE9c2',
    usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    weth:'0x4200000000000000000000000000000000000006',
    cbeth:'0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    liquidationBonuses:{weth:500,usdc:450,cbeth:550},
    minProfit:3, flashFeeBps:0, active:true,
    explorer:'https://basescan.org/tx/'
  },
  optimism: {
    id:10, nativeName:'ETH', gasMethod:'eoa',
    rpcHttp:`https://opt-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_OPT_KEY','ALCHEMY_OP_KEY'])}`,
    rpcWss: `wss://opt-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_OPT_KEY','ALCHEMY_OP_KEY'])}`,
    aavePool:'0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aaveData:'0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
    router:'0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    usdc:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    weth:'0x4200000000000000000000000000000000000006',
    wbtc:'0x68f180fcCe6836688e9084f035309E29Bf0A2095',
    link:'0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6',
    dai:'0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    liquidationBonuses:{weth:500,wbtc:1000,usdc:450,link:750,dai:450},
    minProfit:3, flashFeeBps:5, active:true,
    explorer:'https://optimistic.etherscan.io/tx/'
  },
  bnb: {
    id:56, nativeName:'BNB', gasMethod:'eoa',
    rpcHttp:`https://bnb-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_BNB_KEY'])}`,
    rpcWss: `wss://bnb-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_BNB_KEY'])}`,
    aavePool:'0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    aaveData:'0x23dF2a19384231aFD114b036C14b6b03324D79BC',
    router:'0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
    quoter:'0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    usdc:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    weth:'0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    wbtc:'0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    wbnb:'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    liquidationBonuses:{weth:500,wbtc:1000,usdc:450,wbnb:500},
    minProfit:5, flashFeeBps:5, active:true,
    explorer:'https://bscscan.com/tx/'
  },
  scroll: {
    id:534352, nativeName:'ETH', gasMethod:'eoa',
    rpcHttp:`https://scroll-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_SCROLL_KEY'])}`,
    rpcWss: `wss://scroll-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_SCROLL_KEY'])}`,
    aavePool:'0x11fCfe756c05AD438e312a7fd934381537D3cFfe',
    aaveData:'0xa99F4E69acF23C6838DE90dD1B5c02EA928A53ee',
    router:'0xfc30937f5cDe93Df8d48aCAF7e6f5D8D8A31F636',
    quoter:'0x3A63171DD9BebF4D07BC782FECC7eb0b890C2A45',
    usdc:'0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
    weth:'0x5300000000000000000000000000000000000004',
    liquidationBonuses:{weth:500,usdc:450},
    minProfit:2, flashFeeBps:0, active:true,
    explorer:'https://scrollscan.com/tx/'
  },
  avalanche: {
    id:43114, nativeName:'AVAX', gasMethod:'eoa',
    rpcHttp:`https://avax-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_AVAX_KEY'])}`,
    rpcWss: `wss://avax-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_AVAX_KEY'])}`,
    aavePool:'0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aaveData:'0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
    router:'0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
    quoter:'0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    usdc:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    weth:'0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    wavax:'0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    wbtc:'0x50b7545627a5162F82A992c33b87aDc75187B218',
    liquidationBonuses:{weth:500,wbtc:1000,usdc:450,wavax:750},
    minProfit:5, flashFeeBps:5, active:true,
    explorer:'https://snowtrace.io/tx/'
  },
  ethereum: {
    id:1, nativeName:'ETH', gasMethod:'flashbots',
    rpcHttp:`https://eth-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_ETH_KEY'])}`,
    rpcWss: `wss://eth-mainnet.g.alchemy.com/v2/${alKey(['ALCHEMY_ETH_KEY'])}`,
    flashbotsRelay:'https://relay.flashbots.net',
    aavePool:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    aaveData:'0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3',
    compoundUsdc:'0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    morpho:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    router:'0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    weth:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wbtc:'0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    link:'0x514910771AF9Ca656af840dff83E8264EcF986CA',
    dai:'0x6B175474E89094C44Da98b954EedeAC495271d0F',
    liquidationBonuses:{weth:500,wbtc:1000,usdc:450,link:750,dai:450},
    minProfit:50, flashFeeBps:5, active:true,
    explorer:'https://etherscan.io/tx/'
  }
}

export const ACTIVE_CHAINS = Object.entries(CHAINS)
  .filter(([,c]) => c.active && !c.rpcHttp.includes('demo'))
  .map(([k]) => k)

export const FUND_ORDER = ['base','scroll','avalanche','optimism','arbitrum','bnb','ethereum']

export const TOPICS = {
  BORROW:      '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0',
  LIQUIDATION: '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286'
    }
