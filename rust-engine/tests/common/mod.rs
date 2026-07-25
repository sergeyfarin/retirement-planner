//! Shared fixtures for the engine tests.
//!
//! Everything here builds *seeded* inputs: `RandomSource::new(None)` falls through to
//! `js_sys::Math::random`, which is not available in a native test binary, so any test
//! that touches the RNG must supply a seed.

#![allow(dead_code)]

use rust_engine::engine2::{CashflowArrays, PathTape};
use rust_engine::structs::{
    IncomeSource, LumpSumEvent, RegimeModelInput, RetirementInput, SpendingPeriod,
    WithdrawalStrategy,
};

pub fn regime_model() -> RegimeModelInput {
    RegimeModelInput {
        stay_growth: 0.88,
        stay_crisis: 0.72,
        growth_mean: 0.09,
        growth_std: 0.12,
        crisis_mean: -0.08,
        crisis_std: 0.24,
    }
}

/// A plain, valid plan: 40 → retire at 65 → simulate to 90, parametric mode.
pub fn base_input() -> RetirementInput {
    RetirementInput {
        simulation_mode: Some("parametric".to_string()),
        historical_moment_targeting: Some(false),
        current_age: 40.0,
        retirement_age: 65.0,
        simulate_until_age: 90.0,
        current_savings: 300_000.0,
        mean_return: 0.06,
        return_variability: 0.15,
        return_skewness: -0.3,
        return_kurtosis: 4.0,
        equity_bond_correlation: 0.2,
        inflation_mean: 0.02,
        inflation_variability: 0.01,
        inflation_skewness: 0.0,
        inflation_kurtosis: 3.0,
        inflation_crisis_spread: Some(0.015),
        block_length: Some(6),
        annual_fee_percent: 0.0,
        tax_on_gains_percent: 0.0,
        seed: Some(12345.0),
        safe_withdrawal_rate: 0.04,
        withdrawal_strategy: Some(WithdrawalStrategy::default()),
        simulations: 400.0,
        regime_model: regime_model(),
        historical_annual_returns: None,
        historical_monthly_returns: None,
        historical_monthly_inflation: None,
    }
}

pub fn spending(from_age: f64, to_age: f64, yearly: f64, inflation_adjusted: bool) -> SpendingPeriod {
    SpendingPeriod {
        id: format!("sp-{from_age}-{to_age}"),
        label: "spend".to_string(),
        from_age,
        to_age,
        yearly_amount: yearly,
        inflation_adjusted: Some(inflation_adjusted),
    }
}

pub fn income(from_age: f64, to_age: f64, yearly: f64, inflation_adjusted: bool) -> IncomeSource {
    IncomeSource {
        id: "is-default".to_string(),
        label: "salary".to_string(),
        from_age,
        to_age,
        yearly_amount: yearly,
        inflation_adjusted: Some(inflation_adjusted),
    }
}

pub fn lump_sum(age: f64, amount: f64) -> LumpSumEvent {
    LumpSumEvent {
        id: format!("ls-{age}"),
        label: "event".to_string(),
        age,
        amount,
    }
}

pub fn fixed_strategy() -> WithdrawalStrategy {
    WithdrawalStrategy {
        kind: "fixed".to_string(),
        ..WithdrawalStrategy::default()
    }
}

/// Cashflow arrays with every array zeroed, for evaluator tests that want to isolate one
/// channel at a time.
pub fn empty_cashflows(months: usize) -> CashflowArrays {
    CashflowArrays {
        monthly_net_flow: vec![0.0; months],
        monthly_income_flow: vec![0.0; months],
        monthly_spending_flow: vec![0.0; months],
        monthly_real_income_flow: vec![0.0; months],
        monthly_nominal_income_flow: vec![0.0; months],
        monthly_real_spending_flow: vec![0.0; months],
        monthly_nominal_spending_flow: vec![0.0; months],
        lump_sum_by_month: vec![0.0; months],
    }
}

/// A deterministic tape: constant monthly return and inflation.
pub fn flat_tape(months: usize, monthly_return: f64, monthly_inflation: f64) -> PathTape {
    PathTape {
        asset_returns: vec![monthly_return; months],
        inflation_rates: vec![monthly_inflation; months],
    }
}

pub fn assert_close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected} ± {tolerance}, got {actual}"
    );
}
