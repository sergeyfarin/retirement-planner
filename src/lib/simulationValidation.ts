import type {
	IncomeSource,
	LumpSumEvent,
	RetirementInput,
	SpendingPeriod,
	WithdrawalStrategy
} from './retirementEngine';

export type SimulationValidationResult = { months: number; retireMonth: number; error?: string };

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function invalid(error: string): SimulationValidationResult {
	return { months: 0, retireMonth: 0, error };
}

function validateRange(
	value: unknown,
	label: string,
	min: number,
	max: number
): string | undefined {
	if (!isFiniteNumber(value)) return `${label} must be a number.`;
	if (value < min || value > max) return `${label} must be between ${min} and ${max}.`;
	return undefined;
}

function validateCashflowRows(
	rows: Array<SpendingPeriod | IncomeSource>,
	noun: string,
	currentAge: number,
	simulateUntilAge: number
): string | undefined {
	for (const row of rows) {
		const label = typeof row.label === 'string' ? row.label.trim() : '';
		const name = label ? `“${label}”` : `an unnamed ${noun}`;
		if (!isFiniteNumber(row.fromAge) || !isFiniteNumber(row.toAge)) {
			return `The From and To ages for ${name} must both be numbers.`;
		}
		const collapsedRetireeSalary =
			noun === 'income source' && row.id === 'is-default' && row.toAge === row.fromAge;
		if (row.toAge < row.fromAge)
			return `${name} ends before it starts — check its From and To ages.`;
		if (row.toAge === row.fromAge && !collapsedRetireeSalary) {
			return `${name} must end after it starts — an empty period would have no effect.`;
		}
		if (row.toAge <= currentAge || row.fromAge >= simulateUntilAge) {
			return `${name} lies outside the planning horizon and would have no effect.`;
		}
		if (!isFiniteNumber(row.yearlyAmount)) return `The yearly amount for ${name} must be a number.`;
		if (row.yearlyAmount < 0) {
			return `${name} has a negative yearly amount. Enter it as a positive number.`;
		}
	}
	return undefined;
}

function validateLumpSums(
	events: LumpSumEvent[],
	currentAge: number,
	simulateUntilAge: number
): string | undefined {
	for (const event of events) {
		const label = typeof event.label === 'string' ? event.label.trim() : '';
		const name = label ? `“${label}”` : 'an unnamed one-time event';
		if (!isFiniteNumber(event.age)) return `The age for ${name} must be a number.`;
		if (event.age < currentAge || event.age >= simulateUntilAge) {
			return `${name} lies outside the planning horizon and would have no effect.`;
		}
		if (!isFiniteNumber(event.amount)) return `The amount for ${name} must be a number.`;
	}
	return undefined;
}

function validateOptionalStrategy(strategy: WithdrawalStrategy | undefined): string | undefined {
	if (!strategy) return undefined;
	if (!['fixed', 'guardrails', 'percentOfPortfolio'].includes(strategy.kind)) {
		return 'Withdrawal strategy is not recognized.';
	}
	for (const [key, value] of Object.entries(strategy)) {
		if (key === 'kind' || value === undefined) continue;
		if (!isFiniteNumber(value) || value < 0)
			return `Withdrawal setting ${key} must be a non-negative number.`;
	}
	if ((strategy.adjustment ?? 0) > 0.9) return 'Withdrawal adjustment must not exceed 0.9.';
	if ((strategy.withdrawalPercent ?? 0) > 1) return 'Withdrawal percentage must not exceed 1.';
	if ((strategy.spendingCeiling ?? Infinity) < (strategy.spendingFloor ?? 0)) {
		return 'Withdrawal spending ceiling must not be below its floor.';
	}
	return undefined;
}

function validateAssumptions(input: RetirementInput): string | undefined {
	if (
		input.simulationMode !== undefined &&
		!['historical', 'parametric'].includes(input.simulationMode)
	) {
		return 'Simulation mode is not recognized.';
	}
	if (!isFiniteNumber(input.currentSavings) || input.currentSavings < 0)
		return 'Portfolio value must be a non-negative number.';

	for (const [value, label] of [
		[input.meanReturn, 'Portfolio mean return'],
		[input.returnSkewness, 'Return skewness'],
		[input.inflationMean, 'Inflation mean'],
		[input.inflationSkewness, 'Inflation skewness']
	] as const) {
		if (!isFiniteNumber(value)) return `${label} must be a number.`;
	}
	for (const [value, label, max] of [
		[input.returnVariability, 'Return variability', 2],
		[input.inflationVariability, 'Inflation variability', 0.5]
	] as const) {
		if (!isFiniteNumber(value) || value < 0 || value > max)
			return `${label} must be between 0 and ${max}.`;
	}
	for (const [value, label] of [
		[input.returnKurtosis, 'Return kurtosis'],
		[input.inflationKurtosis, 'Inflation kurtosis']
	] as const) {
		if (!isFiniteNumber(value) || value < 1 || value > 20)
			return `${label} must be between 1 and 20.`;
	}

	let error = validateRange(input.equityBondCorrelation, 'Equity-bond correlation', -1, 1);
	if (error) return error;
	error = validateRange(input.annualFeePercent, 'Annual fee rate', 0, 1);
	if (error) return error;
	error = validateRange(input.taxOnGainsPercent, 'Tax-on-gains rate', 0, 1);
	if (error) return error;
	error = validateRange(input.safeWithdrawalRate, 'Safe withdrawal rate', 0.01, 1);
	if (error) return error;
	if (
		!isFiniteNumber(input.simulations) ||
		input.simulations < 1 ||
		input.simulations > 1_000_000
	) {
		return 'Simulation count must be between 1 and 1000000.';
	}
	if (input.seed !== undefined && !isFiniteNumber(input.seed))
		return 'Simulation seed must be a number.';
	if (
		input.blockLength !== undefined &&
		(!isFiniteNumber(input.blockLength) || input.blockLength < 1)
	) {
		return 'Historical replay length must be at least 1 month.';
	}
	if (
		input.inflationCrisisSpread !== undefined &&
		(!isFiniteNumber(input.inflationCrisisSpread) || input.inflationCrisisSpread < 0)
	) {
		return 'Crisis inflation spread must be a non-negative number.';
	}

	const regime = input.regimeModel;
	if (!regime) return 'Regime assumptions are missing.';
	for (const [value, label] of [
		[regime.stayGrowth, 'Growth stay probability'],
		[regime.stayCrisis, 'Crisis stay probability']
	] as const) {
		error = validateRange(value, label, 0, 1);
		if (error) return error;
	}
	for (const [value, label] of [
		[regime.growthMean, 'Growth-regime mean'],
		[regime.crisisMean, 'Crisis-regime mean']
	] as const) {
		if (!isFiniteNumber(value)) return `${label} must be a number.`;
	}
	for (const [value, label] of [
		[regime.growthStd, 'Growth-regime variability'],
		[regime.crisisStd, 'Crisis-regime variability']
	] as const) {
		if (!isFiniteNumber(value) || value < 0) return `${label} must be a non-negative number.`;
	}

	for (const [series, label] of [
		[input.historicalAnnualReturns, 'Historical annual returns'],
		[input.historicalMonthlyReturns, 'Historical monthly returns'],
		[input.historicalMonthlyInflation, 'Historical monthly inflation']
	] as const) {
		if (
			series !== undefined &&
			(!Array.isArray(series) || series.some((value) => !isFiniteNumber(value)))
		) {
			return `${label} must contain only finite numbers.`;
		}
	}
	if (
		input.historicalMonthlyInflation !== undefined &&
		input.historicalMonthlyReturns === undefined
	) {
		return 'Historical monthly inflation requires a matching monthly return series.';
	}
	if (
		input.historicalMonthlyInflation !== undefined &&
		input.historicalMonthlyReturns !== undefined &&
		input.historicalMonthlyInflation.length !== input.historicalMonthlyReturns.length
	) {
		return 'Historical monthly returns and inflation must have matching lengths.';
	}

	return validateOptionalStrategy(input.withdrawalStrategy);
}

export function validateSimulationPayload(
	input: RetirementInput,
	spendingPeriods: SpendingPeriod[],
	incomeSources: IncomeSource[] = [],
	lumpSumEvents: LumpSumEvent[] = []
): SimulationValidationResult {
	if (
		!isFiniteNumber(input.currentAge) ||
		!isFiniteNumber(input.retirementAge) ||
		!isFiniteNumber(input.simulateUntilAge)
	) {
		return invalid('Current age, retirement age and plan-until age must all be numbers.');
	}
	const months = Math.max(0, Math.round((input.simulateUntilAge - input.currentAge) * 12));
	if (months <= 12)
		return invalid('Simulation horizon must be at least 1 year beyond current age.');
	if (input.retirementAge < input.currentAge)
		return invalid('Target year to achieve FI cannot be before your current age.');
	if (spendingPeriods.length === 0) return invalid('Add at least one spending period.');

	const assumptionError = validateAssumptions(input);
	if (assumptionError) return invalid(assumptionError);
	const rowError =
		validateCashflowRows(spendingPeriods, 'expense', input.currentAge, input.simulateUntilAge) ??
		validateCashflowRows(
			incomeSources,
			'income source',
			input.currentAge,
			input.simulateUntilAge
		) ??
		validateLumpSums(lumpSumEvents, input.currentAge, input.simulateUntilAge);
	if (rowError) return invalid(rowError);

	const retireMonth = Math.min(
		months,
		Math.max(0, Math.round((input.retirementAge - input.currentAge) * 12))
	);
	if (retireMonth > months - 12)
		return invalid('Plan-until age must be at least 1 year after your retirement age.');
	return { months, retireMonth };
}
