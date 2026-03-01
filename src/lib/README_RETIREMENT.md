# Retirement Monte Carlo Simulator — Technical Documentation

## 1. Overview

The retirement calculator uses **Monte Carlo simulation** with a **Markov regime-switching model** to project portfolio balances from the present age through a configurable end-of-life horizon. It generates probability-weighted outcome bands (P10–P90), estimates ruin probability, and computes FI (Financial Independence) targets. The simulation operates on **monthly time steps** with **inflation-adjusted (real) balances**.

### Design philosophy

| Aspect | Approach |
|---|---|
| Return generation | Regime-switching bootstrap from historical data, with parametric fallback |
| Inflation | Independent parametric monthly draws (shaped normal) |
| Cash flows | Age-gated income/spending periods + lump-sum events, all in real terms |
| Reproducibility | Optional seeded PRNG (`mulberry32`), default unseeded behavior when no seed is provided |
| Output | Percentile fan chart, FI targets (SWR-based and P95-based), ruin surface, sequence-risk quintile analysis |
| Multi-asset | Three-asset allocation (stocks / bonds / cash), blended with configurable equity-bond correlation |

---

## 2. Architecture

```
scripts/
  import-retirement-market-data.mjs    ← Fetches raw monthly prices from Stooq + FRED
  preprocess-retirement-market-data.mjs ← Converts to annual/monthly return series + moments

data/retirement/raw/*.csv              ← Monthly equity-close, bond-close, cash-rate per region

public/assets/retirement/
  historical-market-data.json          ← Preprocessed returns consumed at runtime

src/lib/retirement/
  retirementEngine.ts                  ← Core simulation engine (this review's focus)
  RetirementPlanner.svelte             ← UI: inputs, allocation blending, regime model construction, plotting
  index.ts                             ← Re-exports

src/lib/calculations.ts                ← RandomSource (seeded/unseeded RNG + Box-Muller cache), percentile, summarize
```

---

## 3. Data Pipeline

### 3.1 Sources per region

| Region | Equity | Bond | Cash |
|---|---|---|---|
| USD | S&P 500 (^SPX, Stooq) | Synthetic 10Y total return from GS10 yield (FRED), duration 7y | 3m T-bill TB3MS (FRED) |
| GBP | FTSE 100 (^UKX, Stooq) | Synthetic UK 10Y total return (IRLTLT01GBM156N), duration 7y | UK 3m interbank (IR3TIB01GBM156N) |
| EUR | Synthetic 60% DAX TR + 40% CAC (adjusted +3% PR div) | Synthetic DE 10Y total return (IRLTLT01DEM156N), duration 7y | EZ 3m interbank stitched with DE pre-euro |
| WORLD | 55% SPX + 20% UKX + 25% DAX | Weighted US/UK/DE 10Y bond returns | Average of US/UK/EUR cash rates |

### 3.2 Bond total return synthesis

Monthly bond returns are computed from yield changes:

$$r_{\text{bond}} = \frac{y_{t-1}}{1200} - D \cdot \frac{y_t - y_{t-1}}{100}$$

where $D = 7$ years (modified duration). This first-order approximation is reasonable for moderate yield changes but underestimates convexity effects in large yield moves.

### 3.3 Preprocessing

- Monthly price returns = $P_t / P_{t-1} - 1$
- Annual returns = compound product of 12 monthly returns within each calendar year
- Cash: monthly return = annual rate / 1200
- All series anchored to 1960+
- Statistical moments (mean, σ, skewness, kurtosis) computed with population formulas

---

## 4. Return Generation Model

### 4.1 Regime-switching Markov chain

The model distinguishes two market regimes:
- **State 0 (Growth):** normal market conditions
- **State 1 (Crisis):** elevated volatility and/or negative returns

**Transition matrix:**

$$P = \begin{bmatrix} p_{GG} & 1 - p_{GG} \\ 1 - p_{CC} & p_{CC} \end{bmatrix}$$

where $p_{GG}$ = "stay in growth" and $p_{CC}$ = "stay in crisis".

**Stationary distribution of growth:**

$$\pi_G = \frac{1 - p_{CC}}{2 - p_{GG} - p_{CC}}$$

Initial state is drawn from the stationary distribution. Default values (e.g. USD): $p_{GG} = 0.92$, $p_{CC} = 0.68$.

### 4.2 Regime detection (historical calibration)

When historical returns are available (≥ 25 annual or ≥ 120 monthly observations), regimes are detected empirically:

1. Compute long-run mean $\mu$ and standard deviation $\sigma$
2. Crisis threshold: $\mu - 0.65\sigma$ (annual) or $\mu - 0.75\sigma$ (monthly)
3. A period is labelled crisis if:
   - Its return falls below the crisis threshold, **or**
   - Rolling 3-year (annual) / 6-month (monthly) volatility exceeds $1.15\sigma$ (annual) / $1.2\sigma$ (monthly)
4. Single non-crisis periods sandwiched between two crises are reclassified as crisis (gap-filling)
5. Markov stay-probabilities are estimated by counting transitions in the label sequence

After detection, returns are partitioned into growth and crisis pools for **block bootstrap** sampling.

### 4.3 Return sampling — two modes

**Mode A — Monthly bootstrap (when ≥ 120 monthly data points):**
- Each month, the regime transitions via the monthly Markov chain
- A historical monthly return is drawn uniformly from the appropriate regime pool
- Used directly as the monthly asset return

**Mode B — Annual bootstrap + parametric noise (fallback):**
- At the start of each 12-month block, a historical annual return is drawn from the regime pool
- Converted to monthly: $r_m = (1 + r_a)^{1/12} - 1$
- Each month adds parametric noise via `drawMonthlyReturnShaped()` — a shaped normal with skewness and kurtosis adjustments
- Regime transitions occur monthly using annualized-to-monthly transition probabilities: $p_m = p_a^{1/12}$

**Parametric fallback (no historical data):**
- `buildBootstrapHistory()` generates a synthetic 120-year annual return series using:
  - Student-t draws (degrees of freedom derived from kurtosis)
  - Skewness shift term
  - Regime-switching mean/std

### 4.4 Shaped standard score generation (`drawShapedStandardScore`)

For non-normal return/inflation draws:

$$z' = z + 0.22 \cdot s \cdot (|z| - \sqrt{2/\pi}) + 0.08 \cdot \kappa_{\text{excess}} \cdot (z^2 - 1)$$

where $z \sim N(0,1)$, $s$ = bounded skewness $\in [-2.5, 2.5]$, $\kappa_{\text{excess}} = \max(0, \min(8, \kappa - 3))$.

This is a polynomial perturbation of a standard normal — it shifts the mode and fattens tails. It is **not** a Cornish-Fisher expansion or Johnson SU transform, but a pragmatic ad-hoc approach.

### 4.5 Clamping

| What | Min | Max |
|---|---|---|
| Annual return | -95% | +120% |
| Monthly return | -60% | +60% |
| Transition probability | 0.001 | 0.999 |

---

## 5. Simulation Loop (per path, per month)

For each of `N` simulation paths (default 3,000; preview 200):

```
balance = currentSavings
for each month m in [0 .. totalMonths):
    1. Regime transition (monthly Markov chain)
    2. Sample monthly asset return (bootstrap or parametric)
    3. Apply tax on gains: r_after_tax = r > 0 ? r * (1 - taxOnGainsPercent) : r
    4. Apply annual fee monthly: growth = (1 + r_after_tax) * (1 - annualFeePercent / 12)
    5. Sample monthly inflation (drawMonthlyReturnShaped)
    6. Net flow = (income_at_age - spending_at_age) / 12 + lump_sums
    7. balance += net_flow
    8. balance *= growth
    9. balance /= (1 + monthly_inflation)
   10. if balance ≤ 0: balance = 0, mark depleted
   11. Record balance
```

### 5.1 Cash flow model

- **Spending periods**: each has `[fromAge, toAge)`, yearly amount, and an `inflationAdjusted` flag
  - If inflation-adjusted (default): used at face value in real terms
  - If nominal: divided by the expected inflation index at that age
- **Income sources**: same structure as spending
  - Default salary runs `[currentAge, retirementAge)`
  - Default pension runs `[67, simulateUntilAge)`
- **Lump-sum events**: one-time additions/subtractions at a specific age

### 5.2 Drag model

The model separates costs into two parameters:

- `annualFeePercent` (default 0.5%): applied to portfolio value every month as $(1 - \text{annualFeePercent}/12)$
- `taxOnGainsPercent` (default 15%): applied only to positive monthly returns

This removes the old `annualDrag` ambiguity and aligns labels with mechanics.

### 5.3 Inflation model

Monthly inflation is drawn independently from a shaped normal distribution:

$$r_{\text{inf}} = \frac{\mu_{\text{inf}}}{12} + \frac{\sigma_{\text{inf}}}{\sqrt{12}} \cdot z'$$

The balance is deflated each month: $\text{balance} \leftarrow \text{balance} / (1 + r_{\text{inf}})$.

All output balances are therefore in **real (today's purchasing power) terms**.

---

## 6. Portfolio Construction (UI Layer)

### 6.1 Three-asset allocation

Users set allocation via two slider boundaries: stocks % and (stocks+bonds) %. The complement is cash.

Default: 60% stocks / 30% bonds / 10% cash.

### 6.2 Blending

The blended portfolio moments use a configurable equity-bond correlation input `equityBondCorrelation` (cash correlation terms are currently treated as 0):

$$\mu_p = \sum_i w_i \mu_i$$
$$\sigma_p^2 = \sum_i (w_i \sigma_i)^2 + 2w_{eq}w_{bond}\sigma_{eq}\sigma_{bond}\rho_{eq,bond}$$

When historical market data is available, the UI estimates $\rho_{eq,bond}$ from the selected region series and uses it as the default.

Skewness and kurtosis are blended using the third and fourth powers of $w_i \sigma_i$.

### 6.3 Regime model construction from portfolio

The UI constructs regime model parameters from blended portfolio metrics and a region-specific template:

1. Stationary probabilities $\pi_G, \pi_C$ derived from template stay-probabilities
2. Growth/crisis means separated by a `meanSpread` (adjusted for excess kurtosis and skewness)
3. Growth/crisis standard deviations set via multipliers of a shared scale factor
4. The shared scale factor is calibrated so that the **total variance matches the portfolio variance** (variance-preserving decomposition)

---

## 7. Output Metrics

### 7.1 Percentile fan chart
P10, P25, P50, P75, P90 balance trajectories over the full time horizon.

### 7.2 FI targets

| Target | Definition |
|---|---|
| FI Target (SWR) | $\text{spending at retirement age} / \text{SWR}$ (default SWR = 4%) |
| FI Target (P95) | Minimum balance at retirement age such that ≥ 95% of paths with balances ≥ that threshold end above zero. Found by sorting simulations by retirement-age balance and scanning for the 95% success cutoff. |

### 7.3 Ruin analysis

- **Success probability**: fraction of paths that never deplete (balance > 0 at end)
- **Shortfall**: cumulative deficit for depleted paths (P10, P50, P90)
- **Depleted years**: total years spent at zero balance (P10, P50, P90)

### 7.4 Sequence-risk quintile analysis

Simulations are sorted by mean real return in the first 10 post-retirement years, then grouped into quintiles. For each quintile: mean early return, ruin probability, ending median balance.

### 7.5 Ruin surface

A 5×5 grid of ruin probabilities across:
- Retirement ages: [retAge-6, retAge-3, retAge, retAge+3, retAge+6]
- Spending multipliers: [0.8, 0.9, 1.0, 1.1, 1.2]

Each cell re-runs cashflow arrays and replays growth factors (max 800 paths) to estimate ruin probability.

---

## 8. Correctness Review — Verified Aspects

### 8.1 Unit consistency ✓

| Item | Unit | Notes |
|---|---|---|
| All returns | Decimal (0.08 = 8%) | Consistent throughout |
| Annual → monthly conversion | $(1 + r_a)^{1/12} - 1$ | Correct compounding formula |
| Annual σ → monthly σ | $\sigma_a / \sqrt{12}$ | Standard square-root-of-time scaling (assumes i.i.d. — acceptable for parametric draws) |
| Inflation deflation | $\div (1 + r_{\text{inf}})$ | Correct real-terms conversion |
| Cash flows | Annual amounts ÷ 12 | Consistent monthly stepping |
| SWR target | Annual spending ÷ SWR rate | Correct standard definition |

### 8.2 Random number generation ✓

- RNG now supports optional seeding via `RandomSource` (`mulberry32`) for reproducible simulations/tests
- Box-Muller spare cache is encapsulated per RNG instance (no shared module-level mutable spare state)
- Student-t generation via ratio of normal to chi-squared is the standard method
- Regime initialization from stationary distribution is correct

### 8.3 Percentile computation ✓

Linear interpolation between ranks — standard method matching NumPy's default (`method='linear'`).

### 8.4 Regime stationary distribution ✓

$$\pi_G = \frac{1 - p_{CC}}{(1 - p_{GG}) + (1 - p_{CC})}$$

Correct derivation from the balance equation $\pi P = \pi$.

---

## 9. Issues Found — Prioritized Action Plan

### Priority 1 — Correctness Issues

#### P1.1 — Zero cross-asset correlation assumption in portfolio blending ✅ Implemented

**Current implementation:** $\sigma_p^2 = \sum_i (w_i \sigma_i)^2 + 2w_{eq}w_{bond}\sigma_{eq}\sigma_{bond}\rho_{eq,bond}$.

**Problem:** In reality, equity-bond correlation is typically $\rho \approx -0.2$ to $+0.4$ depending on monetary regime. Ignoring correlations **understates** portfolio risk when correlations are positive (which is more common in inflationary regimes) and **overstates** diversification benefit. For a 60/30/10 portfolio, the error in σ can be 1-3 percentage points.

**Status:** Added `equityBondCorrelation` (default −0.1), covariance-based blending, and historical estimation from loaded market data.

#### P1.2 — Drag applied asymmetrically (only to positive returns) ✅ Implemented

**Current implementation:**
- Tax on gains is applied only to positive returns
- Annual fee is applied monthly on portfolio value regardless of return sign

**Problem:** A 20% drag on positive returns only is extremely aggressive. In practice:
- Fund management fees (TER ~0.2-0.5%) apply to AUM regardless of returns
- Transaction costs apply to trades regardless of direction
- Taxes do apply only to realized gains, but 20% of all positive monthly returns far exceeds reality

**Impact:** With 20% drag applied per positive month, the effective annual drag on a typical ~8% nominal return is ~1.5-2% per year — roughly in the right ballpark for a high-fee, taxable scenario, but the mechanism is non-standard and confusing. The label "annual drag" is misleading since it's applied monthly to gross-positive returns.

**Status:** Implemented as `annualFeePercent` + `taxOnGainsPercent` with defaults 0.5% and 15%.

#### P1.3 — Inflation applied independently from returns (no correlation)

**Current:** Inflation and asset returns are drawn from independent distributions.

**Problem:** In reality, inflation and nominal returns are correlated — equities have moderate positive long-run correlation with inflation (partial inflation hedge), bonds have negative correlation with unexpected inflation, and cash rates track expected inflation. Ignoring this correlation:
- Understates the joint tail risk (high inflation + poor equity returns, as in 1970s)
- Overstates diversification benefit of holding nominal bonds
- The model's real-return distribution may have lighter tails than reality

**Fix (moderate complexity):** Draw regime-conditioned inflation (higher mean inflation in crisis regimes). This captures the most important correlation channel without requiring a full multivariate model.

#### P1.4 — Monthly bootstrap samples are i.i.d. within regime

**Current:** Each month, a random historical monthly return is drawn from the regime pool (with replacement). This destroys all autocorrelation structure — momentum, mean reversion, volatility clustering within regimes.

**Problem:** Historical monthly returns exhibit significant short-term autocorrelation:
- Volatility clustering (GARCH-like behavior) within regimes is lost
- Momentum effects (3-12 month) within regimes are eliminated
- This tends to **understate** tail risk since the bootstrap cannot reproduce multi-month drawdown sequences

**Fix:** Use **block bootstrap** — sample contiguous blocks of 3-12 months from the historical data within each regime. This preserves intra-regime time-series structure.

#### P1.5 — Assumption-to-engine mismatch in custom mode inputs

**Current:** UI assumption rows (mean/vol/skew/kurt for instruments and inflation) update portfolio and real-return CDF, but Monte Carlo can still be driven primarily by historical bootstrap pools.

**Problem:** Users can see one distribution in inputs/CDF and a materially different distribution in simulation outcomes.

**Fix:** Introduce explicit global simulation mode and make the active generator unambiguous:
- **Historical bootstrap mode** (optionally moment-targeted to user assumptions)
- **Parametric mode** (fully assumption-driven)

#### P1.6 — RNG implementation duplication across modules ✅ Implemented

**Current implementation:** `calculations.ts` provides `RandomSource` with `mulberry32` which is imported and used consistently across `retirementEngine.ts` and other simulation paths.

**Problem:** Documentation and runtime implementation could drift; reproducibility characteristics differed by module (the legacy engine RNG used an older LCG and discarded the spare normal).

**Status:** Resolved by consolidating RNG implementation and removing the legacy PRNG from `retirementEngine.ts`.

---

### Priority 2 — Methodology Improvements

#### P2.1 — Bond return model is first-order only

**Current:** $r = \text{carry} - D \cdot \Delta y$

**Problem:** This ignores convexity. For large yield changes (>100bp), the approximation can miss 50-150bp of total return. Bonds with higher duration or in volatile rate environments are most affected.

**Fix:** Add convexity term: $r = \text{carry} - D \cdot \Delta y + \frac{1}{2} C \cdot (\Delta y)^2$ where $C \approx D \cdot (D+1)$ for a zero-coupon approximation.

#### P2.2 — Shaped normal distribution is ad-hoc

**Current:** `drawShapedStandardScore` uses a polynomial perturbation of a standard normal to approximate non-Gaussian returns.

**Problem:** This is not a recognized statistical distribution and its actual skewness/kurtosis output may not match the input parameters. The relationship between inputs $s, \kappa$ and realized moments is approximate. For financial returns, better-studied options exist:
- **Cornish-Fisher expansion** (invertible, explicit moment matching)
- **Johnson SU distribution** (flexible 4-parameter family)
- **Skew-t distribution** (natural for fat-tailed financial data)

**Impact:** Low — the shaped-normal perturbation produces qualitatively reasonable behavior and the main return dynamics come from the regime-switching + bootstrap path.

**Fix:** Replace with Johnson SU or Cornish-Fisher expansion for parametric draws. Add a calibration test that verifies the realized moments of 100,000 draws match the input parameters.

#### P2.3 — No tax modeling beyond flat drag

**Current:** Single flat drag parameter conflates fund expenses, platform fees, and taxes.

**Problem:** Tax treatment of investment returns varies enormously by jurisdiction and account type. Key missing distinctions:
- Tax-deferred accounts (401k, ISA, pension pot) vs. taxable accounts
- Capital gains tax vs. dividend withholding tax
- Tax-loss harvesting effects
- Dutch Box 3 (deemed-return tax on wealth, not actual gains)

**Fix:** For a personal calculator, even a simple two-bucket model (tax-advantaged % vs. taxable %, with different drags) would be a significant improvement.

#### P2.4 — No volatility term in expected wealth growth

**Current:** The regime model correctly uses geometric returns implicitly (through multiplicative compounding), but the summary statistics report arithmetic mean rather than the more decision-relevant geometric mean.

**Problem:** The mean of simulated returns is the arithmetic mean, but wealth grows at the geometric mean $\approx \mu - \sigma^2/2$. The `returnMoments` output already computes both, but the FI target calculations and the UI primarily reference arithmetic means.

**Impact:** Users may overestimate expected growth. With σ = 17%, the arithmetic-to-geometric drag is ~1.4%/year.

**Fix:** Display geometric mean prominently in the UI; use it for any "expected" balance projections.

#### P2.5 — Ruin surface uses shared growth factors but different cashflows

**Current:** `buildRuinSurface()` reuses the growth factor paths from the main simulation but constructs new cashflow arrays for each (retAge, spending) combination. This means the asset returns are held constant while only cashflow timing changes.

**Problem:** This is computationally efficient and directionally correct, but it creates a subtle inconsistency: the income source with `id === 'is-default'` (salary) has its `toAge` adjusted, but other income sources that might be salary-dependent are not.

**Fix:** Minor — document this as a fast approximation. The 800-path subsampling is also aggressive for tail probabilities in the surface.

---

### Priority 3 — Robustness & Quality

#### P3.1 — No unit tests for the simulation engine

**Current:** No test files exist for `retirementEngine.ts`.

**Problem:** A Monte Carlo engine with complex regime-switching logic is inherently difficult to debug. Without tests:
- Regressions in moment-matching, cash flow logic, or edge cases can go undetected
- Impossible to verify that the shaped-normal or Student-t draws produce correct distributional properties

**Fix:** Add a comprehensive test suite:
- `drawShapedStandardScore`: verify that 100k draws produce moments within tolerance of input parameters
- `buildCashflowArrays`: deterministic test for known spending/income schedules
- `spendingAtAge` / `incomeAtAge`: edge-case boundary tests (exact fromAge, exact toAge)
- `runMonteCarloSimulation`: seeded smoke test verifying output structure + basic sanity (median > 0 for reasonable inputs)
- `detectRegimes`: test with a known synthetic series
- `findRetirementBalanceTarget`: test with a hand-constructed example

#### P3.2 — Reproducibility (no seeded RNG) ✅ Implemented

**Current implementation:** Optional `seed` in `RetirementInput`; simulations are deterministic when seed is set.

**Problem:** Impossible to reproduce a specific simulation run for debugging or comparison. Also makes automated testing difficult.

**Status:** Implemented with `mulberry32`-backed `RandomSource`; default behavior remains stochastic when no seed is supplied.

#### P3.3 — Global mutable state in `randomNormal` ✅ Implemented

**Current implementation:** Box-Muller spare normal is encapsulated per `RandomSource` instance.

**Status:** Resolved by RNG-instance encapsulation.

#### P3.4 — `annualDrag` default (20%) label mismatch ✅ Implemented

**Current implementation:** Separate UI inputs and engine parameters for annual fee and tax-on-gains.

**Problem:** 20% is confusing — it's not 20% of the portfolio per year, but 20% of each positive monthly return. The effective annual drag depends on the return distribution. Users unfamiliar with the mechanism will misinterpret this.

**Status:** Restructured to explicit annual fee + tax-on-gains model.

#### P3.5 — EUR equity proxy is DAX+CAC only ✅ Implemented

**Current implementation:** EUR equities are 60% DAX Total Return + 40% CAC Price Return augmented with a synthetic 3% annual dividend.

**Problem:** This is a Germany + France proxy, not a eurozone-wide or pan-European index. It misses Dutch, Spanish, Italian, Finnish, and other markets. The DAX is a total-return index (includes dividends); CAC is typically price-only. Mixing them without dividend adjustment created an upward bias for the DAX component and downward bias for CAC. Broader indices like EURO STOXX 50 lack data before 1986.

**Impact:** Moderate — for a pan-European allocation, MSCI Europe or STOXX Europe 600 would be more representative, but they lack the 1970s stagflation cycle data.

**Status:** Retained the DAX+CAC blend to preserve critical 1970s stagflation data, but added a 3% synthetic annual dividend to the CAC component in the data importer to correct the Price Return vs Total Return discrepancy.

#### P3.6 — World equity blend weights are hard-coded

**Current:** World = 55% S&P 500 + 20% FTSE 100 + 25% DAX.

**Problem:** Real-world global market-cap weights are approximately: US ~62%, Europe ~15%, Japan ~6%, UK ~4%, etc. The current weights overweight UK and Europe relative to market-cap. Japan and emerging markets are missing entirely.

**Fix:** Either align weights to current market-cap percentages and add Japan + EM proxies, or document clearly that this is a "developed-market Western blend proxy" rather than a true world index.

---

### Priority 4 — Enhancements

#### P4.1 — Add Monte Carlo convergence diagnostic

Report the standard error of key outputs (success probability, median final balance) as a function of simulation count. This lets users see whether 3,000 simulations is sufficient. Standard error of a proportion: $SE = \sqrt{p(1-p)/N}$.

#### P4.2 — Consider mortality tables

**Current:** `simulateUntilAge` is fixed (default 90).

**Problem:** Longevity risk is a key retirement concern. A fixed endpoint underestimates the risk for long-lived individuals and overestimates it for shorter-lived ones.

**Fix:** Optionally integrate a life table (e.g., WHO or national actuarial tables) so each simulation path draws a random death age. This converts "ruin at a fixed age" to "ruin before death" — the more meaningful metric.

#### P4.3 — Consider dynamic spending strategies

**Current:** Spending is fixed in real terms (or nominal with a known inflation index).

**Problem:** In practice, retirees adjust spending in response to portfolio performance (guardrail strategies, Guyton-Klinger, VPW). Fixed spending overstates ruin probability because it assumes no behavioral adaptation.

**Fix:** Implement at least one adaptive strategy (e.g., Guyton-Klinger guardrails: reduce spending by X% if portfolio drops below Y% of initial; increase by X% if portfolio rises above Z%).

#### P4.4 — Social Security / pension optimization

**Current:** Pension is a flat income source from a fixed age.

**Fix:** Allow modeling of claiming-age-dependent benefit amounts (e.g., US Social Security at 62 vs 67 vs 70).

#### P4.5 — Web Worker offloading

**Current:** Simulation runs on the main thread.

**Fix:** Move `runMonteCarloSimulation` to a Web Worker to avoid UI blocking during the 3,000-path simulation.

#### P4.6 — Optimize Student-t generation

**Current:** `drawStudentT` calls `rng.normal` $df$ times per month to generate a chi-squared distribution ($df$ can be 40+). This wastes $\sim 1.4\times 10^7$ RandomSource cycles per simulation.

**Fix:** Implement a Gamma-based exact chi-squared generator (e.g. Marsaglia and Tsang method) to draw a single random variable instead.

---

## 10. Summary of Key Assumptions

| Assumption | Status | Risk |
|---|---|---|
| Returns are regime-switching but i.i.d. within regime | Simplification | Understates clustered drawdowns |
| Equity-bond correlation is configurable; cash correlation fixed at 0 | Partial simplification | Improves portfolio σ realism; still not full correlation matrix |
| Independent inflation | Simplification | Misses 1970s-type correlated shocks |
| Fixed spending in real terms | Simplification | Overstates ruin probability |
| Split fee/tax costs (`annualFeePercent`, `taxOnGainsPercent`) | Improved | More interpretable and realistic than single drag |
| Monthly time step | Good | Sufficient for retirement horizon |
| Regime model covers Growth/Crisis only | Good | Captures main market dynamics |
| Historical bootstrap for calibration | Good | Data-driven, adapts to chosen region |
| Variance-preserving regime decomposition | Good | Total portfolio σ is preserved |
| Clamps on returns | Conservative | Prevents simulation blow-ups |

---

## 11. Comparison with Industry Standard Approaches

| Feature | This Engine | Industry Best Practice | Gap |
|---|---|---|---|
| Return model | Regime-switching bootstrap | Regime-switching is state-of-art. Bootstrap > parametric-only. | Monthly i.i.d. within regime (block bootstrap preferred) |
| Fat tails | Student-t + shaped normal | Skew-t or Johnson SU, or historical bootstrap | Ad-hoc perturbation; impact is minor since bootstrap dominates |
| Correlation | Equity-bond correlation parameter (historically estimated when data exists) | Full dynamic covariance / DCC-GARCH | Partial gap (cash and time-varying correlation not modeled) |
| Inflation | Independent parametric | Regime-conditioned or VAR(1) with returns | Missing correlation — P1 priority |
| Ruin analysis | Full path simulation | Same | Good |
| Sequence risk | Quintile analysis of early returns | Same methodology as Kitces/Pfau research | Good |
| Spending rules | Fixed real | Guardrail / VPW / floor-ceiling | Enhancement opportunity |
| Longevity | Fixed horizon | Mortality-weighted | Enhancement opportunity |
| Reproducibility | Optional seeded PRNG | Seeded PRNG | Largely closed |

---

## 12. References

- Pfau, W. (2018). *How Much Can I Spend in Retirement?* — comprehensive comparison of variable spending strategies
- Bengen, W. (1994). *Determining Withdrawal Rates Using Historical Data* — original 4% SWR research
- Kitces, M. & Pfau, W. (2015). *Reducing Retirement Risk with a Rising Equity Glide Path* — sequence-of-returns risk analysis
- Ang, A. & Bekaert, G. (2002). *International Asset Allocation with Regime Shifts* — Markov regime-switching in portfolio theory
- Hamilton, J. (1989). *A New Approach to the Economic Analysis of Nonstationary Time Series and the Business Cycle* — foundational regime-switching model
- Politis, D. & Romano, J. (1994). *The Stationary Bootstrap* — block bootstrap methodology for dependent data
- Johnson, N. L. (1949). *Systems of Frequency Curves* — Johnson SU distribution for non-normal financial returns

---

## 13. Implementation Plan

### Phase 1 — Foundations (correctness & testability)

Focus: fix the issues that affect numerical correctness and make the engine testable.

| # | Task | Effort | Files |
|---|---|---|---|
| 1.1 | **Add seeded PRNG** — ✅ Implemented. Optional `seed` in `RetirementInput` works in engine. RNG implementation consolidated to use `mulberry32` from `calculations.ts`. | S | `calculations.ts`, `retirementEngine.ts` |
| 1.2 | **Unit test scaffold** — ✅ Implemented and verified. `retirementEngine.test.ts` contains seed-based tests for `spendingAtAge`, `incomeAtAge`, `buildCashflowArrays`, `detectRegimes` (synthetic series), `drawShapedStandardScore` (moment check on 100k draws), `findRetirementBalanceTarget` (hand-crafted example), and `runMonteCarloSimulation` (smoke: output shape + median > 0). | M | `retirementEngine.test.ts` |
| 1.3 | **Fix global mutable `spareNormal`** — ✅ Implemented in `calculations.ts` `RandomSource`; engine uses this safely encapsulated cache. | S | `calculations.ts`, `retirementEngine.ts` |
| 1.4 | **Restructure drag model** — ✅ implemented as `annualFeePercent` + `taxOnGainsPercent`, with updated UI labels/defaults (0.5% / 15%). | M | `retirementEngine.ts`, `RetirementPlanner.svelte` |
| 1.5 | **Add cross-asset correlation** — ✅ implemented `equityBondCorrelation` (default −0.1), covariance blending, and historical sample-correlation defaults. | M | `RetirementPlanner.svelte`, `retirementEngine.ts` |
| 1.6 | **Add global simulation mode toggle** — ✅ Implemented and enhanced. Switched to toggle buttons instead of a combobox. In Historical mode, the inputs for stocks, bonds, cash, and inflation are explicitly disabled to reflect they are driven by the empirical dataset. | M | `PlannerInputPanel.svelte`, `RetirementPlanner.svelte`, `retirementEngine.ts` |

**Checkpoint:** all existing behavior reproduced (seed = undefined), tests pass, drag and correlation produce more realistic σ, and mode selection is explicit and consistent across preview/full runs.

---

### Phase 2 — Return generation quality

Focus: improve the realism of the return-generation path.

| # | Task | Effort | Files |
|---|---|---|---|
| 2.1 | **Block bootstrap** — ✅ Implemented completely. Changed monthly bootstrap from i.i.d. to contiguous blocks (default 6 months, randomized start within regime pool). Preserves momentum and volatility clustering. | M | `retirementEngine.ts` |
| 2.2 | **Regime-conditioned inflation** — ✅ Implemented completely. In crisis regime, inflation mean shifts upward by a configurable spread (default +1.5pp). Drawn from the regime-conditioned distribution. | S | `retirementEngine.ts` |
| 2.3 | **Replace shaped-normal with Cornish-Fisher** — ✅ Implemented completely. Replaced `drawShapedStandardScore` with 4-term Cornish-Fisher expansion `drawCornishFisherScore` for the parametric fallback path. Added a calibration test comparing realized vs target moments. | S | `retirementEngine.ts`, `retirementEngine.test.ts` |
| 2.4 | **Bond convexity term** — ✅ Implemented completely. In `monthlyBondReturnsFromYield`, added $+\frac{1}{2}D(D+1)(\Delta y)^2$ convexity correction. Regenerated world market datasets. | S | `import-retirement-market-data.mjs` |
| 2.5 | **Moment-targeted historical mode** — ✅ Implemented completely. Wired a `historicalMomentTargeting` toggle into Svelte so users can optionally unlock parametric inputs in Historical Mode, allowing the engine's `applyMomentTargeting` affine transformation to shift empirical sequences to custom bounds. | M | `retirementEngine.ts`, `RetirementPlanner.svelte` |

**Checkpoint:** historical mode preserves sequence realism and can optionally match user targets; parametric mode remains fully assumption-driven.

---

### Phase 3 — Data quality & UI

Focus: improve data proxies and surface better information to the user.

| # | Task | Effort | Files |
|---|---|---|---|
| 3.1 | **Fix EUR equity proxy** — ✅ Implemented. Retained DAX + CAC proxy for deep history, but added a 3% synthetic annual dividend to CAC to correct PR vs TR discrepancy. | S | `import-retirement-market-data.mjs` |
| 3.2 | **Fix world blend weights** — update to approximate market-cap weights (US 60%, EUR 20%, UK 8%, Japan 12%) and add a Japan equity proxy (^NKX). | M | `import-retirement-market-data.mjs` |
| 3.3 | **Display geometric mean** — show geometric mean prominently in the summary panel alongside arithmetic mean. Add a tooltip explaining the difference and the variance drag formula. | S | `RetirementPlanner.svelte` |
| 3.4 | **Convergence diagnostic** — after simulation, compute and display the standard error of the success probability: $SE = \sqrt{p(1-p)/N}$. Show a "convergence quality" indicator. | S | `retirementEngine.ts`, `RetirementPlanner.svelte` |
| 3.5 | **Rename drag UI** — if not already restructured in 1.4, at minimum rename "Annual drag" to "Annual fee (TER + platform)" and add a separate "Tax on gains" field. | S | `RetirementPlanner.svelte` |
| 3.6 | **Mode transparency in UI** — show active mode badge, effective moments used by simulator, and warning text when displayed assumptions differ from simulation driver. | S | `RetirementPlanner.svelte`, `PlannerInputPanel.svelte` |

**Checkpoint:** users can clearly tell which mode is active and which moments were actually used in the run.

---

### Phase 4 — Advanced features

Focus: optional enhancements for power users.

| # | Task | Effort | Files |
|---|---|---|---|
| 4.1 | **Web Worker** — move `runMonteCarloSimulation` to a Web Worker. Post input, receive result. Show progress bar. | M | new `retirementWorker.ts`, `RetirementPlanner.svelte` |
| 4.2 | **Dynamic spending (Guyton-Klinger guardrails)** — add an optional spending strategy: cut spending by 10% if portfolio drops below 80% of initial; raise by 10% if above 120%. | M | `retirementEngine.ts`, `RetirementPlanner.svelte` |
| 4.3 | **Mortality-weighted ruin** — optionally draw a death age from a life table (e.g., WHO period life table). Report "probability of ruin before death" instead of "ruin at fixed age." | M | `retirementEngine.ts`, new `mortalityTable.ts` |
| 4.4 | **Two-bucket tax model** — allow users to specify % of savings in tax-advantaged vs taxable accounts, with different drag rates per bucket. | M | `retirementEngine.ts`, `RetirementPlanner.svelte` |
| 4.5 | **Social Security claiming optimization** — allow benefit amounts that vary by claiming age (e.g., US: 70% at 62, 100% at 67, 124% at 70). | S | `RetirementPlanner.svelte` |
| 4.6 | **Advanced dual-mode controls (optional)** — keep global mode as default, add optional expert controls for mode-specific calibration knobs and deterministic zero-vol override behavior. | M | `retirementEngine.ts`, `RetirementPlanner.svelte` |
| 4.7 | **Optimize Student-t generation** — replace the $O(df)$ chained-normal method with a Gamma-based $O(1)$ method algorithm (e.g. Marsaglia and Tsang) for generating chi-square deviates. | M | `retirementEngine.ts` |
| 4.8 | **Separate states for Historical vs Parametric moments** — ✅ Implemented completely. `historicalMetrics` vs `parametricMetrics` allow for a clear separation. | S | `RetirementPlanner.svelte`, `PlannerInputPanel.svelte` |
| 4.9 | **Expose Expert Engine Controls** — Expose the new `blockLength` (for block bootstrap) and `inflationCrisisSpread` variables as editable inputs the `PlannerInputPanel.svelte` for power users. | S | `PlannerInputPanel.svelte`, `RetirementPlanner.svelte` |
| 4.10 | **Visualizing Regimes in Charts** — Shade background of `PlannerTimelinePlot` to reflect periods of "Crisis" vs "Growth" for median outcomes or add a probability heatmap to help users intuitively grasp the regime switches. | M | `PlannerTimelinePlot.svelte` |
| 4.11 | **Factor Tilts (Small-Cap / Value)** — Current equity proxies are strictly large-cap blend limits. Incorporating small-cap or value datasets (e.g., Russell 2000) could let users model explicitly tilted factor portfolios, which historically offer a different sequence-of-return risk profile. | M | `import-retirement-market-data.mjs`, `RetirementPlanner.svelte` |
| 4.12 | **Extended Eurozone Expansion** — Since we fixed the CAC PR gap with a synthetic dividend, we could further improve the Eurozone proxy in the future by adding AEX (Netherlands) and IBEX (Spain) data from the 1980s onward, stitching them onto the DAX/CAC long-run core to broaden geopolitical representation. | M | `import-retirement-market-data.mjs` |

**Checkpoint:** main thread stays responsive; advanced users can refine both Historical and Parametric workflows without ambiguity.

---

### Effort key

| Label | Estimate |
|---|---|
| **S** (small) | < 2 hours |
| **M** (medium) | 2–6 hours |
| **L** (large) | 6+ hours |

### Recommended execution order

```
Phase 1  →  Phase 2  →  Phase 3  →  Phase 4
(1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6)  then  (2.1 → 2.2 → 2.3 → 2.4 → 2.5)  then ...
```

Phase 1 items are sequential (1.1 unblocks 1.2; 1.3 is part of 1.1). Phases 2–4 items are mostly independent within each phase and can be parallelized, with mode-consistency tasks prioritized before UI polishing.
