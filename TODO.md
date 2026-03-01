# Project Roadmap & Backlog

All completed items from prior phases have been removed. Only open action items remain, ordered by strategic priority.

---

## Priority 1 — Performance Architecture ✅

All Phase 1 Performance issues have been successfully resolved via the **Rust WebAssembly** `rust-engine` integration:

- Core simulation loop migrated to Rust (`simulation.rs`) with `wasm-pack --target web`
- Web Worker calls WASM via `wasm-bindgen` with a **JS progress callback** reporting ~10% increments
- **Reservoir sampling** (K=5,000 per month) caps memory at ~28 MB regardless of simulation count
- **Growth factor cap** at 800 rows for ruin surface replay (~4 MB)
- `#[serde(rename_all = "camelCase")]` on all output structs for seamless JS interop
- `server.fs.allow` + `optimizeDeps.exclude` in Vite config for correct WASM module serving
- Preview reactivity guard (`resultStage === 'final'`) prevents overwriting worker results

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
**Current:** Flat `taxOnGainsPercent` on positive monthly returns.
**Gap:** Lacks real-world retirement account structures (ISA, 401k, Roth, Dutch Box 3).
**Action:** Split savings into `{ taxable, taxDeferred, taxFree }` buckets with different drag rates. Implement tax-optimized withdrawal sequencing.
**Files:** `rust-engine/src/simulation.rs`, `rust-engine/src/structs.rs`, `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

### 2.4 Social Security / Pension Claiming Optimization (S)
**Current:** Pension is a flat income from a fixed age.
**Action:** Allow benefit amounts that vary by claiming age (e.g., US Social Security: 70% at 62, 100% at 67, 124% at 70). Show the optimal claiming age given the portfolio simulation.
**Files:** `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

---

## Priority 3 — Convergence & Diagnostics

### 3.1 Monte Carlo Convergence Diagnostic (S)
**Action:** After simulation, compute and display the standard error of the success probability: $SE = \sqrt{p(1-p)/N}$. Show a convergence quality indicator (e.g., "±1.2% at 95% confidence"). This lets users judge whether their chosen simulation count is sufficient.
**Files:** `rust-engine/src/simulation.rs`, `RetirementPlanner.svelte`

### 3.2 Mode Transparency in UI (S)
**Action:** Show an active mode badge, the effective moments used by the simulator, and warning text when displayed assumptions differ from the simulation driver.
**Files:** `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

---

## Priority 4 — Visualizations & UI

### 4.1 Terminal Wealth CDF Plot (M)
**Action:** Add a CDF plot for final simulated balances (e.g., Year 30 wealth). The existing CDF only shows the single-year input return distribution. Visualizing the massive log-normal right-tail skew of 30-year compounded outcomes is highly informative.
**Files:** `RetirementPlanner.svelte`, `PlannerSecondaryPlot.svelte`

### 4.2 Regime Visualization in Timeline Chart (M)
**Action:** Shade the background of the timeline fan chart to reflect whether the median path was in Crisis or Growth regime for each year. Builds user intuition about sequence risk.
**Files:** `PlannerTimelinePlot.svelte`

### 4.3 Reverse-Engineered CAGR Input (M)
**Action:** Allow users to input their desired geometric mean (CAGR) directly. The engine reverse-calculates the required arithmetic mean: $\mu_{arith} \approx \mu_{geom} + \sigma^2/2$.
**Files:** `PlannerInputPanel.svelte`, `calculations.ts`

---

## Priority 5 — Data Quality & Coverage

### 5.1 Extended Eurozone Proxy (M)
**Action:** Add AEX (Netherlands) and IBEX (Spain) data from 1980s onward, stitched onto the DAX/CAC core to broaden geopolitical representation of the EUR equity proxy.
**Files:** `scripts/import-retirement-market-data.mjs`

### 5.2 Factor Tilts (Small-Cap / Value) (M)
**Action:** Incorporate small-cap or value datasets (e.g., Russell 2000) so users can model tilted factor portfolios with their distinct sequence-of-returns risk profiles.
**Files:** `scripts/import-retirement-market-data.mjs`, `RetirementPlanner.svelte`

---

## Priority 6 — Advanced / Deferred

### 6.1 Advanced Dual-Mode Controls (M)
Expert controls for mode-specific calibration knobs and deterministic zero-vol override behavior.

### 6.2 Ruin Surface Accuracy (S)
The 800-path subsampling in `build_ruin_surface` (and the matching `RUIN_SAMPLE_CAP` in `simulation.rs`) is aggressive for tail probabilities. Consider increasing or making it proportional to `simCount`. Also, only income source `is-default` has `toAge` adjusted per cell — document or fix this limitation.

---

## Effort Key

| Label | Estimate |
|---|---|
| **S** (small) | < 2 hours |
| **M** (medium) | 2–6 hours |
| **L** (large) | 6+ hours |
