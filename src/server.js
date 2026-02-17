#!/usr/bin/env node
// ─── Tiny HTTP server for the x402 demo frontend ───────────────
// No frameworks. Uses Node built-in http + fs. Serves static files
// from public/ and exposes JSON API endpoints that call our modules.
// SSE stream pushes timeline events to the browser in real time.
// ────────────────────────────────────────────────────────────────
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './util.js';
import { createWallet, authenticate } from './auth.js';
import { createX402Fetch, rpcCall } from './rpc.js';
import { getCredits, requestDrip } from './credits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = parseInt(process.env.PORT || '3402', 10);

const CAIP2_MAP = { 84532: 'eip155:84532', 8453: 'eip155:8453' };
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── Shared state (single-user demo) ────────────────────────────
let env, wallet, token, expiresAt, accountId, x402Fetch, caip2;
let sseClients = [];     // connected SSE listeners
let drainAbort = null;   // AbortController for cancelling drain
let saw402 = false;      // set by the 402-intercept hook
let sawRetry = false;    // set by the payment-retry hook

// ── SSE helpers ────────────────────────────────────────────────
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter((res) => {
    try { res.write(payload); return true; } catch { return false; }
  });
}
function emit(type, text, extra = {}) {
  broadcast('log', { type, text, ts: new Date().toISOString(), ...extra });
}

// ── API handlers ───────────────────────────────────────────────
async function handleLogin(_req, res) {
  try {
    env = loadEnv();
    caip2 = CAIP2_MAP[env.chainId] || 'eip155:84532';
    wallet = createWallet(env.privateKey, env.chainId);

    emit('step', 'Signing SIWE message…');
    const auth = await authenticate(wallet, env.baseUrl, env.chainId);
    token = auth.token;
    expiresAt = auth.expiresAt;
    accountId = auth.accountId;

    // Build x402 fetch with hooks to detect the 402 → pay → retry cycle
    x402Fetch = createX402Fetch(wallet, token, caip2, {
      on402: () => {
        saw402 = true;
        emit('payment', 'HTTP 402 — Payment Required');
        emit('payment', 'Auto-signing USDC payment…');
      },
      onPaymentRetry: () => {
        sawRetry = true;
        emit('payment', 'Retrying request with payment…');
      },
    });

    emit('ok', `Authenticated — ${wallet.account.address.slice(0, 6)}…${wallet.account.address.slice(-4)}`);
    json(res, { address: wallet.account.address, accountId, expiresAt });
  } catch (err) {
    emit('error', err.message);
    json(res, { error: err.message }, 500);
  }
}

async function handleCredits(_req, res) {
  try {
    requireAuth(res);
    const data = await getCredits(env.baseUrl, token);
    emit('info', `Credits: ${data.credits}`);
    json(res, data);
  } catch (err) {
    emit('error', err.message);
    json(res, { error: err.message }, 500);
  }
}

async function handleDrip(_req, res) {
  try {
    requireAuth(res);
    emit('step', 'Requesting testnet USDC…');
    const data = await requestDrip(env.baseUrl, token);
    emit('ok', `Faucet tx: ${data.transactionHash?.slice(0, 14)}…`);
    json(res, data);
  } catch (err) {
    emit('error', err.message);
    json(res, { error: err.message }, 500);
  }
}

async function handleRpcOnce(_req, res) {
  try {
    requireAuth(res);
    saw402 = false;
    sawRetry = false;
    emit('step', `RPC → ${env.rpcMethod} on ${env.network}`);
    const result = await rpcCall(x402Fetch, env.baseUrl, env.network, env.rpcMethod);

    if (saw402) {
      const creds = await getCredits(env.baseUrl, token);
      emit('payment', `Credits replenished → ${creds.credits}`);
      emit('ok', `Result (after auto-pay): ${result.result}  (${result.ms} ms)`);
      json(res, { ...result, credits: creds.credits, paid: true });
    } else {
      emit('ok', `Result: ${result.result}  (${result.ms} ms)`);
      const creds = await getCredits(env.baseUrl, token);
      emit('info', `Credits remaining: ${creds.credits}`);
      json(res, { ...result, credits: creds.credits });
    }
  } catch (err) {
    emit('error', err.message);
    json(res, { error: err.message }, 500);
  }
}

async function handleDrain(_req, res) {
  try {
    requireAuth(res);
    // Respond immediately — progress streams via SSE
    json(res, { status: 'started' });

    drainAbort = new AbortController();
    const signal = drainAbort.signal;

    // Reset detection flags
    saw402 = false;
    sawRetry = false;

    // Check initial credits once to show starting point
    const initial = await getCredits(env.baseUrl, token).catch(() => ({ credits: '??' }));
    let lastKnownCredits = initial.credits;
    emit('step', `Drain mode — ${lastKnownCredits} credits to burn (${env.rpcMethod})`);
    let callNum = 0;
    let paid = false;

    // Throttle: check credits every N calls to avoid rate-limiting /credits (50/10s)
    const CREDITS_CHECK_INTERVAL = 10;
    // Delay between RPC calls (ms) to stay within rate limits
    const CALL_DELAY = 250;

    while (!signal.aborted) {
      callNum++;

      // Only check credits periodically, not every call
      if (callNum % CREDITS_CHECK_INTERVAL === 0) {
        const pre = await getCredits(env.baseUrl, token).catch(() => null);
        if (pre) lastKnownCredits = pre.credits;
      } else {
        // Estimate: decrement by 1 per successful call
        if (typeof lastKnownCredits === 'number') lastKnownCredits--;
      }

      if (typeof lastKnownCredits === 'number' && lastKnownCredits <= 3 && !paid) {
        // About to hit zero — check for real to be precise
        const precise = await getCredits(env.baseUrl, token).catch(() => null);
        if (precise) lastKnownCredits = precise.credits;
        emit('warn', `Credits low (${lastKnownCredits}). 402 imminent…`);
      }

      // Reset per-call flags so we detect fresh 402 on this call
      saw402 = false;
      sawRetry = false;

      // This call may trigger 402 internally — the hooks will fire
      const result = await rpcCall(x402Fetch, env.baseUrl, env.network, env.rpcMethod);

      // If our hooks fired, we know the 402 → pay → retry cycle happened
      if (saw402 && !paid) {
        paid = true;
        // Brief pause before checking credits so the server has settled
        await sleep(2000);
        const post = await getCredits(env.baseUrl, token).catch(() => ({ credits: '??' }));
        emit('payment', `Credits replenished → ${post.credits}`);
        emit('ok', `Request #${callNum} succeeded after payment: ${result.result}  (${result.ms} ms)`);
      }

      if (!paid) {
        emit('info', `#${callNum}  result=${result.result}  credits=${lastKnownCredits}  (${result.ms} ms)`);
      }

      if (paid) {
        // One more verification call
        emit('step', 'Verifying: one more call after replenishment');
        const verify = await rpcCall(x402Fetch, env.baseUrl, env.network, env.rpcMethod);
        await sleep(1000);
        const final = await getCredits(env.baseUrl, token);
        emit('ok', `Verified: ${verify.result}  (${verify.ms} ms)  —  Credits: ${final.credits}`);
        emit('done', 'Demo complete — 402 → pay → retry cycle proven');
        break;
      }

      if (callNum > 500) {
        emit('warn', 'Reached 500 calls without seeing 402. Stopping.');
        break;
      }

      // Throttle to avoid rate limits
      await sleep(CALL_DELAY);
    }
    drainAbort = null;
  } catch (err) {
    emit('error', err.message);
    drainAbort = null;
  }
}

function handleStop(_req, res) {
  if (drainAbort) { drainAbort.abort(); emit('warn', 'Drain stopped by user'); }
  json(res, { stopped: true });
}

// ── Helpers ────────────────────────────────────────────────────
function requireAuth(res) {
  if (!token) throw new Error('Not authenticated — click Login first');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

// ── Router ─────────────────────────────────────────────────────
const routes = {
  'POST /api/login':   handleLogin,
  'POST /api/credits': handleCredits,
  'POST /api/drip':    handleDrip,
  'POST /api/rpc':     handleRpcOnce,
  'POST /api/drain':   handleDrain,
  'POST /api/stop':    handleStop,
};

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // SSE stream
  if (req.method === 'GET' && req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter((c) => c !== res);
    });
    return;
  }

  // API routes
  const key = `${req.method} ${req.url}`;
  if (routes[key]) return routes[key](req, res);

  // Static files
  let filePath = path.join(PUBLIC, req.url === '/' ? 'index.html' : req.url);
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    const ext = path.extname(filePath);
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  x402 Demo UI → http://localhost:${PORT}\n`);
});
