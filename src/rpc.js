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
 * @returns {typeof fetch}
 */
export function createX402Fetch(walletClient, token, caip2 = 'eip155:84532') {
  // EVM signer for x402 payment signatures
  const evmSigner = toClientEvmSigner({
    address:       walletClient.account.address,
    signTypedData: (params) => walletClient.signTypedData(params),
  });

  const client = new x402Client()
    .register(caip2, new ExactEvmScheme(evmSigner));

  // Inner fetch that always sets the Authorization header.
  // IMPORTANT: @x402/fetch passes a Request object (not url+init) on payment
  // retries, so we must handle both calling conventions.
  const authedFetch = async (input, init) => {
    if (input instanceof Request) {
      const req = new Request(input, { headers: new Headers(input.headers) });
      req.headers.set('Authorization', `Bearer ${token}`);
      return fetch(req);
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };

  return wrapFetchWithPayment(authedFetch, client);
}

/**
 * Make a single JSON-RPC call via x402.
 *
 * @returns {{ result: any, ms: number, status: number }}
 */
export async function rpcCall(x402Fetch, baseUrl, network, method, params = []) {
  const url = `${baseUrl}/${network}`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });

  log.info(`→ POST /${network}  method=${method}`);

  const [res, ms] = await timed(() =>
    x402Fetch(url, {
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
