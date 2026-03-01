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

#[wasm_bindgen]
pub fn run_monte_carlo(
    input_val: JsValue,
    spending_periods_val: JsValue,
    income_sources_val: JsValue,
    lumpsum_events_val: JsValue,
    months: u32,
    retire_month: u32,
) -> Result<JsValue, JsValue> {
    let input: RetirementInput = serde_wasm_bindgen::from_value(input_val)?;
    let spending_periods: Vec<SpendingPeriod> =
        serde_wasm_bindgen::from_value(spending_periods_val)?;
    let income_sources: Vec<IncomeSource> = serde_wasm_bindgen::from_value(income_sources_val)?;
    let lumpsum_events: Vec<LumpSumEvent> = serde_wasm_bindgen::from_value(lumpsum_events_val)?;

    let wrapper = crate::simulation::run_monte_carlo_simulation(
        &input,
        &spending_periods,
        &income_sources,
        &lumpsum_events,
        months,
        retire_month,
    );

    let res = WasmResult {
        simulation: wrapper.simulation,
        stats: wrapper.stats,
        sim_count: wrapper.sim_count,
    };

    Ok(serde_wasm_bindgen::to_value(&res)?)
}
