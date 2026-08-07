import { browser } from '$app/environment';
import { decodeShareHash, parseShareState } from '$lib/shareState';
import { assertIsLocale } from '$lib/paraglide/runtime';
import { applyLocale } from '$lib/i18n.svelte';

export const prerender = true;

/**
 * A share link carries the language it was built in, so the plan reads the way its author
 * saw it rather than in whatever the recipient happens to have stored.
 *
 * This runs in `load` because it has to happen before the first render: `m.*()` resolves
 * the locale at call time, so setting it here costs nothing, while doing it after mount
 * would mean a second pass over every label and chart.
 *
 * `persist: false`: the link decides this visit only. It does not write localStorage, so
 * opening a German link does not repoint the recipient's own preference, and the language
 * switcher still persists a deliberate choice.
 */
export function load() {
	if (!browser) return;

	const restored = parseShareState(decodeShareHash(window.location.hash), () => true);
	if (!restored?.locale) return;

	applyLocale(assertIsLocale(restored.locale), { persist: false });
}
