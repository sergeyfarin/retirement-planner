import { describe, expect, it } from 'vitest';
import { retirementCapitalLabel, retirementCapitalTone } from './resultPresentation';

describe('retirement result presentation', () => {
	it.each([
		{ margin: 0.2, tone: 'good', label: 'At or above target' },
		{ margin: 0, tone: 'good', label: 'At or above target' },
		{ margin: -0.01, tone: 'warn', label: 'Close to target' },
		{ margin: -0.1, tone: 'warn', label: 'Close to target' },
		{ margin: -0.18, tone: 'caution', label: 'Below target' },
		{ margin: -0.4, tone: 'bad', label: 'Well below target' }
	])('maps a $margin capital gap to $tone', ({ margin, tone, label }) => {
		expect(retirementCapitalTone(margin)).toBe(tone);
		expect(retirementCapitalLabel(margin)).toBe(label);
	});
});
