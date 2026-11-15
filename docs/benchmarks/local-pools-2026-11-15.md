# Local pool-state simulation — 2026-11-15

The dashboard now uses exact, native-bigint swap calculations for canonical Uniswap V3, PancakeSwap V2/V3, and legacy Aerodrome Slipstream. All standard sizes and adaptive refinements reuse one block-pinned state snapshot. It preserves contract quoting for other pool types and whenever the local state budget is exceeded.

## Final guarded benchmark

These are complete profile captures: normalization, canonical route verification, probes, 25 sizes per side, up to 12 refinements per side, local state collection, authoritative endpoint validation, and unsupported-route contract fallbacks. All three modes use the same reference and exact chain blocks. Warm mode starts a **new engine** and caches only state-getter RPCs; it does not reuse finished curves or contract quote responses. The state cache for this timing run is an in-memory proxy for matching block-pinned shared reads, not a production D1 latency measurement.

| Profile | Direct contracts | Local cold state | Local cached state | RPC members: direct → cold → warm |
| --- | ---: | ---: | ---: | ---: |
| MSFT / ondo-msft-bsc | 1.49s | 0.51s | 0.45s | 61 → 14 → 12 |
| AAPL / ondo | 5.42s | 3.60s | 1.77s | 163 → 66 → 58 |
| AAPL / binance | 25.75s | 26.72s | 43.54s | 1164 → 953 → 923 |

All **544 best/venue points and 1,308 route candidates** matched at the same blocks: full-input availability, successful raw outputs and winning routes. No candidate or winner mismatches occurred. Tests retain raw pool getter fixtures and reproduce contract outputs offline.

The result is route-dependent. Ondo MSFT on BNB improved from 1.49s to 0.51s cold / 0.45s with cached state; Ondo AAPL on Ethereum improved from 5.42s to 3.60s / 1.77s. bStocks AAPL used fewer RPC members but was slightly slower cold and materially slower in the later warm run, where public-RPC scheduling/retries dominated. **This is not a whole-dashboard latency guarantee.** Each mode is a single observation, collected sequentially per profile, with other chains in parallel; run order and provider throttling affect timings. Earlier exploratory runs also found little or negative total-time benefit for some Base and Robinhood profiles with many fallback routes. Those observations motivated bounded reads and Multicall batching; they must not be represented as final-version controlled comparisons.

## Correctness and coverage

- Reads include pool identity, token ordering, slot0, liquidity, fee, tick spacing, bitmap words, initialized tick liquidity, reserves, and actual output-token balances. Every read uses one pinned block, and canonical hashes are rechecked before caching.
- Math preserves bitmap-word rounding, negative-tick flooring, fee rounding, and signed liquidity crossings. Each order restarts from immutable initial state. Partial/exhausted local paths defer to contract quotes.
- The smallest and largest locally completed input per route/direction are checked against the authoritative quoter at that block; refinements inside that checked range reuse the check. Any later mismatch or revert discards the entire tentative profile, including prior rounds, and recollects it through contract quotes.
- Endpoint checks do not prove arbitrary amount-dependent token behavior or wallet executability. Local results are labelled **Pool-state simulation** (or mixed pool/contract) and do not include gas estimates.
- New Aero, Metric, hooked/dynamic V4, Algebra and unverified forks remain on contract quoters. Solana remains excluded from quoting while Jupiter is disabled.
- Multicall3 is used only for read-only state getters on its documented Ethereum/Base/BNB deployments. It is never used for quoting contracts whose caller or callback context can matter. Failed batches fall back to direct getters.
- Central D1 caching is keyed by chain, block hash and full call parameters. Aggregate responses are cached as whole calls, so overlapping pools only share an aggregate entry when its calldata matches. R2 retains completed curves and calculation provenance. A new block requires fresh state; cached curves preserve original timestamps.

## Reproduce

```sh
node --import tsx scripts/benchmark-local-pools.mjs /absolute/results.json ondo,binance,ondo-msft-bsc
```

Omit the final profile filter for all currently routed AAPL/MSFT profiles. The script performs read-only public RPC calls. [Machine-readable summary](local-pools-2026-11-15.json) includes blocks, counts, state coverage and fallback reasons. Complete raw evidence was also exported with the task deliverables.

## Protocol references

- [Uniswap v3-sdk math and swap loop](https://github.com/Uniswap/v3-sdk/blob/main/src/entities/pool.ts), used under its MIT license (see `THIRD_PARTY_NOTICES.md`).
- [Pancake V3 pool](https://github.com/pancakeswap/pancake-v3-contracts/blob/main/projects/v3-core/contracts/PancakeV3Pool.sol) and [Pancake V2 fee constants](https://github.com/pancakeswap/pancake-swap-sdk/blob/master/src/constants.ts).
- [Legacy Slipstream pool](https://github.com/velodrome-finance/slipstream/blob/main/contracts/core/CLPool.sol).
- [New Aero hook-capable pool](https://github.com/dromos-labs/metadex-slipstream-public/blob/main/contracts/core/CLPool.sol), deliberately left on its quoter.
- [Multicall3 deployment inventory](https://github.com/mds1/multicall3/blob/main/deployments.json).
