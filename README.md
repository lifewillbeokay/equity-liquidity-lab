# Equity Liquidity Lab

A tokenized-equity liquidity dashboard that compares issuer equivalents of the same stock using read-only buy and sell simulations.

**Live dashboard:** https://apple-liquidity-lab.jersey.chatgpt.site (owner-private)

## Coverage

- **Equities:** AAPL, NVDA, GOOGL, MU, SPCX, META, MSFT, and TSLA.
- **Issuers:** Coinbase, Ondo, xStocks, bStocks, and Robinhood.
- **Chains:** Ethereum, Robinhood Chain, Base, Solana, and BNB Chain.
- **Routes:** Verified routes on Uniswap, Aero/Aerodrome, PancakeSwap, Metric, and other supported venues in the registry. Coverage varies by asset and chain.
- **Sampling:** 25 base order sizes per side, from $100 to $100,000, plus up to 12 adaptive samples per side near liquidity cliffs and impact thresholds.

Jupiter is excluded. Solana listings remain visible, but direct Solana DEX quoting is not currently integrated.

The dashboard selects the best observed full-input quote for each issuer and order size across covered chains and venues. It normalizes tokens to underlying share exposure and displays mirrored step charts, hover details, route comparisons, and an auditable JSON export. The order-size dropdown contains only the 25 standard sizes; adaptive samples remain in the charts and tooltips.

## Run locally

Use Node.js 22.13 or newer.

```sh
npm run install:ci
npm run build
```

On a fresh local database, apply the initial migration once:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_fresh_ego.sql
```

Then start the development server:

```sh
npm run dev
```

Use the URL printed by the server. To preview the built Cloudflare Worker with local D1 and R2 instead, run `npm start`.

Local database and object storage live under the ignored `.wrangler/` directory. Apply future migrations in order; do not replay migrations already applied to the same database.

## Verify

```sh
npx tsc --noEmit
node --import tsx --test tests/*.test.ts
npm run build
```

The test suite covers exact pool math, local/contract parity checks, missing-state fallback, normalization, full-input fills, route selection, adaptive sampling, snapshot consistency, shared refresh leases, cache expiry, and reorg handling.

## Data and caching

- Contract simulations pin their reads to a block and verify canonicality before accepting a capture. Metric API depth carries a separate provider timestamp.
- Uniswap V3, PancakeSwap V2/V3 and legacy Aerodrome Slipstream can calculate standard and adaptive orders locally from cached pool state, using exact integer arithmetic. Read batches use Multicall3 on Ethereum, Base and BNB. Unsupported/dynamic pools and state beyond the bounded tick scan retain contract quoting.
- Local paths check token balances and agree with same-block contract quotes at the ends of their sampled input range. A failed check discards the tentative profile and recollects it using contract quotes. Pool-state simulations are labelled separately; they are not wallet execution tests.
- Metric batch depth estimates calculate all standard and adaptive sizes locally from one API snapshot. R2 shares healthy depth for 15 seconds, while preserving `serverTs`; snapshots older than 60 seconds at preparation are rejected. Unsupported, unhealthy, incomplete or failed estimates fall back to contract quotes. A changed share multiplier discards the API capture. Estimates are labeled in the ladder, tooltips and route details.
- D1 stores curve metadata, refresh leases, market references, and successful RPC reads keyed by chain, block hash, and complete call parameters.
- R2 stores full computed curves and their quote evidence. Successful curves are reused for up to two minutes; unavailable results have a shorter 30-second lifetime.
- Simultaneous refreshes share one capture. Failed refreshes preserve available prior quotes with their original timestamps.
- Server calculation has a bounded state-read and swap-step budget. Larger captures hand off with the same shared refresh lease to the browser, which computes and stores the completed curve centrally.
- When server RPC access fails, the browser can collect and save a validated capture. Such captures are explicitly marked as browser-origin data.
- The page loads saved captures from the shared cache; a cold capture still depends on public RPC availability. The displayed range spans the oldest and newest saved profiles for a stock, including older captures retained after failed or incomplete refreshes.

The committed snapshots in `lib/data/` provide the initial dated view and test fixtures. They are not live prices. Shared production cache contents are runtime data and are not stored in Git.

The [local pool-state benchmark](docs/benchmarks/local-pools-2026-11-15.md) records same-block numerical checks, RPC request counts and observed refresh times. Local calculation reduces repeated quoting, but whole-stock refreshes still depend on unsupported routes and public RPC limits.

The [Metric depth benchmark](docs/benchmarks/metric-depth-2026-11-16.md) records the public batch API, conservative accuracy checks, coverage failures, and end-to-end timings.

## Aggregator benchmark

The [AAPL/MSFT KyberSwap benchmark](docs/benchmarks/kyberswap-2026-11-15.md) compares complete cold sweeps using identical inputs. The public endpoint was slower and lost samples to rate limiting, so KyberSwap is not used in production. The report includes per-profile coverage, a slower-rate control, machine-readable results, and commands to reproduce the test. A higher-capacity API-key gateway has not been benchmarked.

## Source map

| Path | Purpose |
| --- | --- |
| `app/page.tsx`, `app/globals.css` | Dashboard, depth charts, filters, and route explorer |
| `app/api/` | Reference, simulation, shared-capture, and export endpoints |
| `lib/registry.ts`, `lib/data/` | Issuer deployments, supported routes, and seed captures |
| `lib/simulator.ts` | EVM quote adapters, local/contract orchestration and share normalization |
| `lib/local-pools.ts`, `lib/v3-math.ts` | Bounded pool snapshots and exact local AMM math |
| `lib/metric-depth.ts`, `lib/metric-engine.ts`, `lib/metric-cache.ts` | Conservative Metric depth math, route integration, and shared API snapshots |
| `lib/sampling.ts` | Base ladder and adaptive refinement |
| `lib/market.ts`, `lib/view.ts` | Cross-chain ranking and depth presentation |
| `lib/shared-cache.ts`, `lib/pool-read-cache.ts` | Persistent curve and block-pinned RPC caching |
| `lib/server/cache-service.ts`, `lib/refresh-client.ts` | Server collection, shared refreshes, and browser fallback |
| `db/schema.ts`, `drizzle/` | D1 schema and versioned migrations |
| `tests/` | Simulation and cache regression tests |

## Deployment

The app uses React, TypeScript, Vinext/Vite, viem, Cloudflare Workers, D1, and R2. The existing ChatGPT Site is identified by `.openai/hosting.json`; that file contains the Site ID and logical storage bindings, not credentials.

Deployments use the Sites publishing workflow. A push to this GitHub repository alone does **not** publish the dashboard. Preserve the existing Site audience unless intentionally changing access.

See [the runtime reference](docs/starter-runtime.md) for additional local-development, authentication, and hosting details. Secrets, dependencies, build output, and local runtime state are excluded by `.gitignore`.

## Interpretation

These are simulated execution curves, not exchange order books. Steps connect tested sizes without inventing intermediate quotes; $100,000 is a testing cap, not a measured liquidity ceiling. Liquidity is never summed across chains or wrappers. Gas, bridging costs, wallet eligibility, approvals, and settlement are outside the simulation. USD stablecoins are assumed to be worth $1, and stock reference prices carry their own timestamps.
