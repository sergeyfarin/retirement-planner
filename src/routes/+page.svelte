<script lang="ts">
  import RetirementPlanner from '$lib/RetirementPlanner.svelte';
</script>

<main class="retirement-page-shell w-full px-1 py-8 sm:px-2 lg:px-3">
  <RetirementPlanner />
</main>

<style>
@import "tailwindcss";

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
