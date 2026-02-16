#!/usr/bin/env node
// ─── x402 QuickNode Demo ───────────────────────────────────────
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

  log.banner(`x402 QuickNode Demo  ·  ${env.chainLabel}  ·  mode=${mode}`);

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
  // trigger automatic USDC payment + retry. We detect the payment
  // event by monitoring credit balance changes.
  const x402Fetch = createX402Fetch(wallet, token, caip2);

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
  log.step(`Drain mode: looping ${env.rpcMethod} until 402 triggers`);
  log.info('Each successful response costs 1 credit.');
  log.divider();

  let callNum = 0;
  let paid = false;
  const creditsBefore = credits;

  while (true) {
    callNum++;

    // Check credits before each call so we can narrate the 402 moment
    const pre = await getCredits(env.baseUrl, token).catch(() => ({ credits: '??' }));

    if (typeof pre.credits === 'number' && pre.credits <= 1 && !paid) {
      log.divider();
      log.warn(`Credits about to hit zero (${pre.credits}). Next call will trigger 402…`);
      log.divider();
    }

    const creditsBefore402 = pre.credits;
    const { result, ms, status } = await rpcCall(x402Fetch, env.baseUrl, env.network, env.rpcMethod);

    // After the call, check credits again
    const post = await getCredits(env.baseUrl, token).catch(() => ({ credits: '??' }));

    // Detect the payment event: credits jumped up
    if (typeof post.credits === 'number' && typeof creditsBefore402 === 'number') {
      if (post.credits > creditsBefore402) {
        if (!paid) {
          log.divider();
          log.payment('Received HTTP 402 — Payment Required');
          log.payment('x402 auto-paid USDC → credits replenished!');
          log.payment(`Credits: ${creditsBefore402} → ${post.credits}`);
          log.ok(`Request #${callNum} retried and succeeded: ${result}  (${ms} ms)`);
          log.divider();
          paid = true;
        }
      }
    }

    if (!paid) {
      log.info(`#${callNum}  result=${result}  credits=${post.credits}  (${ms} ms)`);
    }

    // Once we've seen the payment cycle, do one more call to prove it works, then stop
    if (paid) {
      log.step('Verifying: one more call after replenishment');
      const verify = await rpcCall(x402Fetch, env.baseUrl, env.network, env.rpcMethod);
      log.ok(`Result: ${verify.result}  (${verify.ms} ms)`);
      const final = await getCredits(env.baseUrl, token);
      log.ok(`Final credits: ${final.credits}`);
      break;
    }

    // Safety valve — don't loop forever
    if (callNum > 200) {
      log.warn('Reached 200 calls without seeing 402. Stopping.');
      log.info('Your account may have too many credits. Try again after they drain.');
      break;
    }
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
