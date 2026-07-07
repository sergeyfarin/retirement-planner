# Project Roadmap & Backlog

**Updated:** 2026-07-07 (full engine + data-pipeline review; new Priority 0 added).
Completed phases are summarized at the bottom. Items ordered by strategic priority.

---

## Priority 0 — Correctness & Data Quality (found 2026-07-07)

These bias current results **materially pessimistic** and should land before new features.

### 0.1 US and UK equity series exclude dividends (M) — biggest wrong-answer fix
**Current:** `scripts/import-retirement-market-data.mjs` builds equity returns from Stooq
`^SPX` and `^UKX` monthly *price* closes. The EUR proxy uses `^DAX` (total-return by
construction) + `^CAC` with a synthetic +3%/yr dividend yield — but SPX and UKX get no
dividend adjustment at all.
**Impact:** US/GBP returns understated by ~2.5–3.5%/yr (dataset US arithmetic mean is
8.9% nominal 1961–2025 vs ~11.5% total return). All USD/GBP success probabilities, FI
targets and ruin surfaces are systematically pessimistic, and regions are not comparable
(EUR ≈ total return, USD/GBP ≈ price only).
**Action:** Apply the same synthetic-dividend stitching used for CAC — ideally
time-varying (US: ~3.5% pre-1990, ~2% post-2000) — or switch to total-return sources
(e.g. FRED `SP500TR` post-1988 stitched with Shiller data pre-1988). Re-check WORLD
components (`^NKX`, `^HSI`) for the same issue. Update README §3.1 when fixed.
**Files:** `scripts/import-retirement-market-data.mjs`, `scripts/preprocess-retirement-market-data.mjs`

### 0.2 Tax-on-gains model overstates drag ~3–4× (M)
**Current:** every *month* with a positive return is taxed at `taxOnGainsPercent`
(default 15%) with no loss offset (`simulation.rs` ~line 406; same in TS engine).
**Impact:** for a portfolio at ~4.6% monthly σ / ~0.6% monthly mean, the expected
positive part is ~2.2%/month → effective drag ~4%/yr instead of the ~1%/yr a user means
by "15% tax on gains". No jurisdiction taxes upside-only monthly mark-to-market.
Combined with 0.1, defaults can understate 30-year median outcomes by a large multiple.
**Action:** apply tax **annually** on net annual gain (losses untaxed, optionally
carried forward), or fold into the three-bucket model (2.3). For NL users add a Box 3
wealth-tax mode (% of balance above threshold per year) instead of a gains tax.
**Files:** `rust-engine/src/simulation.rs`, `src/lib/retirementEngine.ts`, `PlannerInputPanel.svelte`, README §5.2

### 0.3 Nominal cashflows deflated by *expected*, not realized, inflation (M)
**Current:** `build_cashflow_arrays` precomputes flows using the deterministic index
`(1+inflationMean)^years`, while balances are deflated by the *stochastic* per-path
inflation. `inflationAdjusted: false` items (fixed annuities, nominal pensions,
fixed-rate mortgage payments) therefore never feel a high-inflation path — exactly the
risk they carry in reality.
**Action:** track the realized inflation index per simulation and deflate nominal items
by it. Implementation: split net flow into `realFlow` + `nominalFlowAtToday` arrays;
each month apply `nominalFlowAtToday[m] * expectedIndex[m] / realizedIndex[m]`.
**Files:** `rust-engine/src/engine2.rs` (cashflow arrays), `simulation.rs` loop, TS mirror

### 0.4 Historical bootstrap severs the return–inflation correlation (M/L)
**Current:** nominal historical returns are bootstrapped while inflation is drawn from
an independent parametric Cornish-Fisher process. Historically the worst real-return
periods (1970s) pair mediocre nominal returns with high inflation; independence
understates real-return tail risk. Parametric monthly inflation is also i.i.d. (no
persistence) — the regime spread only partially compensates.
**Action:** extend the dataset with monthly CPI per region (FRED: `CPIAUCSL`,
`GBRCPIALLMINMEI`, `CP0000EZ19M086NEST`, …) and block-bootstrap **(return, inflation)
pairs from the same historical months**. Bootstrapped CPI carries its own
autocorrelation, fixing both problems at once. Keep the parametric path as fallback.
**Files:** data scripts, `structs.rs`, `simulation.rs`, planner wiring

### 0.5 Kurtosis blending biased low (S)
`blendPortfolioMetrics` omits the `6·σᵢ²σⱼ²` cross-terms in the fourth moment of a sum:
a blend of two independent normals comes out with kurtosis < 3, so the Student-t df
mapping sees no excess kurtosis and generates thinner tails than intended.
**Action:** add cross-terms for the independent case (and the equity–bond correlation
term if feasible), or blend excess kurtosis on variance weights as an approximation.
**Files:** `src/lib/calculations.ts`, `RetirementPlanner.svelte` local copy (see 1.2)

### 0.6 Seed & fingerprint nits (S)
- `input.seed || Math.floor(random)` treats seed `0` as unset — use explicit check.
- `previewTriggerKey` excludes the seed, so "stale results" detection misses seed changes.
- Surface the auto-generated seed in the UI after a run so any result can be reproduced.
**Files:** `RetirementPlanner.svelte`

### 0.7 Annual-mode bootstrap flattens intra-year volatility (S, documented limitation)
When monthly history is unavailable, one sampled annual return becomes a constant
monthly rate for 12 months — understates monthly-granularity ruin and interacts with the
tax asymmetry (0.2). Rarely triggered since all four regions ship monthly data; document
in README §4.3 Mode B and revisit only if the parametric mode gains users.

---

## Priority 1 — Engineering Health

### 1.1 Cross-engine parity test (S/M) — do this before further engine features
The production engine is Rust/WASM but **only the unused TS engine has tests**
(`retirementEngine.test.ts`). Drift already exists (e.g. the `taxOnGainsPercent ??
annualDrag` fallback lives only in the TS engine). Add a seeded parity test: same
inputs + seed through both engines → summary stats agree within tolerance. Run in CI via
`wasm-pack test` or a Node harness loading the built WASM.

### 1.2 De-duplicate planner-local math (S)
`RetirementPlanner.svelte` contains full local copies of ~8 functions that also exist in
`calculations.ts` (imported with `calc*` aliases): `blendPortfolioMetrics`,
`getAllocationSplit`, `summarizeSeriesDistribution`, `sampleCorrelation`,
`estimateEquityBondCorrelation`, `getHistoricalInvestmentMetrics`,
`buildPortfolioHistoricalReturns`, `buildRegimeModelFromPortfolio`, … The local copies
are mostly dead — delete them and keep the imports.

### 1.3 Decide the TS engine's fate (S)
`retirementEngine.ts` (897 lines) duplicates the Rust engine. Either delete the
simulation path (keeping only `validateSimulationInputs`, `spendingAtAge`, types) or
keep it explicitly as the reference implementation guarded by the parity test (1.1).
Don't leave it ambiguous.

---

## Priority 2 — Enhanced Modeling Logic

### 2.1 Dynamic Spending Strategies (M)
**Current:** Spending is fixed in real terms across periods.
**Gap:** Massively overstates ruin probability — humans adapt spending downward in bad markets.
**Action:** Implement Guyton-Klinger guardrails:
- Cut spending by 10% if portfolio drops below 80% of initial real value
- Raise by 10% if above 120%
- Alternative: Boglehead VPW (Variable Percentage Withdrawal)
**Files:** `rust-engine/src/simulation.rs`, `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

### 2.2 Mortality-Weighted Ruin (M)
**Current:** Ruin is calculated against a fixed `simulateUntilAge` (default 90).
**Gap:** Ignores longevity risk variation.
**Action:** Integrate a WHO actuarial life table. Each simulation draws a random death age. Report "probability of ruin before death" instead of "ruin by age 90."
**Files:** `rust-engine/src/simulation.rs`, new `mortality.rs` or `mortalityTable.ts`

### 2.3 Three-Bucket Tax Model (M)
**Current:** Flat `taxOnGainsPercent` on positive monthly returns (see 0.2 — that formula must change first).
**Gap:** Lacks real-world retirement account structures (ISA, 401k, Roth, Dutch Box 3).
**Action:** Split savings into `{ taxable, taxDeferred, taxFree }` buckets with different drag rates. Implement tax-optimized withdrawal sequencing.
**Files:** `rust-engine/src/simulation.rs`, `rust-engine/src/structs.rs`, `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

### 2.4 Social Security / Pension Claiming Optimization (S)
**Current:** Pension is a flat income from a fixed age.
**Action:** Allow benefit amounts that vary by claiming age (e.g., US Social Security: 70% at 62, 100% at 67, 124% at 70). Show the optimal claiming age given the portfolio simulation.
**Files:** `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

### 2.5 Glide-Path Allocation (M)
**Current:** allocation is fixed for life.
**Action:** add an "equity % at retirement" second slider with linear interpolation
between now and retirement — covers most real behavior and interacts directly with the
sequence-risk analysis already visualized. Simplest via monthly interpolation of
portfolio weights applied to per-asset historical series.

### 2.6 Household / Couple Mode (M)
Two people: different ages, incomes, pension start ages; later, couple mortality (2.2).
The income/spending period structure already supports it — add a second default income
row, label rows by person, adjust the FI-age framing.

### 2.7 Ruin Definition Nuance (S)
Depletion is sticky: a path that touches 0 but is later revived by pension income counts
as permanent failure. Defensible, but surface it in the UI ("X% of failures recover
after pension starts") or offer a "broke ever / broke at end" toggle.

---

## Priority 3 — Convergence & Diagnostics

### 3.1 Monte Carlo Convergence Diagnostic (S)
**Action:** After simulation, compute and display the standard error of the success probability: $SE = \sqrt{p(1-p)/N}$. Show a convergence quality indicator (e.g., "±1.2% at 95% confidence"). This lets users judge whether their chosen simulation count is sufficient.
**Files:** `rust-engine/src/simulation.rs`, `RetirementPlanner.svelte`

### 3.2 Mode Transparency in UI (S)
**Action:** Show an active mode badge, the effective moments used by the simulator, and warning text when displayed assumptions differ from the simulation driver.
**Files:** `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

---

## Priority 4 — Product, Visualizations & UI

### 4.1 URL-Shareable Scenarios + A/B Compare (M) — cheapest growth feature
Encode all inputs in the URL hash (the input object is flat; `previewTriggerKey` is 90%
of the serialization work). Enables bookmark/share and side-by-side scenario comparison
("retire at 60 vs 64"). Every shared link is distribution.

### 4.2 Coast / Barista FIRE Metrics (S)
From the existing simulation, derive "the age at which you could stop contributing and
still hit 95% success" — large FIRE-community appeal, near-zero engine work (search over
salary-end age replaying stored growth factors, same trick as the ruin surface).

### 4.3 Terminal Wealth CDF Plot (M)
**Action:** Add a CDF plot for final simulated balances (e.g., Year 30 wealth). The existing CDF only shows the single-year input return distribution. Visualizing the massive log-normal right-tail skew of 30-year compounded outcomes is highly informative.
**Files:** `RetirementPlanner.svelte`, `PlannerSecondaryPlot.svelte`

### 4.4 Regime Visualization in Timeline Chart (M)
**Action:** Shade the background of the timeline fan chart to reflect whether the median path was in Crisis or Growth regime for each year. Builds user intuition about sequence risk.
**Files:** `PlannerTimelinePlot.svelte`

### 4.5 Reverse-Engineered CAGR Input (M)
**Action:** Allow users to input their desired geometric mean (CAGR) directly. The engine reverse-calculates the required arithmetic mean: $\mu_{arith} \approx \mu_{geom} + \sigma^2/2$.
**Files:** `PlannerInputPanel.svelte`, `calculations.ts`

### 4.6 Extract Assumptions Metadata → "Data Sources" Modal (S)
**Action:** Move the ~300-line `ASSUMPTION_REFERENCES` object out of
`RetirementPlanner.svelte` into `src/lib/config/currencyAssumptions.ts`, and build a
"Data Sources & Methodology" modal that actively displays this research (sources,
ranges, coverage). It is a genuine trust differentiator currently buried in code. Add a
standard "not financial advice" disclaimer footer while at it.

### 4.7 Localization (M)
NL-first localization (AOW start age, Box 3 terminology, jaarruimte) — the one market
where no good free tool does this properly. Coordinate the i18n approach with the
heat-pump calculator in rekenraam-web.

---

## Priority 5 — Data Quality & Coverage

### 5.1 Regional CPI Series (M) — prerequisite for 0.4
Monthly CPI per region from FRED, stored alongside returns in
`historical-market-data.json` for joint (return, inflation) bootstrapping.

### 5.2 Extended Eurozone Proxy (M)
**Action:** Add AEX (Netherlands) and IBEX (Spain) data from 1980s onward, stitched onto the DAX/CAC core to broaden geopolitical representation of the EUR equity proxy.
**Files:** `scripts/import-retirement-market-data.mjs`

### 5.3 Factor Tilts (Small-Cap / Value) (M)
**Action:** Incorporate small-cap or value datasets (e.g., Russell 2000) so users can model tilted factor portfolios with their distinct sequence-of-returns risk profiles.
**Files:** `scripts/import-retirement-market-data.mjs`, `RetirementPlanner.svelte`

---

## Priority 6 — Advanced / Deferred

### 6.1 Advanced Dual-Mode Controls (M)
Expert controls for mode-specific calibration knobs and deterministic zero-vol override behavior.

### 6.2 Ruin Surface Accuracy (S)
The 800-path subsampling in `build_ruin_surface` (and the matching `RUIN_SAMPLE_CAP` in `simulation.rs`) is aggressive for tail probabilities. Consider increasing or making it proportional to `simCount`. Also, only income source `is-default` has `toAge` adjusted per cell — document or fix this limitation.

---

## Completed (summary)

**Phase 1 — Performance Architecture ✅** Core simulation migrated to Rust/WASM
(`rust-engine`), Web Worker with JS progress callback (~10% increments), reservoir
sampling (K=5,000/month, ~28 MB cap), growth-factor cap (800 rows) for ruin-surface
replay, serde camelCase interop, Vite WASM serving config, and the stale-results
protection flow replacing the noisy 400-sim live preview.

---

## Effort Key

| Label | Estimate |
|---|---|
| **S** (small) | < 2 hours |
| **M** (medium) | 2–6 hours |
| **L** (large) | 6+ hours |
