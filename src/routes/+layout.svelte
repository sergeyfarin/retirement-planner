<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import { currentLocale } from '$lib/i18n.svelte';

	let { children }: { children: Snippet } = $props();

	// `app.html` ships `lang="en"`; the locale is only known once the client has read
	// localStorage or the browser's preferences. Reading the rune keeps this in step with
	// a switch too, which no longer reloads the page.
	$effect(() => {
		document.documentElement.lang = currentLocale();
	});
</script>

{@render children()}
