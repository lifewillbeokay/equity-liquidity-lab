# KyberSwap benchmark — AAPL and MSFT

Measured 2026-11-15T22:19:50.044Z through 2026-11-15T22:37:09.264Z.

**Decision: keep direct DEX quoting in production.** The public KyberSwap endpoint did not meet the requested speed and coverage condition. It returned useful additional routes, but the complete sweeps were slower and incomplete under sustained sampling. No KyberSwap production adapter was enabled, and the deployed Site was left unchanged. This commit saves the benchmark, validation checks, and results.

## Cold sweep results

| Stock | Direct DEXs | KyberSwap | Kyber/direct time | Direct standard quotes | Kyber standard quotes | Existing direct quotes recovered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AAPL | 199.8s | 453.7s | 2.27× | 335/350 | 264/350 | 252/335 |
| MSFT | 85.1s | 283.0s | 3.32× | 200/250 | 190/250 | 152/200 |

Each standard-quote denominator is 25 order sizes × two sides × the tested token/settlement profiles. “Recovered” compares exactly the same profile, direction, and input: extra Kyber quotes do not hide missing existing quotes. The sweeps also include $10 probes and the direct engine’s adaptive sizes. The aggregate recovery was **404/535 (75.5%)**.

The main sweeps requested **859 distinct inputs** and made **1549 HTTP attempts**, of which **900 returned HTTP 429**. The scheduler targeted one start every 350 ms (2.86 requests/second), with up to three in flight and up to two retries. An audit found one brief four-start rolling-second window in each sweep because timers caught up after a delay. Rate limiting began minutes before either window. The supplied benchmark now serializes start permits to prevent that catch-up behavior; the separate strict control below checks the conclusion without bursts. A 429 response sometimes carried the message “Forbidden”; it was classified by its HTTP status as rate limiting, not missing liquidity.

Successful HTTP 200 calls had median latency of 310 ms for AAPL and 296 ms for MSFT. Those values exclude queueing and backoff; they are not full refresh times.

## Slower-rate control

After the main run, a separate control requested one $10k buy and sell for every tested profile, scheduled 1100 ms apart, with no retries. It returned **24/24 validated previews**, with HTTP counts `{'200': 24}`. This is a small connectivity/rate control, not a second full-curve benchmark. It does not establish a guaranteed production quota.

A further control used a strict sequential scheduler targeting 400 ms between starts. It observed a minimum gap of 399 ms and at most 3 starts in any rolling second. It still returned only **19/24 validated previews**, with HTTP counts `{'200': 19, '429': 5}`. This confirms throttling at or below three starts per second in this environment, independently of the original sweeps’ two timing bursts.

## Per-profile results

| Profile | Direct time | Kyber time | Direct standard | Kyber standard | Standard samples still rate limited |
| --- | ---: | ---: | ---: | ---: | ---: |
| AAPL · Ondo · ethereum | 3.9s | 64.0s | 50/50 | 37/50 | 13 |
| AAPL · xStocks · ethereum | 1.7s | 62.4s | 50/50 | 38/50 | 12 |
| AAPL · Coinbase · base | 15.4s | 70.3s | 50/50 | 39/50 | 11 |
| AAPL · bStocks · bsc | 24.9s | 65.2s | 50/50 | 38/50 | 12 |
| AAPL · Ondo · bsc | 73.0s | 71.7s | 50/50 | 36/50 | 14 |
| AAPL · Robinhood · robinhood | 140.1s | 66.4s | 50/50 | 40/50 | 10 |
| AAPL · Ondo · robinhood | 59.7s | 70.1s | 35/50 | 36/50 | 14 |
| MSFT · Ondo · ethereum | 2.0s | 45.7s | 0/50 | 38/50 | 12 |
| MSFT · bStocks · bsc | 7.0s | 66.9s | 50/50 | 40/50 | 10 |
| MSFT · Ondo · bsc | 1.8s | 50.3s | 50/50 | 35/50 | 15 |
| MSFT · Coinbase · base | 10.4s | 59.0s | 50/50 | 39/50 | 11 |
| MSFT · Robinhood · robinhood | 85.0s | 69.6s | 50/50 | 38/50 | 12 |

Profile intervals include their assigned queueing/retries and may overlap at profile boundaries. Whole-stock timings above are measured wall time, not a sum of profile intervals.

## Method and limits

- Direct engine: commit `7ade1f62e54460579a8e7fbb10041ec3ff4319ab`, using the existing registry, route verification, share normalization, block pinning, and refinement logic. Chains ran concurrently; profiles on each chain ran sequentially, matching the dashboard scheduler.
- Environment: local macOS, Node.js v23.11.0. No application curve or pool-read cache was used. Upstream services may maintain their own caches. The public endpoint failed the local gate, so it was not installed on the production Worker for a hosting benchmark.
- Coverage: AAPL’s seven and MSFT’s five profiles with registered direct routes across Ethereum, Base, BNB, and Robinhood. The direct MSFT/Ondo Ethereum profile produced no complete quotes during this run. All other in-scope EVM deployments received separate $100/$1k/$10k buy discovery probes; those probes are outside the sweep timings and do not establish sell-side coverage. Solana/Jupiter remained excluded.
- Kyber endpoint: `GET https://aggregator-api.kyberswap.com/{chain}/api/v1/routes`, with `x-client-id: equity-liquidity-lab`, `gasInclude=false`, and `excludeRFQSources=true`. No API key, wallet, route building, or transaction submission was used.
- Comparisons used the exact same token contracts and raw input amounts. Stock references and share conversion factors came from the fresh direct captures. Kyber sweep times exclude fetching that normalization again and use already-known adaptive sizes, which favors Kyber in this comparison.
- Provider responses were checked for token/input identity, positive output, full input/output reconciliation across the route flow graph, zero unconsumed input on selected edges, and balanced intermediate tokens. Route groups can split and merge; they are not necessarily separate linear paths. This establishes consistency of a provider estimate, not actual wallet execution.
- Direct quotes were pinned to a block; Kyber returned latest-state estimates later in the run. Output differences are diagnostic and are not a same-block best-execution guarantee. “Quote available” can include poor prices outside the chart’s impact band.
- An individual successful request is fast, but each amount and direction needs its own request. Reducing samples or interpolating quotes would change the requested chart methodology.

## What would justify another integration trial

Kyber found additional routes, including MSFT/Ondo on Ethereum and AAPL/xStocks deployments missing from the direct inventory. A key-backed gateway with enough sustained capacity is worth retesting. Its speed, quota, and coverage have **not** been measured here. A later trial should pass complete-curve coverage, normalized-output checks, and cold/warm hosting measurements before changing the production provider.

Kyber’s official [rate-limit and authentication documentation](https://docs.kyberswap.com/developer-guide/start-here/rate-limits-and-client-id) states the public rate and directs higher-capacity integrations to its API-key gateway. The [EVM route API specification](https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps) documents the chain paths, quote parameters, and responses. Checked November 15, 2026.

## Reproduce

From the repository root, after installing dependencies:

```sh
node --import tsx scripts/benchmark-kyber.mjs work/kyber-run.json
node scripts/kyber-rate-control.mjs work/kyber-run.json work/kyber-control.json
node scripts/kyber-rate-control.mjs work/kyber-run.json work/kyber-strict-control.json 400
node --import tsx scripts/summarize-kyber-benchmark.mjs work/kyber-run.json work/kyber-summary.json work/kyber-control.json work/kyber-strict-control.json
node --import tsx --test tests/kyber-evidence.test.ts
```

Run the control only after the main benchmark completes. Results will change with market state, RPC conditions, and provider limits. [Machine-readable summary](kyberswap-2026-11-15.json) includes per-sample outcomes, exact contracts, per-profile blocks, HTTP counts, output differences, and the control observations.
