import { m } from './paraglide/messages';
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
	if (!isFiniteNumber(value)) return m.validation_field_must_be_number({ label });
	if (value < min || value > max) return m.validation_field_between({ label, min, max });
	return undefined;
}

function validateCashflowRows(
	rows: Array<SpendingPeriod | IncomeSource>,
	kind: 'expense' | 'income source',
	currentAge: number,
	simulateUntilAge: number
): string | undefined {
	for (const row of rows) {
		const label = typeof row.label === 'string' ? row.label.trim() : '';
		const name = label
			? `“${label}”`
			: kind === 'expense'
				? m.validation_unnamed_expense()
				: m.validation_unnamed_income();
		if (!isFiniteNumber(row.fromAge) || !isFiniteNumber(row.toAge)) {
			return m.validation_row_ages_numbers({ name });
		}
		const collapsedRetireeSalary =
			kind === 'income source' && row.id === 'is-default' && row.toAge === row.fromAge;
		if (row.toAge < row.fromAge) return m.validation_row_ends_before_start({ name });
		if (row.toAge === row.fromAge && !collapsedRetireeSalary) {
			return m.validation_row_empty_period({ name });
		}
		if (row.toAge <= currentAge || row.fromAge >= simulateUntilAge) {
			return m.validation_row_outside_horizon({ name });
		}
		if (!isFiniteNumber(row.yearlyAmount)) return m.validation_row_amount_number({ name });
		if (row.yearlyAmount < 0) {
			return m.validation_row_negative_amount({ name });
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
		const name = label ? `“${label}”` : m.validation_unnamed_event();
		if (!isFiniteNumber(event.age)) return m.validation_event_age_number({ name });
		if (event.age < currentAge || event.age >= simulateUntilAge) {
			return m.validation_row_outside_horizon({ name });
		}
		if (!isFiniteNumber(event.amount)) return m.validation_event_amount_number({ name });
	}
	return undefined;
}

function validateOptionalStrategy(strategy: WithdrawalStrategy | undefined): string | undefined {
	if (!strategy) return undefined;
	if (!['fixed', 'guardrails', 'percentOfPortfolio'].includes(strategy.kind)) {
		return m.validation_strategy_unknown();
	}
	for (const [key, value] of Object.entries(strategy)) {
		if (key === 'kind' || value === undefined) continue;
		if (!isFiniteNumber(value) || value < 0)
			return m.validation_strategy_setting_non_negative({ key });
	}
	if ((strategy.adjustment ?? 0) > 0.9) return m.validation_strategy_adjustment();
	if ((strategy.withdrawalPercent ?? 0) > 1) return m.validation_strategy_percent();
	if ((strategy.spendingCeiling ?? Infinity) < (strategy.spendingFloor ?? 0)) {
		return m.validation_strategy_ceiling();
	}
	return undefined;
}

function validateAssumptions(input: RetirementInput): string | undefined {
	if (
		input.simulationMode !== undefined &&
		!['historical', 'parametric'].includes(input.simulationMode)
	) {
		return m.validation_mode_unknown();
	}
	if (!isFiniteNumber(input.currentSavings) || input.currentSavings < 0)
		return m.validation_portfolio_non_negative();

	for (const [value, label] of [
		[input.meanReturn, m.validation_label_mean_return()],
		[input.returnSkewness, m.validation_label_return_skewness()],
		[input.inflationMean, m.validation_label_inflation_mean()],
		[input.inflationSkewness, m.validation_label_inflation_skewness()]
	] as const) {
		if (!isFiniteNumber(value)) return m.validation_field_must_be_number({ label });
	}
	for (const [value, label, max] of [
		[input.returnVariability, m.validation_label_return_variability(), 2],
		[input.inflationVariability, m.validation_label_inflation_variability(), 0.5]
	] as const) {
		if (!isFiniteNumber(value) || value < 0 || value > max)
			return m.validation_field_between({ label, min: 0, max });
	}
	for (const [value, label] of [
		[input.returnKurtosis, m.validation_label_return_kurtosis()],
		[input.inflationKurtosis, m.validation_label_inflation_kurtosis()]
	] as const) {
		if (!isFiniteNumber(value) || value < 1 || value > 20)
			return m.validation_field_between({ label, min: 1, max: 20 });
	}

	let error = validateRange(
		input.equityBondCorrelation,
		m.validation_label_equity_bond_correlation(),
		-1,
		1
	);
	if (error) return error;
	error = validateRange(input.annualFeePercent, m.validation_label_annual_fee(), 0, 1);
	if (error) return error;
	error = validateRange(input.taxOnGainsPercent, m.validation_label_tax_on_gains(), 0, 1);
	if (error) return error;
	error = validateRange(input.safeWithdrawalRate, m.validation_label_safe_withdrawal(), 0.01, 1);
	if (error) return error;
	if (
		!isFiniteNumber(input.simulations) ||
		input.simulations < 1 ||
		input.simulations > 1_000_000
	) {
		return m.validation_simulation_count();
	}
	if (input.seed !== undefined && !isFiniteNumber(input.seed)) return m.validation_seed_number();
	if (
		input.blockLength !== undefined &&
		(!isFiniteNumber(input.blockLength) || input.blockLength < 1)
	) {
		return m.validation_block_length();
	}
	if (
		input.inflationCrisisSpread !== undefined &&
		(!isFiniteNumber(input.inflationCrisisSpread) || input.inflationCrisisSpread < 0)
	) {
		return m.validation_crisis_spread();
	}

	const regime = input.regimeModel;
	if (!regime) return m.validation_regime_missing();
	for (const [value, label] of [
		[regime.stayGrowth, m.validation_label_stay_growth()],
		[regime.stayCrisis, m.validation_label_stay_crisis()]
	] as const) {
		error = validateRange(value, label, 0, 1);
		if (error) return error;
	}
	for (const [value, label] of [
		[regime.growthMean, m.validation_label_growth_mean()],
		[regime.crisisMean, m.validation_label_crisis_mean()]
	] as const) {
		if (!isFiniteNumber(value)) return m.validation_field_must_be_number({ label });
	}
	for (const [value, label] of [
		[regime.growthStd, m.validation_label_growth_std()],
		[regime.crisisStd, m.validation_label_crisis_std()]
	] as const) {
		if (!isFiniteNumber(value) || value < 0) return m.validation_field_non_negative({ label });
	}

	for (const [series, label] of [
		[input.historicalAnnualReturns, m.validation_label_historical_annual()],
		[input.historicalMonthlyReturns, m.validation_label_historical_monthly()],
		[input.historicalMonthlyInflation, m.validation_label_historical_monthly_inflation()]
	] as const) {
		if (
			series !== undefined &&
			(!Array.isArray(series) || series.some((value) => !isFiniteNumber(value)))
		) {
			return m.validation_field_finite_numbers({ label });
		}
	}
	if (
		input.historicalMonthlyInflation !== undefined &&
		input.historicalMonthlyReturns === undefined
	) {
		return m.validation_monthly_inflation_needs_returns();
	}
	if (
		input.historicalMonthlyInflation !== undefined &&
		input.historicalMonthlyReturns !== undefined &&
		input.historicalMonthlyInflation.length !== input.historicalMonthlyReturns.length
	) {
		return m.validation_monthly_lengths();
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
		return invalid(m.validation_ages_numbers());
	}
	const months = Math.max(0, Math.round((input.simulateUntilAge - input.currentAge) * 12));
	if (months <= 12) return invalid(m.validation_horizon_min());
	if (input.retirementAge < input.currentAge) return invalid(m.validation_fi_year_before_current());
	if (spendingPeriods.length === 0) return invalid(m.validation_need_spending_period());

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
	if (retireMonth > months - 12) return invalid(m.validation_plan_until_after_retirement());
	return { months, retireMonth };
}
