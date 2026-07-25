# Retirement Planner — Monte Carlo Simulator

A high-performance, browser-based retirement forecasting engine built with **Svelte 5** and powered by **Markov regime-switching Monte Carlo simulation** with historical bootstrap resampling. All computation runs in a custom-built **Rust WebAssembly (Wasm)** engine mounted in a **Web Worker** to keep the UI perfectly responsive during 100,000+ simulation runs.

---

## 1. Overview

The calculator projects portfolio balances from a starting age through a configurable end-of-life horizon using **monthly time steps**, resolving all outputs into **real (inflation-adjusted) terms**. It generates probability-weighted outcome bands (P10–P90), estimates ruin probability, computes Financial Independence (FI) targets, and visualizes sequence-of-returns risk.

### Design Philosophy

| Aspect | Approach |
|---|---|
| Return generation | Regime-switching block bootstrap from historical data, with parametric Cornish-Fisher fallback. Optional forward-looking means anchored to today's yields (§4.4.1) |
| Inflation | Bootstrapped jointly with returns from the same historical month, preserving their correlation and inflation persistence; regime-conditioned parametric draws as fallback (§5.3) |
| Cash flows | Age-gated income/spending periods + lump-sum events, all in real terms |
| Withdrawals | Fixed real spending, Guyton-Klinger guardrails, or percent-of-portfolio (§5.1.1) |
| Reproducibility | Optional seeded PRNG (`mulberry32`); default unseeded behavior when no seed is provided |
| Output | Percentile fan chart, FI targets (SWR-based and P95-based), ruin surface heatmap, sequence-risk quintile analysis |
| Multi-asset | Three-asset allocation (stocks / bonds / cash) with configurable equity-bond correlation |
| Performance | All simulation runs in a Web Worker with real-time progress reporting; nothing simulates on the main thread (the old noisy live preview was replaced by the stale-results flow, §2) |

---

## 2. Architecture

```text
scripts/
  import-retirement-market-data.mjs      ← Fetches raw monthly prices from Stooq + FRED
  preprocess-retirement-market-data.mjs  ← Converts to annual/monthly return series + moments

data/retirement/raw/*.csv                ← Monthly equity/bond closes, cash rate, CPI, bond yield per region

static/assets/
  historical-market-data.json            ← Preprocessed returns consumed at runtime
                                           (SvelteKit serves `static/`; this is the path
                                            the planner fetches at `/assets/…`)

rust-engine/
  src/                     ← Rust source code for the Monte Carlo engine
    lib.rs                 ← WASM entry point (wasm-bindgen exports)
    simulation.rs          ← Main simulation loop with reservoir sampling
    calculations.rs        ← Math abstractions, RNG (mulberry32/random), percentiles
    engine.rs              ← Markov models, regime state transitions, output structs
    engine2.rs             ← Regime detection, bootstrap pooling, cashflow arrays
    stats.rs               ← Sequence risk analysis, ruin surface replay
    structs.rs             ← Svelte↔Rust API boundary types (serde)
  pkg/                     ← Compiled WebAssembly outputs (wasm-pack build --target web)

src/lib/
  retirementWorker.ts      ← Web Worker calling `run_monte_carlo` via wasm-bindgen
  workerHelper.ts          ← Worker construction helper
  retirementEngine.ts      ← TypeScript reference engine (see §12) + shared types/validation
  calculations.ts          ← Portfolio blending, moments, correlation, PRNG, dataset types
  RetirementPlanner.svelte ← Main application state, Worker controller, Plotly integration
  components/
    PlannerInputPanel.svelte       ← All user inputs (Svelte 5 $props + $bindable)
    PlannerOutputCards.svelte      ← Summary metric cards
    PlannerTimelinePlot.svelte     ← Plotly fan chart
    PlannerSecondaryPlot.svelte    ← Ruin surface heatmap + sequence risk chart
  retirementEngine.test.ts ← Engine unit + regression tests
  enginesParity.test.ts    ← TS ↔ Rust cross-engine parity suite (§12)
```

### Execution Pipeline

The application relies entirely on the high-performance Web Worker for all simulations, prioritizing precision over noisy live previews:

1. **Initial Baseline Run:** On load, a 20,000-path baseline simulation runs automatically to populate the charts rapidly using the Rust engine.
2. **Stale State Protection:** When any input changes, the UI charts gray out (stale state) and a warning banner appears. This explicitly prevents confusion from stale data while avoiding the extreme statistical noise (±30% jumps in ending balance) typical of small-sample "live" previews.
3. **Full Simulation:** The user clicks "Run Monte Carlo" to trigger a new simulation. The Web Worker initializes the WASM module via `init()`, invokes `run_monte_carlo()` with a **progress callback** (~10 incremental updates), executes over contiguous heap memory without garbage collection, and structured-clones back only the aggregated result — the `SummaryStats` (a few KB) plus the five percentile bands (5 × months floats, tens of KB). The per-path balances, which would run to hundreds of megabytes, never leave the worker.

All Svelte components use **Svelte 5 runes** (`$props`, `$effect`, `$state`, `$derived`, `$bindable`).

---

## 3. Data Pipeline

### 3.1 Historical Sources per Region

| Region | Equity | Bond | Cash |
|---|---|---|---|
| **USD** | S&P 500 (`^SPX`, Stooq) | Synthetic 10Y total return from GS10 yield (FRED), duration 7y | 3m T-bill `TB3MS` (FRED) |
| **GBP** | FTSE 100 (`^UKX`, Stooq) | Synthetic UK 10Y total return (`IRLTLT01GBM156N`), duration 7y | UK 3m interbank (`IR3TIB01GBM156N`) |
| **EUR** | 60% DAX TR + 40% CAC (adjusted +3% synthetic annual dividend) | Synthetic DE 10Y total return (`IRLTLT01DEM156N`), duration 7y | EZ 3m interbank stitched with DE pre-euro |
| **WORLD** | 55% US + 15% EUR + 5% UK + 15% Japan (`^NKX`) + 10% Asia/EM (`^HSI`, backfilled 1960–69 with NKX). All converted to USD. | Weighted US/UK/DE 10Y bond returns | Average of US/UK/EUR cash rates |

### 3.1.1 Synthetic Dividend Adjustment

`^SPX`, `^UKX`, `^NKX` and `^HSI` are *price* indices. To approximate total returns,
the preprocessing step adds decade-level synthetic dividend yields to the price-only
equity series (geometric monthly convention, $(1+y)^{1/12}-1$):

| Decade | USD | GBP | WORLD (blended) |
|---|---|---|---|
| 1960s | 3.1% | 5.0% | 2.9% |
| 1970s | 4.1% | 5.5% | 3.2% |
| 1980s | 4.3% | 4.5% | 3.1% |
| 1990s | 2.5% | 3.8% | 2.0% |
| 2000s | 1.8% | 3.3% | 1.7% |
| 2010s | 2.0% | 3.8% | 1.9% |
| 2020s | 1.5% | 3.7% | 1.7% |

Sources: Shiller S&P 500 dividend data (US), Barclays Equity Gilt Study ranges (UK).
The WORLD schedule is the component-weighted blend of US/UK/JP/HK yields; its EUR share
contributes zero because the EUR proxy is already total-return at import time (DAX is TR
by construction; CAC receives +3%/yr in the import script). The EUR region therefore
receives **no** adjustment in preprocessing. Resulting nominal equity moments (1961–2025):
US 12.0% arithmetic / 10.6% geometric — consistent with published S&P 500 total-return
figures for that window.

### 3.2 Bond Total Return Synthesis

Monthly bond returns are computed from yield changes using a duration + convexity model:

$$r_{\text{bond}} = \frac{y_{t-1}}{1200} - D \cdot \frac{\Delta y}{100} + \frac{1}{2} D(D+1) \cdot \left(\frac{\Delta y}{100}\right)^2$$

where $D = 7$ years (modified duration) and $\Delta y = y_t - y_{t-1}$.

### 3.3 Preprocessing

- Monthly equity returns: $P_t / P_{t-1} - 1$ plus the synthetic dividend yield (§3.1.1)
- Annual returns: compound product of 12 monthly returns within each calendar year
- Cash: monthly return = annual rate / 1200
- All series anchored to 1960+
- Month contiguity is asserted per region — a mid-series gap aborts preprocessing
- Statistical moments (mean, σ, skewness, kurtosis) computed with **population** formulas

---

## 4. Return Generation Model

### 4.1 Regime-Switching Markov Chain

Two market regimes: **State 0 (Growth)** and **State 1 (Crisis)**.

**Transition matrix:**

$$P = \begin{bmatrix} p_{GG} & 1 - p_{GG} \\ 1 - p_{CC} & p_{CC} \end{bmatrix}$$

**Stationary distribution:**

$$\pi_G = \frac{1 - p_{CC}}{(1 - p_{GG}) + (1 - p_{CC})}$$

Initial state is drawn from the stationary distribution. Default USD values: $p_{GG} = 0.92$, $p_{CC} = 0.68$.

### 4.2 Regime Detection (Historical Calibration)

When historical returns are available (≥ 25 annual or ≥ 120 monthly observations), regimes are detected empirically:

1. Compute long-run mean $\mu$ and standard deviation $\sigma$
2. Crisis threshold: $\mu - 0.65\sigma$ (annual) or $\mu - 0.75\sigma$ (monthly)
3. A period is labelled crisis if:
   - Its return falls below the crisis threshold, **or**
   - Rolling 3-year (annual) / 6-month (monthly) volatility exceeds $1.15\sigma$ (annual) / $1.2\sigma$ (monthly)
4. Single non-crisis periods sandwiched between two crises are reclassified as crisis (gap-filling)
5. Markov stay-probabilities are estimated by counting consecutive same-state transitions

After detection, returns are partitioned into growth and crisis pools for **block bootstrap** sampling.

### 4.2.1 What the three UI buttons map to

The "Simulation mode and assumptions" toggle in the app maps onto the sampling modes below.
The distinction between the first two is the one users most often miss, so it is stated
explicitly here and in the UI:

| UI button | Sampling | Return moments | Inflation | Use it when |
|---|---|---|---|---|
| **Historical Data Sampling** | Mode A block bootstrap of real months | **Taken from history** — the assumption table is read-only | Joint: read from the *same real month* as the return (§5.3 Mode A) | You want the most faithful replay of what markets actually did |
| **Historical (with Adjustments)** | Mode A block bootstrap of the *same* real months | **Your targets** — the sampled series is affine-shifted to your mean/σ (§4.4) | Falls back to the modelled parametric draw, because the shift breaks the month-for-month pairing | You want history's *shape* but different average returns — "what if the next 30 years are worse?" |
| **Parametric (User Inputs)** | Mode C — no historical data at all | Your inputs, via the regime-switching generator | Modelled parametric draw | You want a purely hypothetical market |

The "Use today's yields" preset (§4.4.1) switches to **Historical (with Adjustments)**,
because anchoring returns to current yields is exactly a moment-targeting operation.

### 4.3 Return Sampling — Three Modes

**Mode A — Monthly Circular Block Bootstrap (≥ 120 monthly data points):**
- A contiguous block of `blockLength` months (**default 6**, see below) is drawn from the
  current regime's pool; sequential months within the block preserve autocorrelation,
  momentum and volatility clustering
- The block index wraps (`% length`), making this a **circular** block bootstrap
  (Politis & Romano), whose defining property is that the resampled mean is unbiased for
  the sample mean — unlike the moving block bootstrap, which under-samples the ends
- The Markov chain transitions each month but is only *consulted* at block boundaries, to
  choose which pool the next block comes from

> **How much is the regime layer actually doing? Very little — see the note below.**

> **Fixed 2026-07-21 (TODO 0.11).** The block used to be abandoned whenever the regime
> switched, not only when it ran out. Because a freshly drawn block always *starts* on a
> month matching the new regime, and crisis runs are shorter than growth runs, crisis
> months were over-drawn by 1.06–1.09×, costing 0.64–1.29pp/yr of return depending on the
> region. Letting blocks finish removed the bias — simulated returns now track the source
> series to within ±0.07pp/yr across all four regions — and also *improved* preservation of
> autocorrelation (EUR lag-1: source 0.064, old sampler 0.038, now 0.053), since blocks cut
> short carry less of the clustering they exist to reproduce.
>
> The cost is that a regime switch is felt at the next block boundary rather than
> immediately, a lag of at most `blockLength` months. A regression test pins the
> mean-preserving property.

#### Where the default block length comes from

`blockLength` is the main control over how sustained simulated downturns are, so it is
chosen by a published procedure rather than by taste. `scripts/analyze-block-length.mjs`
(`pnpm run data:retirement:blocklength`) implements the automatic block-length selection of
**Politis & White (2004)** with the **Patton, Politis & White (2009)** correction, matching
the reference implementations in `np::b.star` and R's `blocklength::pwsd`. The script
self-validates against AR(1) series with known dependence before reporting anything.

On the shipped data it returns a median optimal length of **2.9 months** (range 1.0–12.7
across regions and allocations). The default of 6 sits just above that median: inside the
procedure's range, and leaning slightly long, which preserves a little more dependence for
path simulation than the point estimate.

> Note for readers comparing against other tools: practitioner planning tooling sometimes
> uses much longer blocks (e.g. a 120-month average with the stationary bootstrap). That is
> not a contradiction — PWSD optimises estimation of the variance of a *statistic*, whereas
> very long blocks aim to reproduce multi-year *path* dynamics. These monthly series carry
> little short-lag autocorrelation (the procedure's `m_hat` is 1 almost everywhere), so the
> data-driven answer for this estimator is short. Re-run the script whenever the market data
> is refreshed.

> **Measured limitation of the regime layer in Mode A (2026-07-21).** After removing the
> sampling bias, the regime-conditioned bootstrap was compared against a plain circular
> block bootstrap with no regime conditioning at all, on the shipped data. They are
> statistically indistinguishable — mean, crisis-month frequency, and both the median and
> 5th-percentile worst rolling 12-month window all agree to within noise. The reason is
> structural rather than a bug: the regime probabilities are estimated from the same labels
> being resampled, so selecting a pool with the stationary probability is equivalent to
> sampling unconditionally. Measured regime persistence at consecutive block starts is
> 56.5% against 55.4% expected by chance, because crisis runs (~3 months) are shorter than
> the 6-month block, so the chain fully mixes inside a single block.
>
> **The clustering and sequence risk this model produces come from the block bootstrap, not
> from the regime switching.** That is still a real and valuable property — blocks replay
> genuine historical runs — but the regime layer should not be credited for it. Making the
> regimes bite would require regime runs long relative to `blockLength`, or a transition
> matrix specified independently of the empirical label frequencies. See `TODO.md` 0.12.

**Mode B — Annual Bootstrap with Intra-Year Spread (fallback when monthly data unavailable):**
- Every 12 months, a historical annual return $r_a$ is drawn from the regime pool
- The year is then **spread across its 12 months** rather than held at one constant rate.
  Each month draws a Cornish-Fisher shaped multiplicative shock $f_i = 1 + \sigma_m z'_i$,
  and the twelve shocks are renormalised to unit geometric mean:

  $$r_{m,i} = (1 + r_a)^{1/12} \cdot \frac{f_i}{\left(\prod_j f_j\right)^{1/12}} - 1
  \qquad\Longrightarrow\qquad \prod_{i=1}^{12}(1 + r_{m,i}) = 1 + r_a$$

  so the year still compounds to **exactly** the return that was drawn — the bootstrap's
  fidelity to history and all annual moments are untouched — while the path within the
  year moves.
- Regime transitions use annualized-to-monthly probabilities: $p_m = p_a^{1/12}$

> **Fixed 2026-07-21 (TODO 0.7).** Mode B previously repeated one constant monthly rate
> for all twelve months, so a path that dipped below zero mid-year and recovered by
> December was invisible to monthly-granularity ruin. On a 25-year drawdown at a 6%
> withdrawal rate, restoring the intra-year path lifts measured ruin by roughly 0.8pp
> (success 77.3% → 76.5%) while the simulated annual mean return is unchanged to four
> decimal places, confirming the renormalisation preserves the annual draw exactly.
>
> Mode B is not reachable from the shipped app — all four regions carry ≥ 781 monthly
> observations, comfortably past the 120-month threshold for Mode A — but it is reachable
> through the library with annual-only data, and would become reachable if a region with
> short monthly history were added (see `TODO.md` 5.2).

**Mode C — Parametric (no historical data / parametric mode selected):**
- `buildBootstrapHistory()` generates a synthetic 120-year annual return series using:
  - Student-t draws (degrees of freedom from kurtosis: $df = 4 + 6/\kappa_{excess}$)
  - Skewness shift term
  - Regime-switching mean/std

### 4.4 Moment Targeting (Optional)

When `historicalMomentTargeting` is enabled in Historical mode, each bootstrap sample is affine-transformed to match user-specified moments:

$$r' = \mu_{target} + \frac{r - \mu_{source}}{\sigma_{source}} \cdot \sigma_{target}$$

This preserves the ordering and autocorrelation of historical sequences while shifting their first two moments to the user's targets.

### 4.4.1 "Use today's yields" — Current-Conditions Assumptions

Historical averages are a poor forecast of *bond* returns: much of the 1960–2026 bond
return came from yields falling from double digits, which cannot repeat from today's
level. The **Use today's yields** preset therefore rebuilds the return means the way
institutional capital-market assumptions do, from the latest observed yields shipped in
the dataset (`currentConditions`, sourced from the `bond_yield_pct` / `cash_rate_pct`
columns):

| Asset | Forward mean |
|---|---|
| Cash | current short rate |
| Bonds | current long yield |
| Equity | current long yield + historical equity risk premium (equity mean − bond mean) |

**Only the means change.** Volatility, skewness, kurtosis and the bootstrap's real
historical sequencing are retained — the shape of the distribution is the part history
estimates well. The preset runs in Historical-with-Adjustments mode, so the moment
targeting of §4.4 shifts the sampled historical series onto these targets.

As of the shipped 2026-01 data:

| Region | Cash | Bonds | Equity (forward) | Equity (historical) |
|---|---|---|---|---|
| USD | 3.6% | 4.2% | 9.9% | 12.0% |
| EUR | 2.0% | 2.8% | 6.1% | 9.3% |
| GBP | 3.7% | 4.5% | 7.7% | 11.3% |
| WORLD | 3.1% | 3.8% | 9.4% | 12.1% |

> Because this mode uses moment targeting, the joint (return, inflation) bootstrap of
> §5.3 is inactive and inflation falls back to the regional parametric assumption, which
> remains user-editable. Anchoring inflation to market-implied breakevens is future work.

### 4.5 Cornish-Fisher Expansion (`drawCornishFisherScore`)

For parametric draws (inflation and Mode B/C returns), the engine uses a 4-term Cornish-Fisher expansion:

$$z' = z + \frac{s}{6}(z^2 - 1) + \frac{\kappa_{ex}}{24}(z^3 - 3z) - \frac{s^2}{36}(2z^3 - 5z)$$

where $z \sim N(0,1)$, $s = \text{clamp}(\text{skewness}, -1.5, 1.5)$, $\kappa_{ex} = \text{clamp}(\kappa - 3, 0, 8)$.

### 4.6 Clamping

| What | Min | Max |
|---|---|---|
| Annual return | −95% | +120% |
| Monthly return | −60% | +60% |
| Transition probability | 0.001 | 0.999 |

---

## 5. Simulation Loop

For each of `N` simulation paths (minimum 400):

```text
balance = currentSavings
for each month m in [0 .. totalMonths):
    1. Regime transition (monthly Markov chain)
    2. Sample monthly asset return (block bootstrap or parametric)
    3. Apply AUM fee:       growth = (1 + r) × (1 − annualFeePercent / 12)
    4. Sample monthly inflation (regime-conditioned Cornish-Fisher draw)
    5. Net flow = (income_at_age − spending_at_age) / 12 + lump_sums
    6. balance += net_flow
    7. yearly_pnl += balance × (growth − 1)      ← investment P&L, net of fees
    8. balance *= growth
    9. balance /= (1 + monthly_inflation);  yearly_pnl /= (1 + monthly_inflation)
   10. At each year boundary (and final partial year):
          tax = taxOnGainsPercent × max(0, yearly_pnl)
          balance −= tax  (also folded into that month's growth factor for replay)
          yearly_pnl = 0
   11. if balance ≤ 0: balance = 0, mark depleted
   12. Record balance and growth factor
```

### 5.1 Cash Flow Model

- **Spending periods**: `[fromAge, toAge)`, yearly amount, `inflationAdjusted` flag (default: true)
  - Inflation-adjusted: used at face value in real terms
  - Nominal: divided by $E[\text{inflation index}] = (1 + \mu_{inf})^{age - currentAge}$
  - Nominal items are divided by that path's **realized** cumulative inflation index, so
    a fixed annuity or nominal pension really does lose purchasing power faster on a
    high-inflation path. The index is taken through month $m-1$, since the flow is applied
    before that month's deflation. Balances and nominal flows therefore share one price
    index; previously the flows used $(1+\mu)^{m/12}$ while balances compounded the
    monthly draws.
  - The ruin-surface and Coast-FIRE **replays** still use the expected index for nominal
    items: the stored growth factors bake inflation into a single number, so per-path
    realized inflation cannot be recovered during a replay (§7).
- **Income sources**: identical structure; default salary `[currentAge, retirementAge)`, default pension `[67, simulateUntilAge)`
- **Lump-sum events**: one-time addition/subtraction at a specific age

### 5.1.1 Withdrawal Strategies

During the retirement phase (`age ≥ retirementAge`), spending can respond to the running
balance. A stateful `WithdrawalRunner` (identical logic in the Rust and TS engines, and
re-applied in the ruin-surface replay so the surface stays consistent) evaluates one of:

| Strategy (`withdrawalStrategy.kind`) | Behaviour |
|---|---|
| `fixed` (default) | Planned real-terms spending, unchanged. The classic "4% rule" assumption. |
| `guardrails` | Guyton-Klinger. Once per retirement year, if the current withdrawal rate (spending ÷ balance) has drifted above `initialRate × (1 + guardrailBand)`, spending is cut by `adjustment`; below `initialRate × (1 − guardrailBand)`, raised by `adjustment`. Clamped to `[spendingFloor, spendingCeiling] ×` planned. Defaults: band 0.2, step 0.1, floor 0.6, ceiling 1.4. |
| `percentOfPortfolio` | Each retirement year spend `withdrawalPercent ×` current balance, clamped to `[spendingFloor, spendingCeiling] ×` initial real spending so income neither collapses nor balloons. Default `withdrawalPercent` 0.04. |

Both adaptive strategies raise success probability versus fixed spending on stressed
scenarios (they cut spending in bad markets), matching the well-documented behaviour of
guardrail/variable-percentage withdrawal in the retirement-research literature. A
regression test (`retirementEngine.test.ts`, "withdrawal strategies") asserts
`guardrails ≥ fixed` and `percentOfPortfolio ≥ fixed` on a calibrated stressed scenario.
Pre-retirement spending is always the planned amount regardless of strategy.

### 5.2 Drag Model

| Parameter | Default | Application |
|---|---|---|
| `annualFeePercent` | 0.5% | Deducted monthly from AUM: $(1 - \text{fee}/12)$. Models TER + platform costs. |
| `taxOnGainsPercent` | 15% | Applied **annually to the year's net investment P&L** (net of fees); losses are untaxed and not carried forward. Models capital gains tax. |

The annual P&L is tracked in the same deflated units as the balance, so the tax models
nominal-gains taxation expressed in today's money. At the 15% default the effective drag
is ≈1.6%/yr on a ≈12%/yr portfolio (rate × mean gain), verified by a regression test in
`retirementEngine.test.ts`. Loss carryforward and jurisdiction-specific modes (e.g. Dutch
Box 3 wealth tax) are future work — see `TODO.md` 2.3.

### 5.3 Inflation Model

**Mode A — Joint historical bootstrap (default in Historical mode).** When the planner
supplies `historicalMonthlyInflation` (realized regional CPI change, index-aligned with
`historicalMonthlyReturns`), each simulated month takes its inflation from the *same
historical month* as its return. This preserves two properties the parametric draw
cannot:

- **Return/inflation correlation.** Measured in the shipped dataset (1960–2026):
  equity −0.08 / bond −0.17 for USD — high-inflation months really were weak market
  months.
- **Inflation persistence.** Realized monthly inflation has AR(1) ≈ 0.62 (USD); because
  bootstrap blocks are contiguous, simulated paths inherit sustained inflationary
  periods rather than i.i.d. noise.

The regime inflation spread is deliberately *not* applied on top in this mode — the
historical series already embeds that co-movement. Joint sampling is used only in
Historical mode without moment targeting (otherwise the user's explicit inflation
assumptions would be silently ignored), and only when the two series are the same
length; a misaligned series is ignored rather than mispaired. A regression test
(`retirementEngine.test.ts`, "joint return/inflation bootstrap") asserts that persistent
stagflation produces a fatter left tail than independent inflation at the same mean —
the tail risk TODO 0.4 identified as understated.

**Mode B — Parametric fallback** (Parametric mode, moment targeting, or no CPI data).
Monthly inflation is drawn from a **regime-conditioned** Cornish-Fisher distribution:

$$r_{inf} = \frac{\mu_{regime}}{12} + \frac{\sigma_{inf}}{\sqrt{12}} \cdot z'_{CF}$$

Where:
- Growth regime: $\mu_{growth} = \mu_{inf} - \pi_C \cdot \text{spread}$
- Crisis regime: $\mu_{crisis} = \mu_{inf} + \pi_G \cdot \text{spread}$
- Default `inflationCrisisSpread` = 1.5%
- The spread is capped at 80% of maximum variance-preserving spread

All output balances are in **real (today's purchasing power) terms**.

### 5.4 Memory-Efficient Percentile Computation

For large simulation counts (10,000+), storing all balances per month per simulation would require hundreds of megabytes. The engine uses **reservoir sampling** (Algorithm R) with K=5,000 samples per month:

- For sim ≤ K: all balances are kept exactly
- For sim > K: each new balance replaces a random existing sample with probability K/(sim+1)

This guarantees a uniform random sample per month, and bounds memory at `K × months × 8 bytes` **regardless of simulation count** — ≈26 MB for the default 35→90 horizon, ≈47 MB at the maximum 12→110 horizon. Percentile accuracy at K=5,000 is excellent (±0.5% for P10–P90).

Growth factors for the ruin surface replay are capped at 2000 rows (~11.5 MB), matching the 2000-path subsampling used by `build_ruin_surface` (raised from 800 in 2026-07 to keep heatmap tail-probability SE under ~±1%).

---

## 6. Portfolio Construction (UI Layer)

### 6.1 Three-Asset Allocation

Users set allocation via two slider boundaries: stocks % and (stocks + bonds) %. The complement is cash. Default: 60% stocks / 30% bonds / 10% cash.

### 6.2 Portfolio Moment Blending

$$\mu_p = \sum_i w_i \mu_i$$

$$\sigma_p^2 = \sum_i (w_i \sigma_i)^2 + 2 w_{eq} w_{bond} \sigma_{eq} \sigma_{bond} \rho_{eq,bond}$$

Cash correlation terms are treated as 0. When historical market data is available, $\rho_{eq,bond}$ is estimated from the selected region's monthly series.

Skewness uses the third central moment of a sum. For independent components the cross
terms vanish ($E[A^2B] = E[A^2]E[B] = 0$ for centred variables), so this is exact when
uncorrelated and a mild approximation once equity and bonds co-move:

$$s_p = \frac{\sum_i a_i^3 s_i}{\sigma_p^3}, \qquad a_i = w_i \sigma_i$$

Kurtosis needs the **cross terms**, which are the bulk of a sum's fourth moment:

$$\kappa_p = \max\left(1, \frac{1}{\sigma_p^4}\left[\sum_i a_i^4 \kappa_i + 12\rho\left(a_{eq}^3 a_{bd} + a_{eq} a_{bd}^3\right) + 6 a_{eq}^2 a_{bd}^2\left(1 + 2\rho^2\right) + 6 a_{cash}^2 \left(a_{eq}^2 + a_{bd}^2 + 2\rho\, a_{eq} a_{bd}\right)\right]\right)$$

This is exact for jointly normal components (verified against Monte Carlo) and exact for
independent components whatever their marginal shape, since the cross moments then
factor. With both correlation *and* non-normal marginals it is a normal-theory
approximation — joint fourth moments are not determined by $\rho$ alone.

> **Fixed 2026-07-21 (TODO 0.5).** The $\sum a_i^4 \kappa_i$ term was previously used on
> its own. That made a blend of *independent normals* report $\kappa_p = 1.5$ instead of
> 3 — thinner than normal — which then told the Student-t mapping (§4.3 Mode C) there was
> no excess kurtosis to reproduce, generating thinner tails than intended. The error grew
> as the portfolio became more balanced, so it hit conservative allocations hardest: for
> EUR at 20/40/40 the reported kurtosis was **1.74 against a corrected 2.90**, while a
> 100% single-asset portfolio was unaffected and the 60/30/10 default moved only ~1%
> (its fourth moment is dominated by the equity term).

### 6.3 Variance-Preserving Regime Decomposition

The UI constructs regime parameters from blended portfolio metrics and a region-specific template:

1. Stationary probabilities $\pi_G, \pi_C$ from template stay-probabilities
2. Growth/crisis means separated by a `meanSpread` (adjusted for excess kurtosis and skewness)
3. Compute regime mean variance: $V_{mean} = \pi_G(\mu_G - \mu_p)^2 + \pi_C(\mu_C - \mu_p)^2$
4. Remaining variance: $V_{within} = \sigma_p^2 - V_{mean}$
5. Shared scale factor: $s = \sqrt{V_{within} / (\pi_G m_G^2 + \pi_C m_C^2)}$
6. Regime standard deviations: $\sigma_G = s \cdot m_G$, $\sigma_C = s \cdot m_C$

This ensures the **total unconditional variance exactly matches** the portfolio variance.

---

## 7. Output Metrics

### 7.1 Percentile Fan Chart
P10, P25, P50 (median), P75, P90 balance trajectories over the full time horizon.

### 7.2 FI Targets

| Target | Definition |
|---|---|
| FI Target (SWR) | $\text{spending at retirement age} / \text{SWR}$ (default SWR = 4%) |
| FI Target (P95) | Minimum balance at retirement such that ≥ 95% of paths with balance ≥ that threshold end above zero. Found by sorting simulations by retirement-age balance and scanning for the 95% conditional success cutoff using a suffix-sum algorithm. |
| Coast FIRE age | Earliest age at which **contributions** could stop while still clearing 95% success. |

**Coast FIRE.** "Stopping contributions" is modelled as **net-zero cash flow** from that
age until retirement: you still cover spending from work — the coast/barista case — so the
portfolio neither grows by contribution nor shrinks by withdrawal, it simply compounds.
Retirement age and retirement spending are unchanged.

It reuses the ruin-surface replay (§7.4): the stored per-path growth factors are re-run
against a modified cash-flow schedule, and the coast month is found by binary search,
which is valid because success is monotone non-decreasing in the coast month — all growth
factors are positive, so contributing longer leaves every path with at least as much
money. That makes it ~6 replays rather than fresh simulations, and it inherits the same
approximation caveat as the ruin surface.

Reported as `null` in two cases, both surfaced explicitly in the UI rather than hidden:
when the user is not a net saver before retirement (there are no contributions to stop),
and when 95% is unreachable even by contributing right up to retirement.

### 7.3 Ruin Analysis

- **Success probability**: fraction of paths ending with balance > 0
- **Shortfall**: cumulative deficit for depleted paths (P10, P50, P90)
- **Depleted years**: total years spent at zero balance (P10, P50, P90)

### 7.4 Sequence-Risk Quintile Analysis

Simulations are sorted by mean real return in the first 10 post-retirement years, then grouped into 5 quintiles. For each: mean early return, ruin probability, ending median balance. This directly validates the Kitces/Pfau sequence-of-returns thesis.

### 7.5 Ruin Surface Heatmap

A 5×5 grid of ruin probabilities across:
- **Retirement ages**: `[retAge−6, retAge−3, retAge, retAge+3, retAge+6]`
- **Spending multipliers**: `[0.8, 0.9, 1.0, 1.1, 1.2]`

Each cell replays the stored growth factors (subsampled to 2000 paths max) with recomputed cashflow arrays. Note: income source `is-default` (salary) has `toAge` adjusted per cell; other income sources remain unchanged. This is a documented fast approximation.

**Sampling precision.** Because each cell is a proportion over `sampleCount` replayed
paths, it carries binomial error $SE=\sqrt{p(1-p)/N}$ — at N=2000 that is up to ±2.2% at
95% confidence for mid-range cells, tighter near 0% and 100%. The UI shows each cell's own
margin on hover and the worst-case margin in the chart caption. Two things follow that the
caption makes explicit:

- The replay sample is capped **independently of the `simulations` setting**, so raising
  the simulation count sharpens the summary cards but not this heatmap.
- All cells replay the *same* stored paths (common random numbers), so **differences**
  between neighbouring cells are considerably steadier than each cell's absolute margin
  suggests. The chart is meant to be read for the shape of the retire-earlier / spend-more
  trade-off rather than for any single cell's exact value.

---

## 8. Random Number Generation

- **`RandomSource`** struct in `calculations.rs` wraps either `mulberry32` (when `seed` is provided) or thread-local random
- **Box-Muller** transform for normal draws, with spare cache **encapsulated per instance** (no global mutable state)
- **Student-t** generation via ratio of normal to chi-squared (only used in `buildBootstrapHistory` — called 120 times per run, not in the hot loop)
- When `seed` is set, results are fully deterministic and reproducible

---

## 9. Verification Checklist

| Item | Unit | Status |
|---|---|---|
| All returns | Decimal (0.08 = 8%) | ✓ Consistent throughout |
| Annual → monthly | $(1 + r_a)^{1/12} - 1$ | ✓ Correct compounding |
| Annual σ → monthly σ | $\sigma_a / \sqrt{12}$ | ✓ Standard scaling |
| Inflation deflation | $\div (1 + r_{inf})$ | ✓ Correct real-terms conversion |
| Cash flows | Annual amounts ÷ 12 | ✓ Consistent monthly stepping |
| SWR target | Annual spending ÷ SWR rate | ✓ Standard definition |
| Percentile interpolation | Linear between ranks | ✓ Matches NumPy default |
| Stationary distribution | $\pi_G = (1 - p_{CC}) / ((1 - p_{GG}) + (1 - p_{CC}))$ | ✓ Correct from $\pi P = \pi$ |
| Box-Muller cache | Per-instance, no global mutation | ✓ |
| Regime gap-filling | Single non-crisis sandwiched → crisis | ✓ |

The checklist above covers unit/formula consistency. The correctness issues raised in the
2026-07-07 review — dividend handling, the tax model and return/inflation coupling — have
since been fixed (§3.1.1, §5.2, §5.3). What remains open is tracked in `TODO.md`
Priority 0, chiefly nominal cashflows being deflated by expected rather than realized
inflation (0.3) and the kurtosis-blending cross-terms (0.5). §10 below lists the standing
simplifications.

---

## 10. Key Assumptions & Known Simplifications

| Assumption | Risk | Notes |
|---|---|---|
| Block bootstrap within regime (block = 6 months) | Preserves short-run autocorrelation | Much better than i.i.d. sampling |
| Equity-bond correlation configurable; cash correlation = 0 | Partial | Improves portfolio σ realism |
| Regime-conditioned inflation (crisis spread) | Captures main channel | Not full multivariate inflation model |
| Spending strategy (fixed / guardrails / percent-of-portfolio) | Fixed default is conservative | Adaptive strategies available (§5.1.1), added 2026-07-20 |
| Split fee/tax costs | Improved | More interpretable than single drag |
| Monthly time step | Good | Sufficient for retirement horizon |
| Two regimes (Growth/Crisis) | **Contributes nothing measurable in Mode A** | Clustering comes from the block bootstrap; regime layer is near-vacuous once unbiased (§4.3, TODO 0.12). Still drives Mode C's parametric generator |
| Historical bootstrap for calibration | Good | Data-driven, adapts to region |
| Variance-preserving regime decomposition | Good | Total σ is preserved exactly |
| Return clamping (−95% to +120% annual) | Conservative | Prevents simulation blow-ups |
| Synthetic decade-level dividend yields on price-only indices | Approximation (±0.3%/yr) | Fixed 2026-07-20 (§3.1.1); replaces the former price-only bias of 2.5–3.5%/yr |
| Annual net-gain taxation, no loss carryforward | Slightly conservative in loss-heavy sequences | Fixed 2026-07-20 (§5.2); carryforward + Box 3 mode are TODO 2.3 |
| Nominal cashflows deflated by each path's **realized** inflation | Fixed annuities/pensions now erode faster on high-inflation paths, as they should | Fixed 2026-07-21 (§5.1); replays still use the expected index (§7) |
| Regime block bootstrap is mean-preserving | Simulated returns track the source series (all four regions within ±0.07pp/yr) | Fixed 2026-07-21 (§4.3 Mode A); guarded by a regression test |
| Joint (return, CPI) bootstrap in Historical mode; parametric i.i.d. inflation only in Parametric / moment-targeting modes | Correlation and persistence now preserved where it matters | Fixed 2026-07-21 (§5.3); GBP CPI ends 2025-03 so its monthly series stops there |
| Kurtosis blending omits 4th-moment cross-terms | Thinner tails than intended | TODO 0.5 |
| Depletion is sticky (no recovery counted) | Slightly overstates ruin when late income could revive a path | TODO 2.7 |
| Annual-mode bootstrap spreads the year across 12 months, preserving the annual draw exactly | Intra-year path restored; shape of the spread is parametric, not historical | Fixed 2026-07-21 (§4.3 Mode B); fallback mode only, unreachable from the shipped app |
| **Fixed planning horizon; no mortality weighting** | Measures "ruin by your chosen age", not ruin-before-death, so it is conservative relative to a lifetime measure | **Deliberate product decision**, not an omission — survival statistics are the wrong register for a personal tool. TODO 2.2 (declined) |
| Allocation is fixed for life; no glide path | Cannot model de-risking into retirement | TODO 2.5 |
| Single-person model | No second person's age, income or pension start | TODO 2.6 |
| "Use today's yields" runs via moment targeting, which disables the joint inflation bootstrap | Inflation reverts to the parametric draw in that mode | TODO 2.8 |
| Ruin surface adjusts only the default salary's end age per cell | Other income sources are held fixed across cells | TODO 6.2 |
| Ruin-surface cells replay a capped 2000-path subsample | ±2.2% sampling noise at mid-range cells; unaffected by the simulation count | Surfaced in the UI (§7); cell *differences* are steadier than that (common random numbers) |

---

## 11. Comparison with Industry Standards

| Feature | This Engine | Best Practice | Gap |
|---|---|---|---|
| Return model | Regime-switching block bootstrap | State-of-art | ✓ Block bootstrap preserves clustering |
| Fat tails | Cornish-Fisher + Student-t | Skew-t or Johnson SU | Minor; bootstrap dominates |
| Correlation | Equity-bond correlation parameter | Full DCC-GARCH | Partial (cash, time-varying not modeled) |
| Inflation | Joint (return, CPI) historical bootstrap; regime-conditioned parametric fallback | VAR(1) with returns | ✓ Empirical joint distribution keeps correlation *and* persistence without imposing a parametric form |
| Ruin analysis | Full path simulation | Same | ✓ |
| Sequence risk | Quintile analysis of early returns | Kitces/Pfau methodology | ✓ |
| Spending rules | Fixed real, Guyton-Klinger guardrails, or percent-of-portfolio | Guardrail / VPW | ✓ Closed; age-banded VPW table still future (TODO 2.1) |
| Longevity | Fixed user-chosen horizon | Mortality-weighted | **Deliberately not adopted.** Showing survival probabilities is the wrong register for a personal planning tool; the fixed horizon is the conservative choice — see `TODO.md` 2.2 |
| Expected returns | Historical, or anchored to today's yields (§4.4.1) | Forward-looking CMAs | ✓ Yield-anchored preset; no CAPE/valuation adjustment yet |
| Reproducibility | Optional seeded PRNG, surfaced in the UI and share link | Seeded PRNG | ✓ Closed |
| Convergence reporting | SE on success probability + per-cell heatmap margins | Reported sampling error | ✓ Closed |

---

## 12. Development

### Prerequisites

- **Node.js** ≥ 20
- **Rust** toolchain (install via [rustup](https://rustup.rs/))
- **wasm-pack** (`curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh`)

```bash
pnpm install
pnpm run dev          # Builds WASM + starts dev server
pnpm run build        # Production build (WASM + Vite + publint)
pnpm run build:wasm   # Rebuild WASM module only
pnpm run test:engines # Engine + parity tests (Node only, no browser)
pnpm run test         # Full suite, including browser tests (needs Playwright)
```

### Two Engines, One Behaviour

The production simulation is the Rust/WASM engine. `src/lib/retirementEngine.ts` is kept
deliberately as the **reference implementation**: it is more readable, runs in plain Node
without a wasm build, and makes the parity suite possible.

`src/lib/enginesParity.test.ts` runs identical seeded inputs through both and compares the
PRNG streams, the full per-month percentile bands, and every summary, sequence-risk and
ruin-surface value across eight scenarios. The seeded streams are bit-identical, so the
engines agree to about one ULP and the suite asserts a 1e-9 relative tolerance.

> **Any change to simulation behaviour must land in both engines in the same commit.**
> CI runs `pnpm run test:engines` before the dist build, so drift fails the pipeline.
>
> Note also what this does *not* buy you: parity is not correctness. Both engines once
> shared the same year-boundary bug, and the parity suite would have passed it.

### Data Pipeline

```bash
# Full refresh: re-fetches prices, yields and CPI from Stooq/FRED
node scripts/import-retirement-market-data.mjs

# Refresh only the derived rate columns (cpi_index, bond_yield_pct), leaving the
# committed market-data vintage byte-for-byte intact
node scripts/import-retirement-market-data.mjs --merge-rates

# Regenerate static/assets/historical-market-data.json from the raw CSVs
node scripts/preprocess-retirement-market-data.mjs
```

The preprocessing step writes to `static/`, which is what SvelteKit serves. Verify data
changes through the running app, not just the generated file — an earlier version wrote
to `public/`, and the app silently kept using a months-old dataset.

---

## 13. References

- Pfau, W. (2018). *How Much Can I Spend in Retirement?* — comprehensive comparison of variable spending strategies
- Bengen, W. (1994). *Determining Withdrawal Rates Using Historical Data* — original 4% SWR research
- Kitces, M. & Pfau, W. (2015). *Reducing Retirement Risk with a Rising Equity Glide Path* — sequence-of-returns risk analysis
- Ang, A. & Bekaert, G. (2002). *International Asset Allocation with Regime Shifts* — Markov regime-switching in portfolio theory
- Hamilton, J. (1989). *A New Approach to the Economic Analysis of Nonstationary Time Series and the Business Cycle* — foundational regime-switching model
- Politis, D. & Romano, J. (1994). *The Stationary Bootstrap* — block bootstrap methodology for dependent data
- Johnson, N. L. (1949). *Systems of Frequency Curves* — Johnson SU distribution for non-normal financial returns

---

## 14. License

Licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

The AGPL's network clause (§13) is the point: if you run a modified version of this
planner as a hosted service, you must offer that service's users the corresponding
source. Private use and modification are unrestricted.

**Not financial advice.** This is an educational planning tool. Its projections are
model output, not predictions, and carry no warranty — see the disclaimer in §11 of the
license text and the notice shown in the app itself.

### Third-party data

Market and price-index data is fetched from public sources (Stooq, FRED) by the scripts
in `scripts/` and is subject to those providers' own terms. The derived series committed
under `data/retirement/raw/` and `static/assets/` are transformations of that data,
included for reproducibility.
