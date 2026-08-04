use serde::{Deserialize, Serialize};
pub mod calculations;
pub mod engine;
pub mod engine2;
pub mod simulation;
pub mod stats;
pub mod structs;

use crate::structs::{IncomeSource, LumpSumEvent, RetirementInput, SpendingPeriod};
use wasm_bindgen::prelude::*;

fn invalid(message: &str) -> Result<(), JsValue> {
    Err(JsValue::from_str(message))
}

fn validate_wasm_payload(
    input: &RetirementInput,
    spending: &[SpendingPeriod],
    income: &[IncomeSource],
    events: &[LumpSumEvent],
    months: u32,
    retire_month: u32,
) -> Result<(), JsValue> {
    let ages = [
        input.current_age,
        input.retirement_age,
        input.simulate_until_age,
    ];
    if ages.iter().any(|value| !value.is_finite()) {
        return invalid("Current age, retirement age and plan-until age must all be numbers.");
    }
    let expected_months = ((input.simulate_until_age - input.current_age) * 12.0)
        .round()
        .max(0.0) as u32;
    let expected_retire_month = ((input.retirement_age - input.current_age) * 12.0)
        .round()
        .max(0.0) as u32;
    if months != expected_months || retire_month != expected_retire_month.min(expected_months) {
        return invalid("Simulation timeline does not match the calculator inputs.");
    }
    if months <= 12 || input.retirement_age < input.current_age || retire_month > months - 12 {
        return invalid("Simulation ages do not leave a valid accumulation and drawdown horizon.");
    }
    if spending.is_empty() {
        return invalid("Add at least one spending period.");
    }
    if !input.current_savings.is_finite() || input.current_savings < 0.0 {
        return invalid("Portfolio value must be a non-negative number.");
    }

    let finite_assumptions = [
        input.mean_return,
        input.return_variability,
        input.return_skewness,
        input.return_kurtosis,
        input.equity_bond_correlation,
        input.inflation_mean,
        input.inflation_variability,
        input.inflation_skewness,
        input.inflation_kurtosis,
        input.annual_fee_percent,
        input.tax_on_gains_percent,
        input.safe_withdrawal_rate,
        input.simulations,
        input.regime_model.stay_growth,
        input.regime_model.stay_crisis,
        input.regime_model.growth_mean,
        input.regime_model.growth_std,
        input.regime_model.crisis_mean,
        input.regime_model.crisis_std,
    ];
    if finite_assumptions.iter().any(|value| !value.is_finite()) {
        return invalid("Simulation assumptions must all be finite numbers.");
    }
    if input.return_variability < 0.0
        || input.inflation_variability < 0.0
        || !(1.0..=20.0).contains(&input.return_kurtosis)
        || !(1.0..=20.0).contains(&input.inflation_kurtosis)
        || !(-1.0..=1.0).contains(&input.equity_bond_correlation)
        || !(0.0..=1.0).contains(&input.annual_fee_percent)
        || !(0.0..=1.0).contains(&input.tax_on_gains_percent)
        || !(0.01..=1.0).contains(&input.safe_withdrawal_rate)
        || !(1.0..=1_000_000.0).contains(&input.simulations)
        || !(0.0..=1.0).contains(&input.regime_model.stay_growth)
        || !(0.0..=1.0).contains(&input.regime_model.stay_crisis)
        || input.regime_model.growth_std < 0.0
        || input.regime_model.crisis_std < 0.0
    {
        return invalid("One or more simulation assumptions are outside their supported range.");
    }
    if input.seed.is_some_and(|value| !value.is_finite())
        || input
            .inflation_crisis_spread
            .is_some_and(|value| !value.is_finite())
    {
        return invalid("An optional simulation assumption is invalid.");
    }
    for series in [
        input.historical_annual_returns.as_deref(),
        input.historical_monthly_returns.as_deref(),
        input.historical_monthly_inflation.as_deref(),
    ] {
        if series.is_some_and(|values| values.iter().any(|value| !value.is_finite())) {
            return invalid("Historical calibration series must contain only finite numbers.");
        }
    }
    if let (Some(returns), Some(inflation)) = (
        input.historical_monthly_returns.as_ref(),
        input.historical_monthly_inflation.as_ref(),
    ) && returns.len() != inflation.len()
    {
        return invalid("Historical monthly returns and inflation must have matching lengths.");
    }
    if input.historical_monthly_inflation.is_some() && input.historical_monthly_returns.is_none() {
        return invalid("Historical monthly inflation requires a matching return series.");
    }

    for row in spending {
        if !row.from_age.is_finite()
            || !row.to_age.is_finite()
            || !row.yearly_amount.is_finite()
            || row.to_age <= row.from_age
            || row.yearly_amount < 0.0
            || row.to_age <= input.current_age
            || row.from_age >= input.simulate_until_age
        {
            return invalid("A spending period is invalid or outside the planning horizon.");
        }
    }
    for row in income {
        let collapsed_salary = row.id == "is-default" && row.to_age == row.from_age;
        if !row.from_age.is_finite()
            || !row.to_age.is_finite()
            || !row.yearly_amount.is_finite()
            || row.to_age < row.from_age
            || (row.to_age == row.from_age && !collapsed_salary)
            || row.yearly_amount < 0.0
            || row.to_age < input.current_age
            || row.from_age >= input.simulate_until_age
        {
            return invalid("An income source is invalid or outside the planning horizon.");
        }
    }
    for event in events {
        if !event.age.is_finite()
            || !event.amount.is_finite()
            || event.age < input.current_age
            || event.age >= input.simulate_until_age
        {
            return invalid("A one-time event is invalid or outside the planning horizon.");
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmResult {
    pub simulation: crate::engine::SimulationResult,
    pub stats: crate::engine::SummaryStats,
    pub sim_count: u32,
}

/// Parity-test aid: exposes the seeded PRNG stream so the cross-engine test can verify
/// the RNG layer independently. If this diverges, every downstream comparison diverges
/// too, and the failure is far easier to read here than in aggregate statistics.
#[wasm_bindgen]
pub fn debug_random_sequence(seed: f64, count: usize) -> Vec<f64> {
    let mut rng = crate::calculations::RandomSource::new(Some(seed));
    (0..count).map(|_| rng.random()).collect()
}

/// Parity-test aid: the seeded standard-normal stream (Box-Muller with spare caching).
#[wasm_bindgen]
pub fn debug_normal_sequence(seed: f64, count: usize) -> Vec<f64> {
    let mut rng = crate::calculations::RandomSource::new(Some(seed));
    (0..count).map(|_| rng.normal(0.0, 1.0)).collect()
}

#[wasm_bindgen]
pub fn run_monte_carlo(
    input_val: JsValue,
    spending_periods_val: JsValue,
    income_sources_val: JsValue,
    lumpsum_events_val: JsValue,
    months: u32,
    retire_month: u32,
    progress_callback: Option<js_sys::Function>,
) -> Result<JsValue, JsValue> {
    let input: RetirementInput = serde_wasm_bindgen::from_value(input_val)?;
    let spending_periods: Vec<SpendingPeriod> =
        serde_wasm_bindgen::from_value(spending_periods_val)?;
    let income_sources: Vec<IncomeSource> = serde_wasm_bindgen::from_value(income_sources_val)?;
    let lumpsum_events: Vec<LumpSumEvent> = serde_wasm_bindgen::from_value(lumpsum_events_val)?;

    validate_wasm_payload(
        &input,
        &spending_periods,
        &income_sources,
        &lumpsum_events,
        months,
        retire_month,
    )?;

    let cb_wrapper: Option<Box<dyn Fn(f64)>> = progress_callback.map(|cb| {
        Box::new(move |progress: f64| {
            let _ = cb.call1(&JsValue::NULL, &JsValue::from_f64(progress));
        }) as Box<dyn Fn(f64)>
    });

    let wrapper = crate::simulation::run_monte_carlo_simulation(
        &input,
        &spending_periods,
        &income_sources,
        &lumpsum_events,
        months,
        retire_month,
        cb_wrapper.as_deref(),
    );

    let res = WasmResult {
        simulation: wrapper.simulation,
        stats: wrapper.stats,
        sim_count: wrapper.sim_count,
    };

    // `serialize_missing_as_null` so `Option::None` crosses as `null` rather than
    // `undefined`. `SummaryStats.coastAge` is the only optional output field, and its
    // TypeScript type is `number | null`; without this the runtime value would be
    // `undefined` and every `=== null` check in the UI would silently miss.
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(res.serialize(&serializer)?)
}
