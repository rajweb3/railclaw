import { resolve } from 'path';

/**
 * Central configuration loaded from environment variables.
 * All scripts use this to access RPC, encryption, and monitoring settings.
 */
export const config = {
  rpc: {
    polygon: process.env.RPC_POLYGON || 'https://polygon-rpc.com',
    arbitrum: process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
    solana: process.env.RPC_SOLANA || 'https://api.mainnet-beta.solana.com',
  } as Record<string, string>,

  sol: {
    // Solana wallet that holds SOL to fund temp wallets for transaction fees
    // Generate with: solana-keygen new --outfile sol-dispenser.json
    // Fund it with at least 0.1 SOL on mainnet
    dispenserKey: process.env.SOLANA_SOL_DISPENSER_KEY || '',
    // SOL sent to each temp wallet to cover depositV3 tx fees (~0.002 SOL needed)
    fundAmountLamports: parseInt(process.env.SOLANA_FUND_LAMPORTS || '5000000'), // 0.005 SOL
  },

  bridge: {
    // Across Protocol chain IDs
    acrossChainIds: {
      polygon: 137,
      arbitrum: 42161,
      solana: 34268394551451,
    } as Record<string, number>,
    // Across SpokePool contract addresses per chain
    spokePools: {
      polygon: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
      arbitrum: '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a',
      // Solana SpokePool program ID (not an EVM address)
      solana: 'DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru',
    } as Record<string, string>,
    // Conservative relay fee estimate: 0.12% of amount (LP fee ~0.04% + gas buffer)
    estimatedRelayFeePct: parseFloat(process.env.ACROSS_RELAY_FEE_PCT || '0.0012'),
    // Minimum fee buffer in token base units (covers gas on destination)
    minRelayFeeBuffer: parseFloat(process.env.ACROSS_MIN_FEE_BUFFER || '0.50'),
    // How far ahead to set fillDeadline (seconds) — 6 hours is standard
    fillDeadlineOffsetSec: 6 * 60 * 60,
  },

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

  // Well-known token addresses per chain (ERC-20 on EVM, mint addresses on Solana)
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
    solana: {
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
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
