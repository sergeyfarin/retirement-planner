<script lang="ts">
  export let stats: any;
  export let ruinSurfaceEl: HTMLDivElement | null = null;
</script>

{#if stats}
  <div class="card chart-card chart-card-ruin">
    <div class="ruin-surface-chart" bind:this={ruinSurfaceEl}></div>
  </div>
{/if}
