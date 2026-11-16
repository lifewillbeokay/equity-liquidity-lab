# Metric batch-depth benchmark — November 16, 2026 UTC

Metric's public batch-depth endpoint is now an optional estimate source for verified Metric routes. It does not replace other DEXs or require an API key. The strongest observed improvement was Robinhood-issued AAPL: 136.9 seconds versus 199.3 seconds for the full profile (31.3% faster in this single run). Other pools frequently had unhealthy feeds or insufficient depth, so they retained contract quotes.

## Observed end-to-end results

Local Node.js, public RPCs; identical pinned contract blocks and references across modes. Exact local AMM calculation was disabled in both modes to isolate the Metric adapter. Each profile collected 25 standard sizes per side, two $10 probes, and up to 12 adaptive sizes per side. These are sequential single runs, not controlled latency distributions or hosted-Worker timings. RPC throttling affected the results.

| Profile | Metric-enabled | Contract-only | API batch | Estimated winning points | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| AAPL / Robinhood | 136.9s | 199.3s | 189ms | 67 of 74 | 79 Metric leaf calculations replaced calls; 72 comparable non-probe candidates verified |
| AAPL / bStocks, BNB | 29.0s | 39.6s | 316ms | 0 | Main feed down; another healthy pool had zero usable depth. Timing difference is not attributable to Metric |
| AAPL / Ondo, Robinhood composite | 331.2s | 649.4s | 349ms | See JSON | Contract comparison returned unavailable; excluded from accuracy and speed claims |
| MSFT / Robinhood | 105.7s | 168.3s | 1,055ms | 0 | Metric feed down; all quotes used fallback. Timing difference is not attributable to Metric |

No verified AAPL/MSFT Metric pool matched the configured issuer addresses on Ethereum. Metric's API does not currently list Base or Solana. This does not change the dashboard's five-chain coverage or its other quote sources.

## Accuracy and interpretation

All 72 comparable Robinhood AAPL Metric candidate outputs were slightly lower than their corresponding contract outputs, as expected for the documented conservative estimator. The largest absolute difference was **0.0001983 basis points** (0.000001983%). All 72 also had full contract fills. API snapshots have their own `serverTs`; they are not pinned to the comparison block. Therefore these observations establish close agreement in this capture, not unit-exact parity or an execution guarantee.

The implementation also reproduces Metric's official 5-WETH example exactly: 13,535,754,492 raw USDC. Tests cover curved asks, bin boundaries, exhausted depth, one-sided sentinels, stale timestamps, malformed cumulative volumes, multihop propagation, and a changing/non-unit share multiplier. The dashboard still computes impact against its own same-side $10 average-price probe, not the API's marginal `priceImpactE6`.

A built local-Worker endpoint check took 666ms for a cold depth request and 10ms for the immediate shared-cache hit, with identical `serverTs`. This measures the depth endpoint only, not a full profile refresh.

## Caching and fallback

- One batch supplies the registered Metric leaf pools in a profile; every size and refinement reuses that frozen depth.
- Healthy API snapshots are shared in R2 for 15 seconds. Preparation rejects snapshots older than 60 seconds. Original provider timestamps are retained.
- Completed-curve expiry accounts for Metric snapshots used by probes and venue-only views, not just the all-DEX winners. A long capture can already be expired when completed; it is retained as dated evidence without a fresh TTL.
- Missing, down, malformed, stale, closed-side or insufficient-depth results retain contract quoting. Partial fills never win.
- A share-conversion check after collection discards API estimates if the factor changed or cannot be verified.
- Canonical factory/token checks remain mandatory. A discovery refresh found one additional healthy BNB AAPL pool, but it had no usable depth during the benchmark. Newly discovered routes do not imply available liquidity.
- Estimates are labeled in chart tooltips, the order ladder and route details. Other stocks' existing verified Metric routes use the same guarded adapter; they have not received separate latency benchmarks.

## Reproduce

```sh
node --import tsx scripts/discover-metric.mjs /absolute/discovery.json
node --import tsx scripts/benchmark-metric-depth.mjs /absolute/benchmark.json
node --import tsx --test tests/*.test.ts
```

[Machine-readable results](metric-depth-2026-11-16.json) include per-route comparisons. Full raw benchmark evidence was also delivered as a compressed artifact. The production adapter adds a final normalization stability check; this guard was tested separately after the initial benchmark began. No swaps or paid requests were submitted.

Primary references: [Metric API](https://docs.metric.xyz/reference/api), [batch depth](https://docs.metric.xyz/reference/api/retrieve-batch-bid-and-ask), [conservative fill math](https://docs.metric.xyz/integrate/integrate-metric-liquidity/estimate-a-fill-from-depth).
