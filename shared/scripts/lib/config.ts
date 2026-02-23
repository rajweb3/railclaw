import { resolve } from 'path';

/**
 * Central configuration loaded from environment variables.
 * All scripts use this to access RPC, encryption, and monitoring settings.
 */
export const config = {
  rpc: {
    polygon: process.env.RPC_POLYGON || 'https://polygon-rpc.com',
    arbitrum: process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
    ethereum: process.env.RPC_ETHEREUM || 'https://eth.llamarpc.com',
    optimism: process.env.RPC_OPTIMISM || 'https://mainnet.optimism.io',
    base: process.env.RPC_BASE || 'https://mainnet.base.org',
    avalanche: process.env.RPC_AVALANCHE || 'https://api.avax.network/ext/bc/C/rpc',
    bsc: process.env.RPC_BSC || 'https://bsc-dataseed.binance.org',
    solana: process.env.RPC_SOLANA || 'https://api.mainnet-beta.solana.com',
  } as Record<string, string>,

  encryption: {
    walletKey: process.env.WALLET_ENCRYPTION_KEY || '',
  },

  payment: {
    baseUrl: process.env.PAYMENT_LINK_BASE_URL || 'https://pay.railclaw.io',
    defaultExpiryHours: parseInt(process.env.PAYMENT_EXPIRY_HOURS || '24'),
  },

  monitoring: {
    pollIntervalMs: parseInt(process.env.TX_POLL_INTERVAL_MS || '15000'),
    requiredConfirmations: parseInt(process.env.TX_REQUIRED_CONFIRMATIONS || '20'),
    timeoutMs: parseInt(process.env.TX_MONITOR_TIMEOUT_MS || '3600000'),
  },

  // Shared data directory (mounted into both containers)
  dataDir: process.env.RAILCLAW_DATA_DIR || '/data',

  // Well-known ERC-20 token contract addresses per chain
  tokens: {
    polygon: {
      USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    },
    arbitrum: {
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    },
    ethereum: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    },
    optimism: {
      USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    },
    base: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
    avalanche: {
      USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
    },
    bsc: {
      USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      USDT: '0x55d398326f99059fF775485246999027B3197955',
      DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
    },
  } as Record<string, Record<string, string>>,
};

/**
 * Parse CLI arguments into a key-value map.
 * Supports: --key value and --flag (boolean true)
 */
export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      args[key] = value;
      if (value !== 'true') i++;
    }
  }
  return args;
}

/**
 * Resolve a data sub-directory path.
 * Uses RAILCLAW_DATA_DIR as base, falls back to local ./data
 */
export function resolveDataPath(...segments: string[]): string {
  return resolve(config.dataDir, ...segments);
}
