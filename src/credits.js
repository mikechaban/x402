// ─── Credit balance & testnet faucet ────────────────────────────
import 'dotenv/config';
import { log, timed, loadEnv } from './util.js';
import { createWallet, authenticate } from './auth.js';

/**
 * Fetch current credit balance.
 */
export async function getCredits(baseUrl, token) {
  const [res, ms] = await timed(() =>
    fetch(`${baseUrl}/credits`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Credits check failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  log.info(`Credits: ${data.credits}  (${ms} ms)`);
  return data;
}

/**
 * Request free testnet USDC via the /drip faucet (one-time, Base Sepolia only).
 */
export async function requestDrip(baseUrl, token) {
  log.step('Requesting testnet USDC (POST /drip)');

  const [res, ms] = await timed(() =>
    fetch(`${baseUrl}/drip`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drip failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  log.ok(`Faucet tx: ${data.transactionHash}  (${ms} ms)`);
  log.info(`USDC sent to: ${data.walletAddress}`);
  log.warn('Wait ~10 s for the USDC to confirm on-chain before making paid requests.');
  return data;
}

// ─── CLI entry ──────────────────────────────────────────────────
const isCli = process.argv[1]?.endsWith('credits.js');
if (isCli) {
  const env = loadEnv();
  const wallet = createWallet(env.privateKey, env.chainId);
  const { token } = await authenticate(wallet, env.baseUrl, env.chainId);

  if (process.argv.includes('--drip')) {
    await requestDrip(env.baseUrl, token);
  } else {
    await getCredits(env.baseUrl, token);
  }
}
