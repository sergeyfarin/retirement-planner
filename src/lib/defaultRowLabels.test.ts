import { describe, expect, it } from 'vitest';
import { localizeSeededLabel, withLocalizedLabel } from './defaultRowLabels';

/**
 * These run under the base locale, so "the current language" is English throughout.
 * What is being checked is the recognition step: which labels are treated as seeded.
 */
describe('seeded row labels', () => {
	it('re-renders a seeded label from any shipped language', () => {
		expect(localizeSeededLabel('Gehalt')).toBe('Salary');
		expect(localizeSeededLabel('Пенсия / соцвыплаты')).toBe('Pension / Social security');
		expect(localizeSeededLabel('Pensioen / sociale uitkering')).toBe('Pension / Social security');
		expect(localizeSeededLabel('Emerytura / świadczenia społeczne')).toBe(
			'Pension / Social security'
		);
		expect(localizeSeededLabel('生活开支')).toBe('Living expenses');
		expect(localizeSeededLabel('Praca na część etatu')).toBe('Part-time work');
		expect(localizeSeededLabel('Spesa aggiuntiva')).toBe('Extra spending');
		expect(localizeSeededLabel('Événement ponctuel')).toBe('One-time event');
	});

	it('leaves a label the user typed alone', () => {
		// The whole point: a renamed row is the user's words, in whatever language they
		// wrote them, and must not be rewritten by a language switch.
		for (const label of ['My consulting gig', 'Salary (Acme)', 'Gehalt Nebenjob', '', '  ']) {
			expect(localizeSeededLabel(label)).toBe(label);
		}
	});

	it('returns the same row object when nothing changes, and a copy when it does', () => {
		const untouched = { id: 'is-1', label: 'Freelancing' };
		expect(withLocalizedLabel(untouched)).toBe(untouched);

		const seeded = { id: 'is-default', label: 'Gehalt', yearlyAmount: 65_000 };
		expect(withLocalizedLabel(seeded)).toEqual({ ...seeded, label: 'Salary' });
	});
});
