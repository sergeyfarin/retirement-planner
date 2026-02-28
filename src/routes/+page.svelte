<script lang="ts">
  import RetirementPlanner from '$lib/RetirementPlanner.svelte';
</script>

<main class="retirement-page-shell">
  <RetirementPlanner />
</main>
<style>
  .retirement-page-shell {
  width: 100%;
  padding: 2rem 0.25rem;
  box-sizing: border-box;
}

@media (min-width: 640px) {
  .retirement-page-shell {
    padding-inline: 0.5rem;
  }
}

@media (min-width: 1024px) {
  .retirement-page-shell {
    padding-inline: 0.75rem;
  }
}
</style>