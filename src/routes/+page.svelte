<script lang="ts">
	import RetirementPlanner from '$lib/RetirementPlanner.svelte';
</script>

<main class="retirement-page-shell">
	<RetirementPlanner />
</main>

<style>
	.retirement-page-shell {
		width: 100%;
		/*
		 * A tool, not an article: the language switcher and the heading belong near the top
		 * of the window rather than below a band of empty gradient. The old 2rem also did
		 * not agree with the desktop height below — 4rem of vertical padding against a
		 * `100dvh - 2.25rem` planner overflowed the document by 28px and put a scrollbar on
		 * a layout designed to fit exactly. Both numbers are now 1.5rem in total.
		 */
		padding: 0.75rem 0.25rem;
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
