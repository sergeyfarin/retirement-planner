# Project Roadmap & Backlog

**Updated:** 2026-07-21 (Launch Plan phases 1–4 complete; repo licensed
AGPL-3.0 and ready to go public). Mortality-weighted ruin remains declined as a product
decision — see 2.2.

---

## Launch Plan (agreed 2026-07-20)

Phased implementation order for making the planner shareable with a wider audience.
Item numbers refer to the detailed entries below.

**Phase 1 — Correctness (engine & data): ✅ COMPLETED 2026-07-20**
1. ✅ Dividend adjustment for US/UK/World equity series (0.1)
2. ✅ Annual net-gain taxation replacing monthly upside-only tax (0.2)
3. ✅ Unify effective-moments source between UI code paths (0.10)
4. ✅ Align success definition in FI-P95 target with headline success probability (1.4)
5. ✅ Month-contiguity assertion in preprocessing (0.9)
6. ✅ Raise ruin-surface sample cap 800 → 2000 (6.2)

**Phase 2 — UX for a wider audience: ✅ COMPLETED 2026-07-20**
7. ✅ Age field labels: "Current age" / "Retire at age" / "Plan until age"
8. ✅ Plain-language headline sentence above output cards ("In 99 of 100 simulated futures…")
9. ✅ Progressive disclosure: assumptions card collapsed by default behind a one-line summary
10. ✅ URL-shareable scenarios including the seed (4.1)

**Phase 3 — Modeling upgrades:**
11. ✅ Withdrawal strategies: Guyton-Klinger guardrails + percent-of-portfolio (2.1)
12. ✅ Joint (return, inflation) block bootstrap + regional CPI data (0.4 / 5.1)
13. ✅ "Current conditions" expected-return preset via moment targeting (yield-anchored means,
    historical shape) — see 2.8

**Phase 4 — Engineering health:**
14. ✅ Cross-engine parity test asserting intermediate series, not just summary stats (1.1)
15. ✅ De-duplicate planner-local math (1.2) — also fixed a latent regime-model divergence

**Explicitly declined:** mortality-weighted ruin (2.2) — see rationale there.

---

## Priority 0 — Correctness & Data Quality (found 2026-07-07)

These bias current results **materially pessimistic** and should land before new features.

### 0.1 US and UK equity series exclude dividends (M) — ✅ FIXED 2026-07-20
**Fix applied:** decade-level synthetic dividend yield schedules added in
`preprocess-retirement-market-data.mjs` for USD, GBP and WORLD (EUR already
total-return); dataset regenerated. US equity now 12.0% arithmetic / 10.6% geometric
nominal 1961–2025 (was 8.9/7.6), GBP 11.3/9.6 (was 6.8/5.2), WORLD 12.1/10.7 (was
9.5/8.2), EUR unchanged. README §3.1.1 documents schedules and sources. Original issue
kept below for context.

**Original issue:**
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

### 0.2 Tax-on-gains model overstates drag ~3–4× (M) — ✅ FIXED 2026-07-20
**Fix applied:** both engines now accumulate the year's investment P&L (net of fees,
tracked in deflated units) and tax `rate × max(0, yearly_pnl)` at each year boundary and
the final partial year, applied as a multiplicative factor so ruin-surface replay carries
it. Measured effective drag at the 15% default: ≈1.6%/yr on a ≈12%/yr portfolio (was
≈3.5–4%/yr). Regression test added (`retirementEngine.test.ts`, "annual net-gain
taxation"). No loss carryforward v1; Box 3 wealth-tax mode remains 2.3. Original issue
kept below for context.

**Original issue:**
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

### 0.3 Nominal cashflows deflated by *expected*, not realized, inflation (M) — ✅ FIXED 2026-07-21
**Observation confirmed before fixing:** `build_cashflow_arrays` divided nominal items by
`(1+inflationMean)^years`, computed once outside the per-path loop, while balances were
deflated by the stochastic per-path inflation. A fixed annuity therefore never lost
purchasing power faster on a high-inflation path.

**Fix applied:** cash flows are now split into a real part (inflation-adjusted items,
constant in real terms) and the *face value* of nominal items. Each simulated month
divides the nominal part by that path's realized cumulative inflation index. The index is
taken through month m−1, because the flow is applied before that month's deflation and so
enters in pre-month-m money — the same convention the old expected index encoded.

**It also removed an internal inconsistency:** nominal flows used `(1+μ)^(m/12)` while
balances were deflated by the compounding monthly draws, i.e. the two sides of the ledger
were on different price indices. Both now use the same one.

**Verified by exact computation.** With inflation volatility set to zero the whole path is
deterministic, so a test reproduces the engine's accounting by hand and matches
`finalMedian` to 6 decimal places. A before/after run on an inflation-adjusted-income
scenario is byte-identical, confirming the real-terms path is untouched.

**Withdrawal strategies:** `WithdrawalRunner` no longer reads base spending from a
precomputed array — with nominal items it is path-dependent — and instead receives the
month's real-terms spending from the caller.

**Known limitation, unchanged:** the ruin-surface and Coast-FIRE replays still use the
expected index for nominal items. Stored growth factors bake inflation into a single
number, so per-path realized inflation cannot be recovered during a replay. This is part
of the documented replay approximation (README §7).
**Files:** `rust-engine/src/{engine2,simulation,stats}.rs`, `src/lib/retirementEngine.ts`

### 0.4 Historical bootstrap severs the return–inflation correlation — ✅ FIXED 2026-07-21
**Fix applied:** regional monthly CPI is now stored per month alongside returns and the
engines sample `(return, inflation)` from the same historical month, so both the
correlation (USD: equity −0.08 / bond −0.17) and inflation persistence (AR(1) ≈ 0.62)
survive into simulated paths. Contiguous bootstrap blocks carry sustained inflationary
periods. The regime spread is not applied on top in this mode. Gated to Historical mode
without moment targeting; a misaligned series is ignored rather than mispaired.
Regression test asserts persistent stagflation yields a fatter left tail than
independent inflation at the same mean. See README §5.3. Original issue below.

**Original issue:**
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

### 0.5 Kurtosis blending biased low (S) — ✅ FIXED 2026-07-21
**Fix applied:** `blendPortfolioMetrics` now includes the cross terms of the fourth
moment of a sum — `12ρ(a_s³a_b + a_s a_b³) + 6a_s²a_b²(1+2ρ²) + 6a_c²·Var(equity+bond)`
on top of `Σaᵢ⁴κᵢ`, where `aᵢ = wᵢσᵢ`. Exact for jointly normal components (checked
against Monte Carlo: formula 3.0000 vs MC 3.0001) and exact for independent components of
any marginal shape, since the cross moments then factor; a normal-theory approximation
only when correlation and non-normal marginals combine.

**Why it mattered more than the one-line description suggests.** The old formula returned
kurtosis **1.5 for a blend of independent normals** — thinner than normal — so
`student_t_degrees_from_kurtosis` saw zero excess kurtosis and produced thin tails. The
error scales with how balanced the portfolio is, so it hit conservative allocations
hardest, i.e. precisely the people near or in retirement:

| EUR allocation | old κ | fixed κ |
|---|---|---|
| 100 / 0 / 0 | 2.719 | 2.719 (unchanged — no cross terms) |
| 60 / 30 / 10 | 2.750 | 2.717 (−1%; equity term dominates) |
| 30 / 60 / 10 | 1.975 | 2.881 (+46%) |
| 20 / 40 / 40 | 1.738 | 2.896 (+67%) |
| 0 / 50 / 50 | 2.398 | 3.276 (+37%) |

**Tests:** four cases in `retirementEngine.test.ts` — any blend of uncorrelated normals
returns exactly 3, correlated normals also return exactly 3 (ρ from −0.5 to 0.9), a
100%-single-asset portfolio preserves that asset's kurtosis, and a fat-tailed component
raises portfolio kurtosis above 3.

**Note on skewness:** the third moment has the same structural issue, but its cross terms
vanish for independent components, so the existing formula is exact when uncorrelated and
only mildly approximate under correlation. Left as is; documented in README §6.2.
**Files:** `src/lib/calculations.ts`, README §6.2

### 0.6 Seed & fingerprint nits (S) — ✅ FIXED 2026-07-20
All three addressed: `input.seed ?? Math.floor(random)` so an explicit seed of `0` is
honoured (verified in-browser — a run with seed 0 reports "Seed: 0"); the seed is part of
`previewTriggerKey`, so changing it marks results stale; and the seed actually used is
shown in the status banner after every run, with a matching input under Advanced tuning.
The seed also rides along in the share link (4.1), so a shared URL reproduces the exact
run.
**Files:** `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

### 0.7 Annual-mode bootstrap flattens intra-year volatility (S) — ✅ FIXED 2026-07-21
**Fix applied:** annual mode no longer repeats one constant monthly rate for twelve
months. Each month draws a Cornish-Fisher shaped multiplicative shock and the twelve
shocks are renormalised to unit geometric mean, so the year compounds to **exactly** the
annual return that was bootstrapped — annual moments and the bootstrap's fidelity to
history are untouched — while the path within the year actually moves.

**Measured effect** (25-year drawdown, 6% withdrawal rate, annual-only history): success
77.3% → 76.5% at 42k spend and 62.1% → 61.3% at 50k, i.e. roughly 0.8pp of previously
hidden *within-year* ruin, with the simulated annual mean return identical to four decimal
places (4.2000% both ways), confirming the renormalisation preserves the draw.

**Tests:** two in `retirementEngine.test.ts` — annual return moments are unchanged to 10
decimal places when intra-year spread is switched on, and measured ruin can only rise.
The parity suite's existing "annual bootstrap fallback" scenario covers it too, which is
what verifies the two engines consume the RNG in the same order (12 extra draws per year).

**Reachability, unchanged:** all four shipped regions carry ≥ 781 monthly observations, so
the app always takes Mode A. Mode B is reachable through the library with annual-only
data, and would become reachable if a short-monthly-history region were added (5.2) — the
mode is now trustworthy rather than a documented trap.
**Files:** `rust-engine/src/{engine,simulation}.rs`, `src/lib/retirementEngine.ts`, README §4.3

### 0.8 Sequence-risk annual accumulator never resets in monthly-bootstrap mode — ✅ FIXED 2026-07-20
**Fix applied:** the year-boundary reset now runs unconditionally at every 12-month
boundary in both engines, instead of only inside the annual-bootstrap branch. The values
feeding `build_sequence_risk_summary` are once again single-year returns.
**Worth remembering:** both engines carried this bug identically, so the parity suite
(1.1) would have passed it. Parity guards divergence, not correctness — the fix came from
reading the code, and only a test asserting a *known-correct* annual return would have
caught it independently.

**Original issue:**
**Current:** `annual_asset_return`/`annual_inflation` are reset to 0 only inside the
`else if m % 12 == 0` branch (`simulation.rs` ~line 369), which is the *annual*-bootstrap
path. Monthly calibration (`use_monthly_calibration`) takes an `if` branch above it and
never resets these accumulators, yet all four shipped regions have ≥791 months of history
so monthly mode is the actual production path. The TS mirror has the identical bug
(`retirementEngine.ts` ~line 765).
**Impact:** the values pushed into `annual_real_returns` at each year boundary
(`simulation.rs` line 444) are cumulative-since-simulation-start returns, not single-year
returns, for every real run. This feeds `build_sequence_risk_summary` directly — the
"early years mean return" per quintile bucket is wrong (inflated, and increasingly so for
later "years"), and bucket ranking is distorted because year-1 return is baked into every
subsequent "annual" value. A same-engine parity test (1.1) would not catch this since both
engines share the bug.
**Action:** move the reset so it fires at every 12-month boundary regardless of
`use_monthly_calibration`.
**Files:** `rust-engine/src/simulation.rs`, `src/lib/retirementEngine.ts`

### 0.9 GBP raw series starts one month later than the other regions — ✅ CLOSED 2026-07-20
Contiguity assertion added to `preprocess-retirement-market-data.mjs` (fails loud on any
mid-series month gap; differing start dates remain allowed). Investigation details below.
**Investigated:** `historical-market-data.json` has 792 monthly rows for WORLD/USD/EUR
but 791 for GBP. Root cause confirmed: `data/retirement/raw/gbp.csv` genuinely starts at
`1960-02` while `usd.csv`/`eur.csv`/`world.csv` start at `1960-01` — one raw row shorter
at the source, not a mid-series gap or preprocessing bug (likely the underlying UK FRED
series, `IRLTLT01GBM156N` and/or `IR3TIB01GBM156N`, has no observation before Feb 1960).
After the standard "drop first row, no prior price to compute a return from" step, GBP's
processed series runs `1960-03..2026-01` (791 months) vs `1960-02..2026-01` (792 months)
for the others.
**Impact:** none on simulation correctness — `monthly_returns_to_annual_series` groups
each region's own series independently in contiguous 12-month chunks from its own start;
no code path compares calendar months *across* regions. The only effect is that GBP's
internal year-boundaries for regime detection/annual-return moments fall one calendar
month later than the other three regions' — a cosmetic data-provenance footnote, not a
correctness bug.
**Action:** none required. Optionally note the one-month-shorter GBP coverage window
next to the "coverage" string already shown in the UI (`selectedHistoricalRegion.coverage`)
for full transparency, and add a preprocessing assertion that *would* fail loud if a
future refresh introduces a genuine mid-series gap (not just a different start date).
**Files:** `data/retirement/raw/gbp.csv` (informational only)

### 0.10 Effective mean/std come from two different methods depending on last-touched control — ✅ FIXED 2026-07-20
**Fix applied:** both `applyReferenceDefaults` and `applyInvestmentAllocationMetrics` now
use the same rule — realized blended-series moments only when the simulation actually
bootstraps that series (historical mode, moment targeting off, ≥10 annual returns);
parametric blend otherwise. Original issue kept below for context.

**Original issue:**
**Current:** `applyReferenceDefaults` (currency switch) sets `input.meanReturn` /
`returnVariability` from the moments of the *realized blended historical annual series*
(`RetirementPlanner.svelte` ~line 1185). `applyInvestmentAllocationMetrics` (allocation
slider drag, or any input-panel edit that calls it) instead sets them from the
*parametric* blend of per-asset moments plus `input.equityBondCorrelation`
(~line 1005). These do not agree — the parametric path uses the assumed correlation input
while the realized series embeds the true historical stock/bond co-movement — so two
users with identical final settings can get different simulation targets depending on
which control they touched last. This matters most when `historicalMomentTargeting` is on,
since these become the actual moment-targeting destination.
**Action:** pick one source of truth for "effective" moments in historical mode (the
realized historical series is the more honest one) and have both entry points call the
same function.
**Files:** `RetirementPlanner.svelte` (`applyReferenceDefaults`, `applyInvestmentAllocationMetrics`)

---

### 0.11 Regime block bootstrap delivered ~0.85pp/yr less than the source series — ✅ FIXED 2026-07-21
**Root cause, measured rather than assumed.** The sampler aborted the current block
whenever the regime switched (`block_remaining <= 0 || regime_changed`). Because a freshly
drawn block always *starts* on a month matching the new regime, and crisis runs are shorter
than growth runs (stayCrisis ≈ 0.68 vs stayGrowth ≈ 0.84), crisis months were over-drawn. A
replica of the sampler, instrumented to tally what it actually drew:

| region | crisis months, source → sampled | annualised return, source → sampled |
|---|---|---|
| EUR | 33.5% → 35.4% (1.06×) | 7.68% → 6.79% (**−0.89pp**) |
| USD | 35.0% → 37.0% (1.06×) | 9.38% → 8.67% (**−0.71pp**) |
| GBP | 28.6% → 31.2% (1.09×) | 9.54% → 8.26% (**−1.29pp**) |
| WORLD | 33.3% → 35.3% (1.06×) | 9.58% → 8.94% (**−0.64pp**) |

Decomposing against the crisis/growth mean spread showed the frequency shift alone explains
**72–76%** of the gap in every region, confirming the mechanism rather than merely
correlating with it.

**Fix:** blocks now run to completion; a regime switch mid-block takes effect at the next
block boundary. One condition, `block_remaining <= 0`.

**It improved more than the mean.** Cutting blocks short was also destroying the
autocorrelation the block bootstrap exists to preserve:

| | source | old sampler | fixed |
|---|---|---|---|
| EUR lag-1 autocorrelation | 0.064 | 0.038 | **0.053** |
| GBP lag-1 autocorrelation | 0.102 | 0.051 | **0.084** |
| EUR monthly σ | 3.104% | 3.151% | **3.101%** |

**End-to-end through the real engine**, 55-year horizon, no fees/tax/cash flows:

| region | source geometric real | engine median | gap |
|---|---|---|---|
| EUR | 4.20%/yr | 4.19%/yr | −0.01pp |
| USD | 5.00%/yr | 5.00%/yr | 0.00pp |
| GBP | 3.65%/yr | 3.71%/yr | +0.07pp |
| WORLD | 5.27%/yr | 5.30%/yr | +0.03pp |

**User-visible effect on the default EUR scenario:** median ending balance €1.4M → €2.2M
(+57% over 55 years of compounding), chance of reaching FI by 62 93.2% → 96.3%, Coast FIRE
age 55 → 50. Every number moves in the optimistic direction, because the old sampler was
systematically pessimistic.


**Cross-checked against the literature after the fix, because "it now matches the source
mean" is not self-evidently the right target.**

- The sampler wraps its block index (`% len`), which makes it a **circular block
  bootstrap**. The CBB was introduced by Politis & Romano precisely because the moving
  block bootstrap under-samples observations at the ends of the series; its stated
  advantage is that **the resampled sample mean is unbiased**. Matching the source mean is
  therefore this method's own design property, not a metric imposed after the fact.
- In Hamilton-type Markov switching models the unconditional mean is the
  stationary-probability-weighted average of the regime means. Since the transition
  probabilities here are *estimated from the detected labels*, the implied unconditional
  mean is the sample mean by construction. The old sampler contradicted its own chain: the
  chain implied 33.5% crisis months, the sampler delivered 35.4%.

**Cases where a deviation would be legitimate, and why none apply here:** conditioning the
start on a known current regime (the engine draws the initial state from the stationary
distribution, so it is unconditional); deliberate stress-testing (should be an explicit,
documented parameter, not an emergent artifact); moment-targeting mode (deliberate, and
unaffected by this change); the parametric generator (Mode C, different code path); and
moving-block edge bias (real, but O(b/n) ≈ 0.8% here, and removed by the circular wrap).
The fix was also verified to hold at block lengths 2, 3 and 6.

**Regression guard:** `retirementEngine.test.ts`, "regime bootstrap is mean-preserving",
asserts the engine's median real growth tracks the geometric mean of the series it was
handed within 0.35pp over a 50-year horizon. Verified it fails on the old sampler (measured
0.94pp deviation) and passes on the fixed one.

**Trade-off accepted:** a regime switch is now felt up to `blockLength` months later
(default 6, mean ~3) rather than immediately. Given the immediate-switch behaviour was both
biased and worse at preserving clustering, and that a "regime" is by construction a
multi-month state, this is the better side of the trade.
**Files:** `rust-engine/src/simulation.rs`, `src/lib/retirementEngine.ts`

### 0.12 The regime layer contributes nothing measurable in Mode A (M) — found 2026-07-21
**Found while validating the 0.11 fix.** With the sampling bias removed, the
regime-conditioned block bootstrap was compared against a plain circular block bootstrap
with no regime conditioning whatsoever, same data and seed, 6,000 paths × 55 years:

| EUR, blockLength 6 | mean gap | crisis freq | worst 12m, median | worst 12m, P05 |
|---|---|---|---|---|
| regime-conditioned | +0.01pp | 1.00× | −25.5% | −35.4% |
| **no regimes at all** | +0.01pp | 1.00× | −25.6% | −35.0% |

Statistically indistinguishable, and the same holds for USD and at block lengths 3 and 2.

**Why — structural, not a bug.** The transition probabilities are estimated from the same
labels being resampled, so choosing a pool with the stationary probability is equivalent to
sampling unconditionally. Measured persistence confirms it: the regime is the same at
consecutive block starts 56.5% of the time against 55.4% by chance, because crisis runs
(~3.1 months) are shorter than the 6-month block, so the chain mixes completely inside one
block. The regime state is never consulted at a moment when it carries information.

---

#### Measurements added 2026-07-21 (these correct two earlier claims in this item)

**(a) The model is NOT under-producing multi-year bear markets.** This was the stated worry
behind "make regimes bite". It is false:

| | history's *worst* 36m window | simulated worst-36m, P05 of paths |
|---|---|---|
| EUR | −38.2% | **−40.3%** |
| USD | −18.4% | **−29.8%** |

Block recombination already chains bad runs that never occurred consecutively, so simulated
multi-year drawdowns are *more* severe than anything in the historical record. Sequence risk
is present and if anything generous.

**(b) Option 2 was measured, and it does essentially nothing.** Re-detecting regimes on an
18-month window with a looser threshold (crisis runs 3.2 → 4.2 months) moved worst-36m P05
from −40.3% to **−40.5%**. Meanwhile blockLength 6 → 24 moved it to **−41.9%**.
**Block length, not regime persistence, is the lever on drawdown severity.**

**Correction to this item's earlier text:** it claimed option 2 "deliberately moves the
simulated distribution away from the source". That was wrong — the longer-run variant stays
mean-preserving (+0.02pp). It does not trade accuracy for realism; it simply has no effect.

**(c) The regime layer is not dead code — it is live outside the default path:**

| path | regimes drive returns? | drive inflation? |
|---|---|---|
| Historical, default (joint CPI) | ✗ (measured) | ✗ |
| Historical + "Use today's yields" | ✗ | **✓ crisis spread** |
| Parametric (Mode C) | **✓ fully** | **✓** |

So "remove the regime machinery from Mode A" is not free: it would break the crisis
inflation spread that the current-conditions preset relies on (2.8).

**(d) Literature check.** The one recognised motivation for regime-conditioned resampling is
avoiding bootstrap samples that straddle a **structural break**, which would "generate
implausible scenarios". That justification does not apply here: `detect_regimes_monthly`
finds *recurring* volatility states, not permanent structural breaks, and the pools are
recombined freely across the whole sample either way.

**Decision: option 3 — document, change nothing.** Rejected option 1 (removal breaks live
inflation behaviour, is a one-way door, and would churn every user's results again days
after 0.11 moved them ~57%); rejected option 2 (measured ineffective). README §4.3 and the
assumptions table already state that clustering comes from the block bootstrap rather than
the regime layer. **The follow-on question worth real effort is block length — see 0.13.**

### 0.13 `blockLength = 6` is an unexamined magic number, and it flattens the term structure of risk (M) — found 2026-07-21
**Found while resolving 0.12.** The default block length appears as a bare `6` in three
places (`simulation.rs`, `retirementEngine.ts`, `RetirementPlanner.svelte`) with no stated
justification anywhere in the code or docs. It is the single biggest lever on simulated
long-horizon risk, so it deserves a deliberate, documented choice.

**Diagnostic — variance ratio** (Lo & MacKinlay). VR(k) = Var(k-month return) / (k ×
Var(1-month return)); VR = 1 is a random walk, < 1 mean reversion, > 1 trending. A block
bootstrap can only carry dependence up to about its block length; past that it glues
independent blocks together and the term structure goes flat. Measured on 60/30/10:

| series | VR 12m | VR 36m | VR 60m | VR 120m |
|---|---|---|---|---|
| **EUR source** | 1.21 | 1.10 | 1.06 | **0.94** |
| resampled, block 6m | 1.13 | 1.15 | 1.14 | 1.13 |
| resampled, block 120m | 1.21 | 1.12 | 1.03 | **0.89** |
| **USD source** | 1.11 | 1.01 | 1.11 | **1.36** |
| resampled, block 6m | 1.05 | 1.06 | 1.07 | 1.08 |
| **WORLD source** | 1.22 | 1.13 | 1.18 | **1.46** |
| resampled, block 6m | 1.14 | 1.17 | 1.18 | 1.18 |

**The finding: at block 6 the variance ratio is flat across every horizon — a shape no
region actually exhibits.** Longer blocks track the source term structure markedly better.

**But the bias direction is not uniform, which matters.** EUR mean-reverts at 10 years
(0.94), so short blocks *overstate* its long-horizon risk — the direction Cogneau &
Zakamulin warn about. USD and WORLD trend at 10 years (1.36, 1.46), so short blocks
*understate* theirs. There is no single "conservative" error here.

**And the long-horizon source estimates are weak.** With 792 months, VR(120) rests on ~6.6
non-overlapping windows; this is exactly the small-sample fragility that dogged the
Fama-French / Poterba-Summers mean-reversion literature. The 1.36 and 1.46 figures should
not be taken at face value.

**The real trade-off is bias against sample diversity:**

| block | non-overlapping blocks available (n=792) |
|---|---|
| 6m | 132 |
| 24m | 33 |
| 60m | 13 |
| 120m | **6** |

At 120 months the simulation is recombining six distinct decades — barely more diverse than
cFIREsim-style historical sequencing, with correspondingly high sampling error.

**Literature does not give one answer, because the answer depends on the objective:**
- Hall, Horowitz & Jing rules of thumb target estimating the variance *of a statistic*:
  n^(1/3) ≈ **9 months** here, n^(1/5) ≈ 4. Close to the current 6.
- Politis & White (2004), corrected by Patton, Politis & White (2009), give a data-driven
  optimal block length from the correlogram. This is the defensible way to pick it, and
  there are reference implementations (the R `blocklength` package; Patton's MATLAB code).
- Practitioner tooling for *financial planning* specifically uses far longer blocks —
  Portfolio Optimizer's worked example uses a 120-month average with the stationary
  bootstrap, justified as capturing "time-varying volatility and mean reversion".

The gap between ~9 and ~120 is not a contradiction: the short rules optimise estimation of a
scalar statistic, while long blocks aim to reproduce multi-year path dynamics, which is what
a retirement simulation needs.

**Suggested work, in order:**
1. Implement Politis-White automatic block-length selection on each region's series and
   report what it suggests. Cheap, and it replaces a guess with a citation.
2. Decide the default deliberately between that number and a longer planning-oriented value;
   document the reasoning and the diversity trade-off in README §4.3.
3. Consider the **stationary bootstrap** (Politis & Romano 1994) — geometric random block
   lengths rather than fixed — which the literature notes is "less sensitive to block size
   misspecification". That robustness is attractive precisely because the right value is
   uncertain here.
4. Surface `blockLength` in the UI as what it actually is: the control over how sustained
   simulated downturns are. It is currently buried in Advanced tuning with a purely
   mechanical description.

**Do not** treat this as a bug fix. Unlike 0.11 there is no provably correct target; it is a
modelling choice that should be made explicitly and disclosed, not silently changed.
**Files:** `rust-engine/src/simulation.rs`, `src/lib/retirementEngine.ts`,
`RetirementPlanner.svelte`, `PlannerInputPanel.svelte`, README §4.3

## Priority 1 — Engineering Health

### 1.1 Cross-engine parity test (S/M) — ✅ SHIPPED 2026-07-21
**Shipped:** `src/lib/enginesParity.test.ts` runs the same seeded inputs through the TS
reference engine and the Rust/WASM production engine and compares them at three levels:
the PRNG streams (uniform + standard-normal, which turn out to be bit-identical), the
full per-month P10/P25/P50/P75/P90 bands, and every summary/sequence-risk/ruin-surface
value. Eight scenarios cover monthly bootstrap, joint inflation, both withdrawal
strategies, moment targeting, the annual-bootstrap fallback, parametric mode, and the
zero-fee/zero-tax path — so any new engine feature that lands in only one engine fails
here.
**Tolerance:** results agree to ~1 ULP (relative 1e-16), so the suite asserts 1e-9. Its
sensitivity was verified by injecting a fee-divisor change in the 5th decimal place
(12 → 12.0001) into the TS engine — 7 of 8 scenarios failed, at relative 3.5e-9.
**CI:** `pnpm run test:engines` (the node-side vitest project, no browser needed) runs in
`publish-dist.yml` before the dist build.
**Caveat worth remembering:** parity is not correctness. Both engines shared the
year-boundary reset bug (0.8) and a parity test would have passed it happily. This guards
against divergence, not against a faithfully-mirrored mistake.

### 1.2 De-duplicate planner-local math (S) — ✅ DONE 2026-07-21
**Removed** 246 lines from `RetirementPlanner.svelte` (2,498 → 2,244): local copies of
`clamp`, `getAllocationSplit`, `blendPortfolioMetrics`, `summarizeSeriesMoments`,
`summarizeSeriesDistribution`, `sampleCorrelation`, `estimateEquityBondCorrelation`,
`getHistoricalInvestmentMetrics`, `buildPortfolioHistoricalReturns`,
`buildPortfolioHistoricalMonthlyReturns`, `clampProbability`,
`getGrowthStationaryProbability` and `buildRegimeModelFromPortfolio`, plus the unused
`runMonteCarloSimulation` import and the dead `previewReady` / `previewRecalcTimer`
vestiges. ESLint errors in the file went 28 → 20 (none introduced).

**A latent bug found in the process.** Only one local copy actually differed from
`calculations.ts` — `buildRegimeModelFromPortfolio`:

| | local copy | `calculations.ts` |
|---|---|---|
| spread | floored at `0.01`, **no cap** | capped at `0.8 × sqrt(σ²/(π_G·π_C))` |
| target variance | floored at `1e-8` | raw `σ²` |
| regime std devs | floored at `0.005` | unfloored |

`applyReferenceDefaults` (currency switch, and the initial mount) used the **local** copy
while `applyInvestmentAllocationMetrics` (allocation slider) used the **imported** one —
the same last-touched-control pathology as 0.10, but for the regime model.

It was invisible at normal allocations because the cap is not binding there (60/30/10 has
σ ≈ 12.9%, so the requested 15% spread sits well under the ~23% cap). It bit at low
volatility: for a 100%-cash portfolio (σ ≈ 3.25%) the uncapped local version produced a
crisis-regime mean of **−6.4%/yr for cash**, versus **+0.3%** from the capped version — a
regime spread wider than the entire portfolio volatility it was meant to decompose. The
README's documented behaviour ("capped at 80% of maximum variance-preserving spread") is
the `calculations.ts` one, which is also the sane one, so unifying on it removes the
duplication and fixes the bug together.

**Verified behaviour-preserving where it should be:** captured effective portfolio and
real-return moments before (from `git HEAD`) and after, at the default 60/30/10, at 100%
cash via the slider, and at 100% cash after a currency switch — all three byte-identical,
since the two implementations agree wherever the caps are not binding.

### 1.3 Decide the TS engine's fate (S) — ✅ DECIDED 2026-07-21
**Decision: keep it as the reference implementation, guarded by the parity test (1.1).**
It is now a tested asset rather than dead weight — it is far more readable than the Rust
engine, it is what makes the parity suite possible at all, and it runs in plain Node
without a wasm build. The obligation that comes with the decision: **every engine change
must land in both engines in the same commit**, which the CI parity run now enforces.

### 1.4 "Success" is defined two different ways in the same result set — ✅ FIXED 2026-07-20
**Fix applied:** `find_retirement_balance_target` (both engines) now takes explicit
success flags computed with the same never-depleted definition as the headline success
probability. Original issue kept below for context.

**Original issue:**
**Current:** `success_probability` requires the path to have *never* depleted
(`simulation.rs` line 483 — ruin is sticky, matching the documented behavior in 2.7). The
P95 FI target's implied success count instead only checks `ending_balance > 0`
(`find_retirement_balance_target`, `stats.rs` line 228). A path that hits zero at 66 and
is later revived by pension income counts as a failure in the headline success
probability and a success in the FI-target derivation.
**Action:** align both to the same ruin definition, or — better — resolve alongside 2.7
by picking one definition and exposing the other as an explicit secondary stat ("X% of
depleted paths recover by the end").
**Files:** `rust-engine/src/simulation.rs`, `rust-engine/src/stats.rs`

### 1.5 Dead pseudo-`imul` computation in the RNG (S) — ✅ FIXED 2026-07-20
**Was:** `RandomSource::random` computed a throwaway approximation of `Math.imul` into a
local `t`, discarded it via `let _ = …`, and then redid the calculation properly on the
next lines. Purely dead, but exactly the kind of thing that makes a reader distrust an
RNG they are trying to audit.
**Fix applied:** the dead statement is gone; `random()` is now four lines that mirror the
JS `Math.imul` semantics directly, with a comment saying so. `cargo build` reports zero
warnings.
**Guarded by:** the parity suite (1.1) asserts the seeded uniform *and* standard-normal
streams are identical between the TS and Rust engines, so any future edit that changes
RNG behaviour — dead code or not — fails CI.
**Files:** `rust-engine/src/calculations.rs`

### 1.6 Repo hygiene before making the repo/link public (S) — ✅ DONE 2026-07-21
**Stray files** (done 2026-07-20): `*:Zone.Identifier`, `fix-runes*.mjs` and `.build-log`
removed from tracking and gitignored; the emptied `public/` tree removed.

**Pre-public audit** (2026-07-21) — checked and clean:
- No secrets, tokens or credentials in tracked files; `.npmrc` holds only `engine-strict`.
- Nothing sensitive in git history (the only removed files were the empty Windows
  marker files and one-off migration scripts — not worth a history rewrite).
- No build artifacts tracked; `build/`, `dist/`, `.svelte-kit/` are gitignored.
- Largest tracked file is the 588 KB dataset — fine for a repo.

**Licensing and metadata** (decided with the maintainer):
- **AGPL-3.0-only**, full text in `LICENSE`, chosen so a hosted modified fork must
  publish its source. README §14 explains the §13 network clause and third-party data
  terms.
- The app footer now links to the source repository, which is what AGPL §13 requires of
  network-served software.
- `package.json` gained description / license / author / repository / homepage / bugs /
  keywords, plus `"private": true` — it is a monorepo (frontend + engine), not a library,
  so this blocks an accidental `npm publish`. Verified `pnpm run build` (which runs
  `svelte-package` + `publint`) still passes with the flag set.

**Commit-metadata emails — ✅ rewritten 2026-07-21 (maintainer confirmed no forks exist):**
all 44 commits authored under `rekenraam@gmail.com`, `sergey.farin@gmail.com` or
`Sergey.Farin@gmail.com` were rewritten to
`Sergey Farin <1467219+sergeyfarin@users.noreply.github.com>` using `git filter-repo
--mailmap`. Verified afterwards: local history contains zero gmail addresses, both HEAD
and `main` tree hashes are byte-identical to before, and commit (60) and tag (29) counts
are unchanged. Repo-local `user.email` is now pinned to the noreply address so new commits
cannot reintroduce a personal one.

Because every commit hash changed, this requires a **force-push of all branches and
tags**. Until that happens the rewritten history exists only locally; GitHub still holds
the original, which is also the rollback path.

### 1.7 Data pipeline wrote to a directory the app never served (S) — ✅ FIXED 2026-07-21
**Found while wiring the joint inflation bootstrap.** `preprocess-retirement-market-data.mjs`
wrote to `public/assets/retirement/historical-market-data.json`, but SvelteKit serves
`static/` (`kit.files.assets` default) and the planner fetches
`/assets/historical-market-data.json`. The app had therefore been running on a stale
`static/assets/historical-market-data.json` from 2026-02-27 — **the Priority-0 dividend
fix (0.1) never reached the running app when it was first committed** (served USD equity
was still 8.93% instead of 11.99%).
**Fix:** `OUT_PATH` now points at `static/assets/historical-market-data.json`, the
orphaned `public/` copy is deleted, and README §2 documents why the path matters.
**Lesson worth keeping:** verify data-pipeline changes through the running app, not just
by inspecting the generated file — the default currency (EUR) was the one region the
dividend fix didn't change, which is why the stale data went unnoticed.

### 1.8 `fetchFredSeries` turned missing observations into 0 (S) — ✅ FIXED 2026-07-21
`Number('')` is `0` and `Number.isFinite(0)` is true, so any month FRED reports as empty
was silently stored as a 0 level/rate. It first surfaced as a bogus `0` US CPI for
2025-10 (not published during the federal shutdown). Existing bond/cash series were
checked and are unaffected, but the bug would have corrupted any future refresh.
Now empty and `.` values are skipped explicitly. Short interior CPI gaps (≤3 months) are
geometrically interpolated by the preprocess step and logged; longer gaps throw.
**Files:** `scripts/import-retirement-market-data.mjs`, `scripts/preprocess-retirement-market-data.mjs`


---

## Priority 2 — Enhanced Modeling Logic

### 2.1 Dynamic Spending Strategies (M) — ✅ SHIPPED 2026-07-20
**Shipped:** `withdrawalStrategy` on the input with three modes — `fixed` (default),
`guardrails` (Guyton-Klinger, rate-based band with configurable band/step/floor/ceiling),
and `percentOfPortfolio` (spend a % of balance yearly, clamped to a floor/ceiling of
initial real spending). A shared `WithdrawalRunner` (Rust + TS, also used by the
ruin-surface replay) applies the strategy only during retirement; pre-retirement spending
is unchanged. UI selector with per-strategy params in the left panel; strategy is in the
staleness fingerprint and the share link. Regression test asserts adaptive ≥ fixed on a
stressed scenario. See README §5.1.1.
**Follow-ups (open):** age-banded VPW percentage table; Guyton-Klinger's inflation-freeze
and final-years no-cut refinements; a "spending path" visualization so users can see how
much their income actually varies year to year under each strategy.
**Files:** `rust-engine/src/{structs,engine2,simulation,stats}.rs`,
`src/lib/retirementEngine.ts`, `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

### 2.2 Mortality-Weighted Ruin — DECLINED (product decision, 2026-07-20)
**Considered:** integrating a life table so each simulation draws a random death age and
ruin is reported as "probability of ruin before death" (the actuarially standard framing;
a fixed age-90 horizon overstates lived risk since many people don't reach it).
**Declined because:** this is a personal planning tool, not an institutional model.
Showing a user "you have a ~35% chance of reaching 90" is emotionally corrosive and
undermines the tool's purpose, regardless of statistical correctness. The fixed
"plan until age" horizon is deliberately conservative and lets the user own that choice.
**Instead:** keep the user-selected horizon. Optionally add neutral helper text near
"Plan until age" noting that planning to 90–95+ is a conservative, commonly recommended
choice — no survival probabilities shown anywhere. Do not resurrect this item without an
explicit opt-in design that keeps death statistics out of the default experience.

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

### 3.1 Monte Carlo Convergence Diagnostic (S) — ✅ SHIPPED 2026-07-20 (heatmap 2026-07-21)
The survival card now shows `±1.96·SE at 95% confidence (N simulations)` beneath the
success probability, with $SE = \sqrt{p(1-p)/N}$ computed in `PlannerOutputCards.svelte`
from the actual simulated count (e.g. "±0.4% at 95% confidence (20'000 simulations)").
**Ruin-surface heatmap — ✅ also done 2026-07-21.** Each cell now reports its own binomial
margin on hover ("Survival 88.9% ±1.4%"), and a caption states the replay sample size and
the worst-case margin across cells (±2.2% at the 50% mid-range, tighter near 0%/100%).
The caption also says the thing users would otherwise get wrong: this sample is capped
independently of the "Simulations" setting, so raising that number sharpens the summary
cards but *not* this chart. `RuinSurface` gained a `sampleCount` field in both engines so
the UI reads the real replay count instead of duplicating the cap constant; the parity
suite asserts it.
**Caveat recorded in the code:** cells share the same stored paths (common random
numbers), so *differences* between neighbouring cells are steadier than each cell's
absolute margin implies — which is why the caption steers readers toward the shape of the
trade-off rather than any single cell's value.
**Files:** `src/lib/components/PlannerOutputCards.svelte`,
`src/lib/components/PlannerSecondaryPlot.svelte`, `rust-engine/src/{engine,stats}.rs`,
`src/lib/retirementEngine.ts`

### 3.2 Mode Transparency in UI (S) — PARTIALLY DONE 2026-07-21
**Done:** the collapsed Assumptions summary names the active mode and dataset
("Euro area history 1961-2025 (adjusted) · 0.5% fees · 15% tax"); a badge appears when
joint (return, inflation) sampling is active; and 0.10 removed the case where displayed
moments could disagree with the simulation driver depending on which control was touched
last, which was the substance of the old "warning text" ask.
**Still open:** no explicit indicator of *which* moments the simulator is actually
targeting under moment targeting (the table shows per-asset inputs, not the blended
portfolio target the bootstrap is shifted onto).
**Files:** `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

---

## Priority 4 — Product, Visualizations & UI

### 4.1 URL-Shareable Scenarios + A/B Compare (M) — ✅ sharing SHIPPED 2026-07-20; A/B compare still open
**Shipped:** all inputs (scalars, mode, allocation, parametric metrics, cashflow rows)
plus the displayed run's seed serialize to a versioned base64url `#s=` hash; "Copy share
link" button appears after each run; the hash is parsed, validated and restored on load,
then auto-runs. Verified end-to-end: a shared link reproduces the exact seed and results.
Side-by-side A/B scenario comparison remains open.

**Original item:**
Encode all inputs in the URL hash (the input object is flat; `previewTriggerKey` is 90%
of the serialization work). Enables bookmark/share and side-by-side scenario comparison
("retire at 60 vs 64"). Every shared link is distribution.

### 4.2 Coast / Barista FIRE Metrics (S) — ✅ SHIPPED 2026-07-21
**Shipped:** `SummaryStats.coastAge` — the earliest age at which contributions could stop
while still clearing the 95% success target. Shown in the FI-targets card ("Coast FIRE:
stop saving at age 55 and still clear 95%, if work still covers spending").

**Modelling choice:** "stopping contributions" is net-zero cash flow from the coast age
until retirement — you still cover spending from work (the coast/barista case), so the
portfolio neither grows by contribution nor shrinks by withdrawal, it just compounds.
Retirement age and retirement spending are unchanged.

**Cost:** as the TODO predicted, near-zero. It reuses the ruin-surface replay trick
(stored per-path growth factors re-run against a modified cash-flow schedule) and binary
searches the coast month, so it costs ~6 replays rather than fresh simulations. The
search is sound because success is monotone non-decreasing in the coast month — every
growth factor is positive, so contributing for longer leaves every path with at least as
much money.

**Returns null, deliberately, in two cases:** when the user is not a net saver before
retirement (there are no contributions to stop, and "stopping" would *help* them, which
would invert the monotonicity the search relies on), and when 95% is unreachable even by
contributing right up to retirement. The UI shows an explicit "n/a" line for the latter
rather than hiding the metric.

**Inherits the ruin-surface caveat:** the stored growth factors carry a tax factor
computed on the original balance path. That factor is scale-invariant but not invariant
to a changed contribution pattern, so this is a fast approximation in exactly the same way
the ruin surface is (README §7).

**Found while wiring it up:** `Option::None` was crossing the wasm boundary as `undefined`
rather than `null`, so the declared `coastAge: number | null` type was a lie and every
`=== null` check in the UI would have silently missed. The parity suite caught it. Fixed
by serialising with `serialize_missing_as_null(true)`; `coastAge` is the only optional
field in the output structs.

**Tests:** four behavioural (a net saver gets an age between today and retirement, the age
is the earliest qualifying one, null when unreachable, null for a net drawer) plus a
parity assertion on both the null-ness and the value.
**Files:** `rust-engine/src/{stats,engine,simulation,lib}.rs`, `src/lib/retirementEngine.ts`,
`PlannerOutputCards.svelte`

### 4.3 Terminal Wealth CDF Plot (M)
**Action:** Add a CDF plot for final simulated balances (e.g., Year 30 wealth). The existing CDF only shows the single-year input return distribution. Visualizing the massive log-normal right-tail skew of 30-year compounded outcomes is highly informative.
**Files:** `RetirementPlanner.svelte`, `PlannerSecondaryPlot.svelte`

### 4.4 Regime Visualization in Timeline Chart (M)
**Action:** Shade the background of the timeline fan chart to reflect whether the median path was in Crisis or Growth regime for each year. Builds user intuition about sequence risk.
**Files:** `PlannerTimelinePlot.svelte`

### 2.8 "Use today's yields" expected-return preset — ✅ SHIPPED 2026-07-21
**Shipped:** raw CSVs gained a `bond_yield_pct` column (US GS10, UK/DE 10Y, WORLD as the
same 50/20/30 blend used for bond returns), and the dataset exposes a per-region
`currentConditions { asOf, bondYield, cashRate }`. `buildCurrentConditionsMetrics` builds
forward assumptions the way institutional CMAs do: cash = current short rate, bonds =
current long yield, equity = long yield + *historical* equity risk premium. Only means
move; volatility/skew/kurtosis stay historical. Applied via Historical-with-Adjustments
so real sequencing survives. As of 2026-01 this takes EUR from 7.8% → 4.7% expected
portfolio return and the default scenario from 99% → 75% success.
**Known limitation:** because it runs through moment targeting, the joint
(return, inflation) bootstrap is off in this mode and inflation falls back to the
regional parametric assumption (still user-editable).
**Follow-ups:** anchor inflation to market-implied breakevens (FRED `T10YIE` for USD;
inflation-swap equivalents are harder to source for EUR/GBP); consider a CAPE-based
equity adjustment as an expert-tier option; revisit whether joint inflation can stay on
under moment targeting (the affine transform preserves correlation, so it is defensible —
the concern is only that explicit user inflation edits would be ignored).
**Files:** `scripts/*.mjs`, `src/lib/calculations.ts`, `RetirementPlanner.svelte`, `PlannerInputPanel.svelte`

### 4.5 Reverse-Engineered CAGR Input (M)
**Action:** Allow users to input their desired geometric mean (CAGR) directly. The engine reverse-calculates the required arithmetic mean: $\mu_{arith} \approx \mu_{geom} + \sigma^2/2$.
**Files:** `PlannerInputPanel.svelte`, `calculations.ts`

### 4.6 Extract Assumptions Metadata → "Data Sources" Modal (S) — PARTIALLY DONE
**Done:** the "not financial advice" disclaimer footer ships (plus the AGPL source link,
see 1.6), and a "more info" methodology panel already surfaces dataset coverage and
per-asset sourcing inline.
**Still open:** `ASSUMPTION_REFERENCES` (~300 lines) still lives inside
`RetirementPlanner.svelte` rather than `src/lib/config/currencyAssumptions.ts`, and the
curated research it holds (ranges, source citations) is still not fully displayed. Moving
it out would also shrink the 2,300-line component, which pairs naturally with 1.2.

### 4.7 Localization (M)
NL-first localization (AOW start age, Box 3 terminology, jaarruimte) — the one market
where no good free tool does this properly. Coordinate the i18n approach with the
heat-pump calculator in rekenraam-web.

### 4.8 Shortfall/depleted-years cards show P90-of-metric under a "P10" label — ✅ FIXED 2026-07-20
Relabelled to "Worst 10% / Median / Best 10%", which describes the *outcome* percentile
the numbers actually represent, with a tooltip spelling out that these are percentiles of
simulated outcomes rather than of the metric itself.

**Original issue:**
**Current:** `PlannerOutputCards.svelte` shows `stats.shortfallHigh` /
`stats.depletedYearsHigh` (the **P90** of the underlying shortfall/depleted-years
distribution) under a "P10" heading. The intent is defensible — a bad (P90) shortfall
corresponds to a bad (P10) *outcome* — but with no explanation it reads as a labeling bug
to a numerate audience.
**Action:** relabel as "worst 10% of outcomes" / "best 10% of outcomes" rather than raw
percentile numbers that don't match the underlying stat's own percentile.
**Files:** `src/lib/components/PlannerOutputCards.svelte`

### 4.9 Fan chart bands can be misread as individual paths — ✅ FIXED 2026-07-20
The chart caption now states that each percentile line is computed independently for that
month across all simulations, is not a single continuous scenario, and that reading
"recovery time" off the gap between bands overstates how fast any one path recovers.

**Original issue:**
**Current:** the timeline fan chart's P10/P50/P90 lines are computed pointwise per month
across all simulations (reservoir sampling), not traced from any single simulated
household. No simulated path actually follows the P10 line — reading "time to recover"
off the band gap is a common and incorrect interpretation of fan charts in general.
**Action:** add a one-line caption/tooltip clarifying this ("each line shows the Nth
percentile outcome for that specific month, not one continuous scenario").
**Files:** `src/lib/components/PlannerTimelinePlot.svelte`

---

## Priority 5 — Data Quality & Coverage

### 5.1 Regional CPI Series (M) — ✅ SHIPPED 2026-07-21
Monthly CPI per region now lives in the raw CSVs (`cpi_index` column) and in
`historical-market-data.json` (`monthlySeries[].inflation`). Sources: US `CPIAUCSL`,
UK `GBRCPIALLMINMEI`, Euro-area `CP0000EZ19M086NEST` level-matched onto German
`DEUCPIALLMINMEI` pre-1997, and US CPI for WORLD (its returns are USD-denominated).
`--cpi-only` on the import script refreshes just this column without disturbing the
market-data vintage. Known coverage limit: UK CPI ends 2025-03, so the GBP monthly
series is trimmed there (annual moments still use full market history).

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

### 6.2 Ruin Surface Accuracy (S) — PARTIALLY DONE (cap raised 2026-07-20, precision surfaced 2026-07-21)
**Done:** cap raised 800→2000 in both engines (~11.5 MB of growth factors at 720 months).
Precision is now reported rather than merely bounded — per-cell 95% margins on hover and
a caption giving the worst case; at N=2000 that is ±2.2% for mid-range cells and under
±1% for cells near 0% or 100% (see 3.1).
**Still open:** only income source `is-default` has its `toAge` adjusted per cell, so any
other income stream is held fixed across the surface. README §7 documents this as a fast
approximation; fixing it means deciding what "retire 3 years earlier" should do to
user-added income rows, which is a modelling question, not just a code change.

**Original issue:**
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
