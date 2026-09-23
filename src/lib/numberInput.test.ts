import { describe, expect, it } from 'vitest';
import { parseLocalizedNumber } from './numberInput';

describe('parseLocalizedNumber', () => {
	it.each([
		['3,5', 3.5],
		['120.000', 120000],
		["120'000,50", 120000.5],
		['1,234.56', 1234.56],
		['1.234,56', 1234.56],
		['0.015', 0.015],
		['-2 500', -2500]
	])('parses %s without changing its magnitude', (entered, expected) => {
		expect(parseLocalizedNumber(entered)).toBe(expected);
	});

	it.each(['', 'hello', '1..2', '1,23,45', '12a'])('rejects invalid input: %s', (entered) => {
		expect(parseLocalizedNumber(entered)).toBeNull();
	});
});
