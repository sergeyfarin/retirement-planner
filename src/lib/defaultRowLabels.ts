import { m } from './paraglide/messages';
import { locales } from './paraglide/runtime';

/**
 * The labels the planner seeds its starter rows with. They are translated when the app
 * first mounts, but they then live in `incomeSources` / `spendingPeriods` / `lumpSumEvents`
 * as ordinary editable text — indistinguishable, by the time it is stored, from a label the
 * user typed. So a scenario restored from a `#s=` payload used to come back in whatever
 * language it was seeded in, and switching language (which round-trips through that payload)
 * left "Gehalt" sitting in a Russian UI.
 *
 * Rather than tag rows with an "untouched" flag — which would have to survive the share
 * codec, both engines and every edit path — this recognises the seeded strings themselves,
 * in every language the app ships. A label that still reads exactly as one of them was never
 * edited, so it can be re-rendered in the current language; anything else is the user's words
 * and is left alone.
 *
 * The one thing this gets wrong is deliberate: someone who renames a row to exactly the
 * seeded text of some language, then switches language, sees it translate. That is
 * indistinguishable from the untouched case by construction, and it produces the label they
 * would have got anyway.
 */
const SEEDED_LABEL_MESSAGES = [
	m.row_default_salary,
	m.row_default_pension,
	m.row_default_living_expenses,
	m.row_default_extra_spending,
	m.row_default_part_time_work,
	m.row_default_one_time_event
] as const;

type SeededLabelMessage = (typeof SEEDED_LABEL_MESSAGES)[number];

/**
 * Every shipped rendering of every seeded label, mapped back to the message that produced
 * it. Built once at import: the locale is passed explicitly, so this resolves nothing from
 * the environment and stays correct after a locale change.
 */
const SEEDED_LABELS: ReadonlyMap<string, SeededLabelMessage> = (() => {
	const index = new Map<string, SeededLabelMessage>();
	for (const message of SEEDED_LABEL_MESSAGES) {
		for (const locale of locales) index.set(message({}, { locale }), message);
	}
	return index;
})();

/** The current language's version of a seeded label, or the label unchanged. */
export function localizeSeededLabel(label: string): string {
	const message = SEEDED_LABELS.get(label.trim());
	return message ? message() : label;
}

/** `localizeSeededLabel` over any row that carries a label. */
export function withLocalizedLabel<T extends { label: string }>(row: T): T {
	const label = localizeSeededLabel(row.label);
	return label === row.label ? row : { ...row, label };
}
