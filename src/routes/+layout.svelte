<script lang="ts">
	import '../app.css';
	import { getLocale } from '$lib/paraglide/runtime';

	// `app.html` ships `lang="en"`; the locale is only known once the client has read
	// localStorage or the browser's preferences, so correct it on mount.
	$effect(() => {
		document.documentElement.lang = getLocale();
	});
</script>

<slot />
