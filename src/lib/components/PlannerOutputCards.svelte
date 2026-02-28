<script lang="ts">
  export let stats: any;
  export let input: any;
  export let fmtCompactCurrency: (value: number) => string;
  export let retirementYearlySpending = 0;
  export let FI_TARGET_SUCCESS_PROBABILITY = 0.95;
  export let percentFormatter: Intl.NumberFormat;
  export let fmtNum: (value: number, decimals?: number) => string;
</script>

{#if stats}
  <div class="summary-grid">
    <div class="card">
      <strong>Financial independence targets</strong>
      <div class="results-kpi mono-value">SWR: {fmtCompactCurrency(stats.fiTargetSWR)}</div>
      <div class="results-kpi mono-value">P95: {fmtCompactCurrency(stats.fiTargetP95)}</div>
      <div class="note mono-value">SWR target = expenses {fmtCompactCurrency(retirementYearlySpending)}/yr ÷ {(input.safeWithdrawalRate * 100).toFixed(1)}%</div>
      <div class="note mono-value">P95 target = portfolio at target FI year that implies {(FI_TARGET_SUCCESS_PROBABILITY * 100).toFixed(0)}%+ chance of ending balance above zero</div>
    </div>
    <div class="card">
      <strong>Chance to reach FI by age {input.retirementAge}</strong>
      <div class="results-kpi mono-value" class:amount-positive={stats.fiProbabilitySWR >= 0.7} class:amount-negative={stats.fiProbabilitySWR < 0.7}>
        SWR: {percentFormatter.format(stats.fiProbabilitySWR)}
      </div>
      <div class="results-kpi mono-value" class:amount-positive={stats.fiProbabilityP95 >= 0.7} class:amount-negative={stats.fiProbabilityP95 < 0.7}>
        P95: {percentFormatter.format(stats.fiProbabilityP95)}
      </div>
      <div class="note mono-value">Median by age {input.retirementAge}: {fmtCompactCurrency(stats.retireMedian)}</div>
      <div class="note mono-value">P10: {fmtCompactCurrency(stats.retireLow)} · P90: {fmtCompactCurrency(stats.retireHigh)}</div>
    </div>
    <div class="card">
      <strong>Ending balance distribution</strong>
      <div class="results-kpi mono-value">Median: {fmtCompactCurrency(stats.finalMedian)}</div>
      <div class="note mono-value">
        <span class:amount-positive={stats.finalLow > 0} class:amount-negative={stats.finalLow === 0}>P10: {fmtCompactCurrency(stats.finalLow)}</span>
        · <span class:amount-positive={stats.finalHigh > 0} class:amount-negative={stats.finalHigh === 0}>P90: {fmtCompactCurrency(stats.finalHigh)}</span>
      </div>
    </div>
    <div class="card">
      <strong>Portfolio survives to age {input.simulateUntilAge}</strong>
      <div class="results-kpi mono-value" class:amount-positive={stats.successProbability >= 0.9} class:amount-negative={stats.successProbability < 0.7}>
        {percentFormatter.format(stats.successProbability)}
      </div>
      <div class="note mono-value">
        Cumulative shortfall —
        <span class:amount-negative={stats.shortfallHigh > 0}>P10: {fmtCompactCurrency(stats.shortfallHigh)}</span>
        · <span class:amount-negative={stats.shortfallMedian > 0}>P50: {fmtCompactCurrency(stats.shortfallMedian)}</span>
        · <span class:amount-negative={stats.shortfallLow > 0}>P90: {fmtCompactCurrency(stats.shortfallLow)}</span>
      </div>
      <div class="note mono-value">
        Years at zero balance —
        <span class:amount-negative={stats.depletedYearsHigh > 0}>P10: {fmtNum(stats.depletedYearsHigh, 1)}</span>
        · <span class:amount-negative={stats.depletedYearsMedian > 0}>P50: {fmtNum(stats.depletedYearsMedian, 1)}</span>
        · <span class:amount-negative={stats.depletedYearsLow > 0}>P90: {fmtNum(stats.depletedYearsLow, 1)}</span>
      </div>
    </div>
  </div>
{/if}
