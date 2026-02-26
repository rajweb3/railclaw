/**
 * check-wallet-balance.ts — Query ERC-20 token balances for a wallet across chains.
 *
 * Usage:
 *   npx tsx check-wallet-balance.ts \
 *     --wallet 0x... --chains polygon,arbitrum --tokens USDC,USDT
 *
 * Output (stdout JSON):
 *   {
 *     success: true,
 *     wallet: "0x...",
 *     balances: {
 *       polygon:  { USDC: "100.50", USDT: "0.00" },
 *       arbitrum: { USDC: "50.25",  USDT: "0.00" }
 *     }
 *   }
 */

import { ethers } from 'ethers';
import { config, parseArgs } from './lib/config.js';

const args = parseArgs(process.argv);

const wallet = args['wallet']?.toLowerCase();
const chains = (args['chains'] || 'polygon,arbitrum').split(',').map(c => c.trim().toLowerCase());
const tokens = (args['tokens'] || 'USDC').split(',').map(t => t.trim().toUpperCase());

if (!wallet) {
  console.log(JSON.stringify({ success: false, error: 'Missing --wallet' }));
  process.exit(1);
}

const BALANCE_OF_ABI = ['function balanceOf(address) view returns (uint256)'];
const DECIMALS_ABI   = ['function decimals() view returns (uint8)'];

async function getBalance(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  walletAddress: string,
): Promise<string> {
  try {
    const contract  = new ethers.Contract(tokenAddress, [...BALANCE_OF_ABI, ...DECIMALS_ABI], provider);
    const [raw, dec] = await Promise.all([contract.balanceOf(walletAddress), contract.decimals()]);
    return parseFloat(ethers.formatUnits(raw, dec)).toFixed(6);
  } catch {
    return '0.000000';
  }
}

async function main() {
  const balances: Record<string, Record<string, string>> = {};

  await Promise.all(
    chains.map(async (chain) => {
      const rpcUrl = config.rpc[chain];
      if (!rpcUrl) return;

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const chainTokens = config.tokens[chain] ?? {};

      const results = await Promise.all(
        tokens.map(async (token) => {
          const address = chainTokens[token];
          if (!address) return [token, '0.000000'] as const;
          const balance = await getBalance(provider, address, wallet);
          return [token, balance] as const;
        })
      );

      balances[chain] = Object.fromEntries(results);
    })
  );

  console.log(JSON.stringify({ success: true, wallet, balances }));
}

main().catch((err) => {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
