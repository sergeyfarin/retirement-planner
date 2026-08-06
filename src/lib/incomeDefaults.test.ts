import { describe, expect, it } from 'vitest';
import { additionalIncomeDefaults } from './incomeDefaults';

describe('additional income defaults', () => {
	it('bridges retirement to a later pension', () => {
		expect(additionalIncomeDefaults(62, 67, 90)).toMatchObject({
			label: 'Part-time work',
			fromAge: 62,
			toAge: 67
		});
	});

	it.each([
		{ retirementAge: 67, pensionAge: 67 },
		{ retirementAge: 70, pensionAge: 67 }
	])(
		'suggests five post-retirement years when pension is not later',
		({ retirementAge, pensionAge }) => {
			expect(additionalIncomeDefaults(retirementAge, pensionAge, 90).toAge).toBe(retirementAge + 5);
		}
	);

	it('caps the suggested period at the plan end', () => {
		expect(additionalIncomeDefaults(88, 67, 90).toAge).toBe(90);
		expect(additionalIncomeDefaults(62, 95, 90).toAge).toBe(90);
	});
});
