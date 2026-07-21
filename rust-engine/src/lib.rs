use serde::{Deserialize, Serialize};
pub mod calculations;
pub mod engine;
pub mod engine2;
pub mod simulation;
pub mod stats;
pub mod structs;

use crate::structs::{IncomeSource, LumpSumEvent, RetirementInput, SpendingPeriod};
use wasm_bindgen::prelude::*;

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
