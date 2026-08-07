import { m } from './paraglide/messages';
import type { IncomeSource } from './retirementEngine';

export type AdditionalIncomeDefaults = Omit<IncomeSource, 'id'>;

/**
 * A newly added source models optional part-time work rather than duplicating the pension.
 * It bridges retirement to a later pension, or covers five post-retirement years when the
 * pension has already started. The plan end always caps the suggested period.
 */
export function additionalIncomeDefaults(
	retirementAge: number,
	pensionStartAge: number,
	planEndAge: number
): AdditionalIncomeDefaults {
	const bridgeToPension = pensionStartAge > retirementAge;
	const suggestedEnd = bridgeToPension ? pensionStartAge : retirementAge + 5;

	return {
		label: m.row_default_part_time_work(),
		fromAge: retirementAge,
		toAge: Math.min(planEndAge, suggestedEnd),
		yearlyAmount: 15_000,
		inflationAdjusted: true
	};
}
