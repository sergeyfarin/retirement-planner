export type ResultTone = 'good' | 'warn' | 'caution' | 'bad';

/**
 * Retirement readiness is a money-gap question, not a second lifetime probability.
 * A median portfolio that is 1% below its target should look close, not catastrophic.
 */
export function retirementCapitalTone(margin: number): ResultTone {
	if (margin >= 0) return 'good';
	if (margin >= -0.1) return 'warn';
	if (margin >= -0.25) return 'caution';
	return 'bad';
}

export function retirementCapitalLabel(margin: number): string {
	if (margin >= 0) return 'At or above target';
	if (margin >= -0.1) return 'Close to target';
	if (margin >= -0.25) return 'Below target';
	return 'Well below target';
}
