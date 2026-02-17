// ─── x402-wrapped JSON-RPC caller ───────────────────────────────
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { log, timed } from './util.js';

/**
 * Build an x402-enabled fetch function that:
 *  - Attaches the JWT on every request (including payment retries)
 *  - Automatically signs USDC payments when HTTP 402 is received
 *
 * @param {import('viem').WalletClient} walletClient
 * @param {string} token  JWT from /auth
 * @param {string} caip2  e.g. "eip155:84532"
 * @param {{ on402?: () => void, onPaymentRetry?: () => void }} hooks
 *        Optional callbacks so callers can observe the 402 → pay → retry cycle.
 *        `on402` fires when the inner fetch first sees HTTP 402.
 *        `onPaymentRetry` fires when @x402/fetch retries with a payment header.
 * @returns {{ fetch: typeof fetch, resetPaymentState: () => void }}
 */
export function createX402Fetch(walletClient, token, caip2 = 'eip155:84532', hooks = {}) {
  // EVM signer for x402 payment signatures
  const evmSigner = toClientEvmSigner({
    address:       walletClient.account.address,
    signTypedData: (params) => walletClient.signTypedData(params),
  });

  const client = new x402Client()
    .register(caip2, new ExactEvmScheme(evmSigner));

  // Track whether we've already fired the on402 hook for this payment cycle
  let firedOn402 = false;

  // Inner fetch that always sets the Authorization header.
  // IMPORTANT: @x402/fetch passes a Request object (not url+init) on payment
  // retries, so we must handle both calling conventions.
  const authedFetch = async (input, init) => {
    // Detect if this is the payment-retry attempt (has payment header)
    const hasPaymentHeader = (() => {
      if (input instanceof Request) {
        return input.headers.has('X-PAYMENT') || input.headers.has('PAYMENT-SIGNATURE');
      }
      const h = init?.headers;
      if (h instanceof Headers) return h.has('X-PAYMENT') || h.has('PAYMENT-SIGNATURE');
      if (h && typeof h === 'object') return 'X-PAYMENT' in h || 'PAYMENT-SIGNATURE' in h;
      return false;
    })();

    if (hasPaymentHeader) {
      hooks.onPaymentRetry?.();
    }

    let res;
    if (input instanceof Request) {
      const req = new Request(input, { headers: new Headers(input.headers) });
      req.headers.set('Authorization', `Bearer ${token}`);
      res = await fetch(req);
    } else {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      res = await fetch(input, { ...init, headers });
    }

    // Detect 402 — fire once per payment cycle
    if (res.status === 402 && !firedOn402) {
      firedOn402 = true;
      hooks.on402?.();
    }

    return res;
  };

  const wrappedFetch = wrapFetchWithPayment(authedFetch, client);

  return {
    fetch: wrappedFetch,
    /** Reset the per-cycle 402 flag. Call before each top-level rpcCall. */
    resetPaymentState() { firedOn402 = false; },
  };
}

/**
 * Make a single JSON-RPC call via x402.
 *
 * @param {typeof fetch | { fetch: typeof fetch, resetPaymentState: () => void }} x402Fetch
 * @returns {{ result: any, ms: number, status: number }}
 */
export async function rpcCall(x402Fetch, baseUrl, network, method, params = []) {
  // Support both the raw fetch and the { fetch, resetPaymentState } object
  const doFetch = typeof x402Fetch === 'function' ? x402Fetch : x402Fetch.fetch;
  if (typeof x402Fetch !== 'function' && x402Fetch.resetPaymentState) {
    x402Fetch.resetPaymentState();
  }

  const url = `${baseUrl}/${network}`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });

  log.info(`→ POST /${network}  method=${method}`);

  const [res, ms] = await timed(() =>
    doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  );

  const data = await res.json();

  if (data.error) {
    log.warn(`RPC error: ${JSON.stringify(data.error)}`);
    return { result: null, ms, status: res.status, error: data.error };
  }

  return { result: data.result, ms, status: res.status };
}
