#!/usr/bin/env node
// ─── x402 Quicknode Demo ───────────────────────────────────────
//
// Usage:
//   node src/demo.js --once     Single RPC call (dry run)
//   node src/demo.js --drain    Loop until 402 → auto-pay → retry
//   node src/demo.js            Same as --drain
// ────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { log, timed, loadEnv } from './util.js';
import { createWallet, authenticate } from './auth.js';
import { createX402Fetch, rpcCall } from './rpc.js';
import { getCredits, requestDrip } from './credits.js';

const CAIP2_MAP = {
  84532: 'eip155:84532',
  8453:  'eip155:8453',
};

async function main() {
  const mode = process.argv.includes('--once') ? 'once' : 'drain';
  const env  = loadEnv();
  const caip2 = CAIP2_MAP[env.chainId] || 'eip155:84532';

  log.banner(`x402 Quicknode Demo  ·  ${env.chainLabel}  ·  mode=${mode}`);

  // ── Step 1: Login ─────────────────────────────────────────────
  const wallet = createWallet(env.privateKey, env.chainId);
  const { token } = await authenticate(wallet, env.baseUrl, env.chainId);

  // ── Step 2: Check credits ─────────────────────────────────────
  log.step('Checking credits');
  let { credits } = await getCredits(env.baseUrl, token);

  // If zero credits and on testnet, try the faucet first
  if (credits === 0 && env.chainId === 84532) {
    log.warn('Zero credits — requesting testnet USDC via /drip');
    try {
      await requestDrip(env.baseUrl, token);
      log.info('Waiting 12 s for USDC to confirm on-chain…');
      await sleep(12_000);
    } catch (err) {
      log.warn(`Drip failed (may already have been used): ${err.message}`);
    }
  }

  // ── Step 3: Build x402-enabled fetch ──────────────────────────
  // createX402Fetch wraps fetch with @x402/fetch so 402 responses
  // trigger automatic USDC payment + retry. We use hooks to detect
  // the 402 → pay → retry cycle in real time.
  let saw402 = false;
  const x402Fetch = createX402Fetch(wallet, token, caip2, {
    on402: () => {
      saw402 = true;
      log.divider();
      log.payment('Received HTTP 402 — Payment Required');
      log.payment('Auto-signing USDC payment…');
    },
    onPaymentRetry: () => {
      log.payment('Retrying request with payment…');
    },
  });

  // ── Step 4: "once" mode ───────────────────────────────────────
  if (mode === 'once') {
    log.step(`Single RPC call: ${env.rpcMethod}`);
    const { result, ms } = await rpcCall(x402Fetch, env.baseUrl, env.network, env.rpcMethod);
    log.ok(`Result: ${result}  (${ms} ms)`);

    log.step('Credits after call');
    await getCredits(env.baseUrl, token);
    log.banner('Done — single call completed');
    return;
  }

  // ── Step 5: "drain" mode ──────────────────────────────────────
  const initial = await getCredits(env.baseUrl, token).catch(() => ({ credits: '??' }));
  let lastKnownCredits = initial.credits;
  log.step(`Drain mode: ${lastKnownCredits} credits to burn (${env.rpcMethod})`);
  log.info('Each successful response costs 1 credit. Throttled to ~4 req/s.');
  log.divider();

  let callNum = 0;
  let paid = false;
  const CREDITS_CHECK_INTERVAL = 10;
  const CALL_DELAY = 250;

  while (true) {
    callNum++;

    // Check credits periodically to avoid 429 on /credits
    if (callNum % CREDITS_CHECK_INTERVAL === 0) {
      const pre = await getCredits(env.baseUrl, token).catch(() => null);
      if (pre) lastKnownCredits = pre.credits;
    } else {
      if (typeof lastKnownCredits === 'number') lastKnownCredits--;
    }

    if (typeof lastKnownCredits === 'number' && lastKnownCredits <= 3 && !paid) {
      const precise = await getCredits(env.baseUrl, token).catch(() => null);
      if (precise) lastKnownCredits = precise.credits;
      log.divider();
      log.warn(`Credits low (${lastKnownCredits}). 402 imminent…`);
      log.divider();
    }

    // Reset per-call detection
    saw402 = false;

    const { result, ms } = await rpcCall(x402Fetch, env.baseUrl, env.network, env.rpcMethod);

    // The hooks fired during the call if a 402 happened
    if (saw402 && !paid) {
      paid = true;
      await sleep(2000);
      const post = await getCredits(env.baseUrl, token).catch(() => ({ credits: '??' }));
      log.payment(`Credits replenished → ${post.credits}`);
      log.ok(`Request #${callNum} succeeded after payment: ${result}  (${ms} ms)`);
      log.divider();
    }

    if (!paid) {
      log.info(`#${callNum}  result=${result}  credits=${lastKnownCredits}  (${ms} ms)`);
    }

    if (paid) {
      log.step('Verifying: one more call after replenishment');
      const verify = await rpcCall(x402Fetch, env.baseUrl, env.network, env.rpcMethod);
      log.ok(`Result: ${verify.result}  (${verify.ms} ms)`);
      await sleep(1000);
      const final = await getCredits(env.baseUrl, token);
      log.ok(`Final credits: ${final.credits}`);
      break;
    }

    if (callNum > 500) {
      log.warn('Reached 500 calls without seeing 402. Stopping.');
      log.info('Your account may have too many credits. Try again after they drain.');
      break;
    }

    await sleep(CALL_DELAY);
  }

  // ── Summary ──────────────────────────────────────────────────
  log.banner('Demo complete');
  log.info('What happened:');
  log.info('  1. Authenticated with SIWE (no API key)');
  log.info('  2. Made JSON-RPC calls, consuming 1 credit each');
  log.info('  3. When credits hit 0 → HTTP 402 → auto-paid USDC');
  log.info('  4. Request retried and succeeded — seamless');
  log.info('  5. No signup, no subscription — just a wallet.');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  log.error(err.message);
  if (err.cause) log.error(`Cause: ${err.cause}`);
  process.exit(1);
});
