import {
	getLocale,
	locales,
	overwriteGetLocale,
	setLocale,
	type Locale
} from './paraglide/runtime';

/**
 * Endonyms, not English names: someone looking for their own language scans for the
 * word they use for it. The switcher shows the two-letter code and puts this in the
 * tooltip and accessible name, because nine full names do not fit a header row.
 */
export const LOCALE_NAMES: Record<Locale, string> = {
	en: 'English',
	de: 'Deutsch',
	es: 'Español',
	fr: 'Français',
	it: 'Italiano',
	nl: 'Nederlands',
	pl: 'Polski',
	ru: 'Русский',
	zh: '中文'
};

/**
 * The active locale, as a rune.
 *
 * Paraglide resolves the locale inside every `m.*()` call, which normally makes messages
 * invisible to Svelte: nothing in the template reads a reactive source, so changing
 * language re-renders nothing. Switching used to reload the page for exactly that reason.
 *
 * Backing `getLocale()` with `$state` closes the gap. Svelte tracks a signal read at any
 * call depth, so `m.foo()` in a template now registers a dependency on this value through
 * Paraglide's own resolution path, and every label, tooltip and aria attribute in the app
 * re-renders in place on a switch. No remount — which means the completed simulation, open
 * disclosures, expanded "more info" text and panel scroll position all survive. The one
 * thing that does not is a chart the user has zoomed: redrawing it is how its labels get
 * translated, and that resets the axes to their default range.
 *
 * Two things this does not reach, both handled at their call site:
 *   - Plotly charts, which are drawn imperatively inside `untrack`. Their effects read
 *     `currentLocale()` so a switch redraws them.
 *   - Strings already captured into `$state` (the seeded row labels), which are data by
 *     the time they are stored. See `defaultRowLabels.ts`.
 *
 * `getLocale()` is called once here, before the override is installed, so the initial
 * value still comes from the configured strategies.
 */
let active = $state<Locale>(getLocale());
overwriteGetLocale(() => active);

export function currentLocale(): Locale {
	return active;
}

/**
 * Switch language in place.
 *
 * `persist: false` is for a locale that came from a share link: it decides the current
 * visit without repointing the visitor's own stored preference. Paraglide's `setLocale`
 * is called only for its persistence side effect — the read path is the rune above — and
 * with `reload: false`, since re-rendering is the whole point.
 */
export function applyLocale(next: Locale, options: { persist?: boolean } = {}): void {
	if (next === active) return;
	active = next;
	if (options.persist !== false) void setLocale(next, { reload: false });
}

export { locales, type Locale };
