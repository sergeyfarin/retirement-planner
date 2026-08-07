import { locales, type Locale } from './paraglide/runtime';

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

export { locales, type Locale };
