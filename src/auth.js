// ─── SIWE authentication → JWT ──────────────────────────────────
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';
import { SiweMessage, generateNonce } from 'siwe';
import { log, timed } from './util.js';

const CHAINS = {
  84532: baseSepolia,
  8453:  base,
};

/**
 * Create a viem wallet client from a private key + chain ID.
 */
export function createWallet(privateKey, chainId = 84532) {
  const chain = CHAINS[chainId] || baseSepolia;
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain,
    transport: http(),
  });
  return client;
}

/**
 * Authenticate with QuickNode x402 via SIWE → JWT.
 *
 * @param {object} walletClient  viem WalletClient
 * @param {string} baseUrl       e.g. https://x402.quicknode.com
 * @param {number} chainId       84532 (testnet) or 8453 (mainnet)
 * @returns {{ token: string, expiresAt: string, accountId: string }}
 */
export async function authenticate(walletClient, baseUrl, chainId = 84532) {
  log.step('Authenticating with SIWE');

  // 1. Build SIWE message
  const siweMessage = new SiweMessage({
    domain:    'x402.quicknode.com',
    address:   walletClient.account.address,
    statement: 'I accept the Quicknode Terms of Service: https://www.quicknode.com/terms',
    uri:       baseUrl,
    version:   '1',
    chainId,
    nonce:     generateNonce(),
    issuedAt:  new Date().toISOString(),
  });

  const message = siweMessage.prepareMessage();
  log.info(`Wallet: ${walletClient.account.address}`);
  log.info(`Chain:  ${chainId}`);

  // 2. Sign
  const signature = await walletClient.signMessage({ message });
  log.info('SIWE message signed');

  // 3. Exchange for JWT
  const [res, ms] = await timed(() =>
    fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    }),
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Auth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  log.ok(`JWT obtained in ${ms} ms (expires ${data.expiresAt})`);
  return data;  // { token, expiresAt, accountId }
}
