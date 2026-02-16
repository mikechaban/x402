// ─── Logging helpers ────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';
const MAGENTA = '\x1b[35m';

const ts = () => new Date().toISOString().slice(11, 23);

export const log = {
  step:    (msg) => console.log(`\n${BOLD}${CYAN}▸ ${msg}${RESET}`),
  info:    (msg) => console.log(`  ${DIM}${ts()}${RESET}  ${msg}`),
  ok:      (msg) => console.log(`  ${DIM}${ts()}${RESET}  ${GREEN}✔${RESET} ${msg}`),
  warn:    (msg) => console.log(`  ${DIM}${ts()}${RESET}  ${YELLOW}⚠${RESET} ${msg}`),
  error:   (msg) => console.log(`  ${DIM}${ts()}${RESET}  ${RED}✖${RESET} ${msg}`),
  payment: (msg) => console.log(`  ${DIM}${ts()}${RESET}  ${MAGENTA}💰${RESET} ${msg}`),
  banner:  (msg) => console.log(`\n${BOLD}${'═'.repeat(56)}${RESET}\n${BOLD}  ${msg}${RESET}\n${BOLD}${'═'.repeat(56)}${RESET}`),
  divider: ()    => console.log(`${DIM}${'─'.repeat(56)}${RESET}`),
};

/**
 * Time an async operation and return [result, elapsedMs].
 */
export async function timed(fn) {
  const start = performance.now();
  const result = await fn();
  return [result, Math.round(performance.now() - start)];
}

/**
 * Load and validate required env vars. Call after dotenv.config().
 */
export function loadEnv() {
  const baseUrl    = process.env.X402_BASE_URL || 'https://x402.quicknode.com';
  const network    = process.env.NETWORK_SLUG  || 'base-sepolia';
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  const rpcMethod  = process.env.RPC_METHOD    || 'eth_blockNumber';
  const chainLabel = process.env.CHAIN_LABEL   || network;
  const chainId    = parseInt(process.env.CHAIN_ID || '84532', 10);

  if (!privateKey) {
    log.error('WALLET_PRIVATE_KEY is not set. Copy .env.example → .env and add your key.');
    process.exit(1);
  }

  return { baseUrl, network, privateKey, rpcMethod, chainLabel, chainId };
}
