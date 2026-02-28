<script lang="ts">
  export let chartEl: HTMLDivElement | null = null;
</script>

<div class="card chart-card chart-card-main">
  <div class="chart" bind:this={chartEl}></div>
  <p class="note">
    Fan shows middle 50% and 80% of outcomes. Dotted line is target year to achieve FI.
    Red dashed line is FI target (P95) and orange dotted line is FI target (SWR). Shaded bands indicate spending periods.
    Engine uses bootstrapped annual returns with regime detection to model sequence risk and clustered drawdowns.
  </p>
</div>
