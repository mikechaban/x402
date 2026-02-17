# x402 Quicknode Demo

> **Pay-per-request blockchain RPC — no API keys, no accounts, just a wallet.**
>
> This demo proves the x402 flow: make JSON-RPC calls → credits drain → HTTP 402 fires → client auto-pays USDC → request retries and succeeds. All with a single wallet private key on Base Sepolia testnet.

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env — add your WALLET_PRIVATE_KEY (any testnet key works)

# 3. Get free testnet USDC
npm run drip

# 4. Run single call (dry run)
npm run demo:once

# 5. Run full demo — drain credits → 402 → auto-pay → retry
npm run demo:drain

# 6. Or launch the web UI
npm run dev
# Open http://localhost:3402
```

---

## What It Proves

| Step | What Happens |
|------|-------------|
| **1. Auth** | SIWE message signed with wallet → JWT (no API key) |
| **2. RPC** | `eth_blockNumber` on Base Sepolia — 1 credit per call |
| **3. Drain** | Loop calls until credits = 0 |
| **4. 402** | Server returns HTTP 402 Payment Required |
| **5. Pay** | `@x402/fetch` auto-signs USDC payment on Base Sepolia |
| **6. Retry** | Request retries and succeeds — credits replenished |

No signup. No subscription. No API keys. Just a wallet.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WALLET_PRIVATE_KEY` | **Yes** | — | Hex private key (e.g. `0xabc…`) |
| `X402_BASE_URL` | No | `https://x402.quicknode.com` | x402 service URL |
| `NETWORK_SLUG` | No | `base-sepolia` | Target network |
| `CHAIN_ID` | No | `84532` | Chain ID for SIWE |
| `RPC_METHOD` | No | `eth_blockNumber` | JSON-RPC method to call |
| `CHAIN_LABEL` | No | Same as `NETWORK_SLUG` | Display name for logs |

---

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm start` | `node src/demo.js` | Full drain demo |
| `npm run demo:once` | `node src/demo.js --once` | Single RPC call |
| `npm run demo:drain` | `node src/demo.js --drain` | Drain credits → 402 → pay → retry |
| `npm run credits` | `node src/credits.js` | Check credit balance |
| `npm run drip` | `node src/credits.js --drip` | Request free testnet USDC |
| `npm run dev` | `node src/server.js` | Web UI on http://localhost:3402 |

---

## Expected Output

### `demo:once`

```
════════════════════════════════════════════════════════
  x402 Quicknode Demo  ·  base-sepolia  ·  mode=once
════════════════════════════════════════════════════════

▸ Authenticating with SIWE
  12:00:01.234  Wallet: 0x1234…abcd
  12:00:01.235  Chain:  84532
  12:00:01.300  SIWE message signed
  12:00:01.650  ✔ JWT obtained in 350 ms

▸ Checking credits
  12:00:01.800  Credits: 95  (150 ms)

▸ Single RPC call: eth_blockNumber
  12:00:02.000  → POST /base-sepolia  method=eth_blockNumber
  12:00:02.200  ✔ Result: 0x1a2b3c  (200 ms)

▸ Credits after call
  12:00:02.350  Credits: 94  (150 ms)

════════════════════════════════════════════════════════
  Done — single call completed
════════════════════════════════════════════════════════
```

### `demo:drain`

```
▸ Drain mode: looping eth_blockNumber until 402 triggers
  ...
  #93  result=0x1a2b40  credits=2  (180 ms)
  #94  result=0x1a2b40  credits=1  (175 ms)
────────────────────────────────────────────────────────
  ⚠ Credits about to hit zero (1). Next call will trigger 402…
────────────────────────────────────────────────────────
  💰 Received HTTP 402 — Payment Required
  💰 x402 auto-paid USDC → credits replenished!
  💰 Credits: 0 → 100
  ✔ Request #95 retried and succeeded: 0x1a2b41  (800 ms)
────────────────────────────────────────────────────────

▸ Verifying: one more call after replenishment
  ✔ Result: 0x1a2b41  (170 ms)
  ✔ Final credits: 99

════════════════════════════════════════════════════════
  Demo complete
════════════════════════════════════════════════════════
```

---

## Generating a Test Wallet

No existing wallet needed:

```bash
node -e "
import { generatePrivateKey } from 'viem/accounts';
console.log(generatePrivateKey());
"
```

Copy the output into your `.env` as `WALLET_PRIVATE_KEY`.

---

## Architecture

```
src/
  auth.js      SIWE sign-in → JWT token
  rpc.js       x402-wrapped JSON-RPC caller
  credits.js   GET /credits + POST /drip
  demo.js      Main demo flow (--once / --drain)
  server.js    HTTP server for the web UI
  util.js      Logging, env loading, timing helpers
public/
  index.html   Single-page UI
  style.css    Dark theme, monospace, minimal
  app.js       SSE client, button handlers, flow diagram
```

All files are ESM. Zero build step. Zero frontend dependencies. Pure Node.js ≥ 18.

---

## Web UI

Run `npm run dev` and open http://localhost:3402. The UI provides:

- **Login** — authenticates via SIWE, shows wallet address
- **Drip USDC** — requests free testnet USDC
- **Single RPC Call** — one `eth_blockNumber`, shows result + credits
- **Drain → 402 → Pay** — loops until 402 fires, auto-pays, retries
- **Flow diagram** — lights up each step (Auth → RPC → 402 → Pay → Retry)
- **Live timeline** — real-time SSE log with color-coded entries

The server uses Node's built-in `http` module — no Express, no frameworks.

---

## Troubleshooting

### Invalid JWT / 401 errors
- JWTs expire after 1 hour. Re-run the demo to get a fresh one.
- Ensure `X402_BASE_URL` and `CHAIN_ID` match (84532 for testnet).

### Wallet not funded / drip failed
- Run `npm run drip` first. It's one-time per account on Base Sepolia.
- If already used, you already have USDC. Check credits with `npm run credits`.
- Wait ~10 seconds after drip for the USDC to confirm on-chain.

### 402 not triggering
- You still have credits. Run `npm run credits` to check.
- In drain mode, the demo loops until credits are exhausted.
- Testnet accounts have a 10,000 credit lifetime cap.

### Network slug mismatch
- Use slugs from the [supported networks list](https://x402.quicknode.com).
- Common: `base-sepolia`, `ethereum-mainnet`, `base-mainnet`.
- Set `NETWORK_SLUG` in `.env` and matching `CHAIN_ID`.

### RPC errors
- Some methods require parameters. Default `eth_blockNumber` needs none.
- Set `RPC_METHOD` in `.env` to try other methods.

---

## License

MIT
