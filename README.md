# Retirement Planner — Monte Carlo Simulator

A high-performance, browser-based retirement forecasting engine built with **Svelte 5** and powered by **Markov regime-switching Monte Carlo simulation** with historical bootstrap resampling. All computation runs in a **Web Worker** to keep the UI responsive during 100,000+ simulation runs.

---

## 1. Overview

The calculator projects portfolio balances from a starting age through a configurable end-of-life horizon using **monthly time steps**, resolving all outputs into **real (inflation-adjusted) terms**. It generates probability-weighted outcome bands (P10–P90), estimates ruin probability, computes Financial Independence (FI) targets, and visualizes sequence-of-returns risk.

### Design Philosophy

| Aspect | Approach |
|---|---|
| Return generation | Regime-switching block bootstrap from historical data, with parametric Cornish-Fisher fallback |
| Inflation | Regime-conditioned parametric monthly draws (higher mean in crisis regimes) |
| Cash flows | Age-gated income/spending periods + lump-sum events, all in real terms |
| Reproducibility | Optional seeded PRNG (`mulberry32`); default unseeded behavior when no seed is provided |
| Output | Percentile fan chart, FI targets (SWR-based and P95-based), ruin surface heatmap, sequence-risk quintile analysis |
| Multi-asset | Three-asset allocation (stocks / bonds / cash) with configurable equity-bond correlation |
| Performance | Web Worker offloading with real-time progress reporting; preview runs on main thread |

---

## 2. Architecture

```text
scripts/
  import-retirement-market-data.mjs      ← Fetches raw monthly prices from Stooq + FRED
  preprocess-retirement-market-data.mjs  ← Converts to annual/monthly return series + moments

data/retirement/raw/*.csv                ← Monthly equity-close, bond-close, cash-rate per region

public/assets/retirement/
  historical-market-data.json            ← Preprocessed returns consumed at runtime

src/lib/
  calculations.ts          ← RandomSource (mulberry32 + Box-Muller), percentile, portfolio blending
  retirementEngine.ts      ← Core simulation engine (898 lines)
  retirementWorker.ts      ← Web Worker wrapper with progress reporting
  RetirementPlanner.svelte ← Main application state, Worker controller, Plotly integration
  components/
    PlannerInputPanel.svelte       ← All user inputs (Svelte 5 $props + $bindable)
    PlannerOutputCards.svelte      ← Summary metric cards
    PlannerTimelinePlot.svelte     ← Plotly fan chart
    PlannerSecondaryPlot.svelte    ← Ruin surface heatmap + sequence risk chart
```

### Dual-Execution Pipeline

1. **Live Preview (Synchronous, main thread):** When any input changes, a lightweight ~400-path simulation runs in <15ms to instantly update charts. Keeps the UI feeling snappy.
2. **Full Simulation (Asynchronous Web Worker):** When the user clicks "Run Monte Carlo", a `RUN_SIMULATION` message is sent to the Worker. The Worker fires `SIMULATION_PROGRESS` messages every ~1% to update a progress bar, then sends back the full result via Structured Cloning.

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

### 3.2 Bond Total Return Synthesis

Monthly bond returns are computed from yield changes using a duration + convexity model:

$$r_{\text{bond}} = \frac{y_{t-1}}{1200} - D \cdot \frac{\Delta y}{100} + \frac{1}{2} D(D+1) \cdot \left(\frac{\Delta y}{100}\right)^2$$

where $D = 7$ years (modified duration) and $\Delta y = y_t - y_{t-1}$.

### 3.3 Preprocessing

- Monthly price returns: $P_t / P_{t-1} - 1$
- Annual returns: compound product of 12 monthly returns within each calendar year
- Cash: monthly return = annual rate / 1200
- All series anchored to 1960+
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

### 4.3 Return Sampling — Three Modes

**Mode A — Monthly Block Bootstrap (≥ 120 monthly data points):**
- Each month, regime transitions via the monthly Markov chain
- A contiguous block of `blockLength` months (default 6) is drawn from the regime pool
- Sequential months within the block preserve autocorrelation, momentum, and volatility clustering
- On regime change, a new random block start is drawn

**Mode B — Annual Bootstrap + Parametric Noise (fallback when monthly data unavailable):**
- Every 12 months, a historical annual return is drawn from the regime pool
- Converted to monthly: $r_m = (1 + r_a)^{1/12} - 1$
- Per-month parametric noise is added via Cornish-Fisher shaped draws
- Regime transitions use annualized-to-monthly probabilities: $p_m = p_a^{1/12}$

**Mode C — Parametric (no historical data / parametric mode selected):**
- `buildBootstrapHistory()` generates a synthetic 120-year annual return series using:
  - Student-t draws (degrees of freedom from kurtosis: $df = 4 + 6/\kappa_{excess}$)
  - Skewness shift term
  - Regime-switching mean/std

### 4.4 Moment Targeting (Optional)

When `historicalMomentTargeting` is enabled in Historical mode, each bootstrap sample is affine-transformed to match user-specified moments:

$$r' = \mu_{target} + \frac{r - \mu_{source}}{\sigma_{source}} \cdot \sigma_{target}$$

This preserves the ordering and autocorrelation of historical sequences while shifting their first two moments to the user's targets.

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
    3. Apply tax on gains:  r_after_tax = r > 0 ? r × (1 − taxOnGainsPercent) : r
    4. Apply AUM fee:       growth = (1 + r_after_tax) × (1 − annualFeePercent / 12)
    5. Sample monthly inflation (regime-conditioned Cornish-Fisher draw)
    6. Net flow = (income_at_age − spending_at_age) / 12 + lump_sums
    7. balance += net_flow
    8. balance *= growth
    9. balance /= (1 + monthly_inflation)
   10. if balance ≤ 0: balance = 0, mark depleted
   11. Record balance and growth factor
```

### 5.1 Cash Flow Model

- **Spending periods**: `[fromAge, toAge)`, yearly amount, `inflationAdjusted` flag (default: true)
  - Inflation-adjusted: used at face value in real terms
  - Nominal: divided by $E[\text{inflation index}] = (1 + \mu_{inf})^{age - currentAge}$
- **Income sources**: identical structure; default salary `[currentAge, retirementAge)`, default pension `[67, simulateUntilAge)`
- **Lump-sum events**: one-time addition/subtraction at a specific age

### 5.2 Drag Model

| Parameter | Default | Application |
|---|---|---|
| `annualFeePercent` | 0.5% | Deducted monthly from AUM: $(1 - \text{fee}/12)$. Models TER + platform costs. |
| `taxOnGainsPercent` | 15% | Applied only to positive monthly returns. Models capital gains tax. |

### 5.3 Inflation Model

Monthly inflation is drawn from a **regime-conditioned** Cornish-Fisher distribution:

$$r_{inf} = \frac{\mu_{regime}}{12} + \frac{\sigma_{inf}}{\sqrt{12}} \cdot z'_{CF}$$

Where:
- Growth regime: $\mu_{growth} = \mu_{inf} - \pi_C \cdot \text{spread}$
- Crisis regime: $\mu_{crisis} = \mu_{inf} + \pi_G \cdot \text{spread}$
- Default `inflationCrisisSpread` = 1.5%
- The spread is capped at 80% of maximum variance-preserving spread

All output balances are in **real (today's purchasing power) terms**.

---

## 6. Portfolio Construction (UI Layer)

### 6.1 Three-Asset Allocation

Users set allocation via two slider boundaries: stocks % and (stocks + bonds) %. The complement is cash. Default: 60% stocks / 30% bonds / 10% cash.

### 6.2 Portfolio Moment Blending

$$\mu_p = \sum_i w_i \mu_i$$

$$\sigma_p^2 = \sum_i (w_i \sigma_i)^2 + 2 w_{eq} w_{bond} \sigma_{eq} \sigma_{bond} \rho_{eq,bond}$$

Cash correlation terms are treated as 0. When historical market data is available, $\rho_{eq,bond}$ is estimated from the selected region's monthly series.

Skewness and kurtosis are blended using the weighted third and fourth central moments:

$$s_p = \frac{\sum_i (w_i \sigma_i)^3 \cdot s_i}{\sigma_p^3} \qquad \kappa_p = \max\left(1, \frac{\sum_i (w_i \sigma_i)^4 \cdot \kappa_i}{\sigma_p^4}\right)$$

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

Each cell replays the stored growth factors (subsampled to 800 paths max) with recomputed cashflow arrays. Note: income source `is-default` (salary) has `toAge` adjusted per cell; other income sources remain unchanged. This is a documented fast approximation.

---

## 8. Random Number Generation

- **`RandomSource`** class in `calculations.ts` wraps either `mulberry32` (when `seed` is provided) or `Math.random()` (default)
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

---

## 10. Key Assumptions & Known Simplifications

| Assumption | Risk | Notes |
|---|---|---|
| Block bootstrap within regime (block = 6 months) | Preserves short-run autocorrelation | Much better than i.i.d. sampling |
| Equity-bond correlation configurable; cash correlation = 0 | Partial | Improves portfolio σ realism |
| Regime-conditioned inflation (crisis spread) | Captures main channel | Not full multivariate inflation model |
| Fixed spending in real terms | Overstates ruin probability | Humans adapt spending downward |
| Split fee/tax costs | Improved | More interpretable than single drag |
| Monthly time step | Good | Sufficient for retirement horizon |
| Two regimes (Growth/Crisis) | Good | Captures main market dynamics |
| Historical bootstrap for calibration | Good | Data-driven, adapts to region |
| Variance-preserving regime decomposition | Good | Total σ is preserved exactly |
| Return clamping (−95% to +120% annual) | Conservative | Prevents simulation blow-ups |

---

## 11. Comparison with Industry Standards

| Feature | This Engine | Best Practice | Gap |
|---|---|---|---|
| Return model | Regime-switching block bootstrap | State-of-art | ✓ Block bootstrap preserves clustering |
| Fat tails | Cornish-Fisher + Student-t | Skew-t or Johnson SU | Minor; bootstrap dominates |
| Correlation | Equity-bond correlation parameter | Full DCC-GARCH | Partial (cash, time-varying not modeled) |
| Inflation | Regime-conditioned parametric | VAR(1) with returns | Good for complexity level |
| Ruin analysis | Full path simulation | Same | ✓ |
| Sequence risk | Quintile analysis of early returns | Kitces/Pfau methodology | ✓ |
| Spending rules | Fixed real | Guardrail / VPW | Future enhancement |
| Longevity | Fixed horizon | Mortality-weighted | Future enhancement |
| Reproducibility | Optional seeded PRNG | Seeded PRNG | ✓ Closed |

---

## 12. Development

```bash
npm install
npm run dev          # Start dev server
npm run build        # Production build
npm run test:unit    # Run unit tests
```

### Data Pipeline

```bash
node scripts/import-retirement-market-data.mjs    # Fetch raw data from Stooq/FRED
node scripts/preprocess-retirement-market-data.mjs # Generate historical-market-data.json
```

---

## 13. References

- Pfau, W. (2018). *How Much Can I Spend in Retirement?* — comprehensive comparison of variable spending strategies
- Bengen, W. (1994). *Determining Withdrawal Rates Using Historical Data* — original 4% SWR research
- Kitces, M. & Pfau, W. (2015). *Reducing Retirement Risk with a Rising Equity Glide Path* — sequence-of-returns risk analysis
- Ang, A. & Bekaert, G. (2002). *International Asset Allocation with Regime Shifts* — Markov regime-switching in portfolio theory
- Hamilton, J. (1989). *A New Approach to the Economic Analysis of Nonstationary Time Series and the Business Cycle* — foundational regime-switching model
- Politis, D. & Romano, J. (1994). *The Stationary Bootstrap* — block bootstrap methodology for dependent data
- Johnson, N. L. (1949). *Systems of Frequency Curves* — Johnson SU distribution for non-normal financial returns
