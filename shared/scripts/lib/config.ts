import { resolve } from 'path';

/**
 * Central configuration loaded from environment variables.
 * All scripts use this to access RPC, encryption, and monitoring settings.
 */
export const config = {
  rpc: {
    polygon: process.env.RPC_POLYGON || 'https://polygon-rpc.com',
    arbitrum: process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
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
