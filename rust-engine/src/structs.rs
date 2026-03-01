use crate::calculations::RandomSource;
use crate::engine::*;

// Let's create `structs.rs` to hold all Svelte<->Rust payload API boundary types to avoid cluttering engine.rs

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SpendingPeriod {
    pub id: String,
    pub label: String,
    #[serde(rename = "fromAge")]
    pub from_age: f64,
    #[serde(rename = "toAge")]
    pub to_age: f64,
    #[serde(rename = "yearlyAmount")]
    pub yearly_amount: f64,
    #[serde(rename = "inflationAdjusted")]
    pub inflation_adjusted: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IncomeSource {
    pub id: String,
    pub label: String,
    #[serde(rename = "fromAge")]
    pub from_age: f64,
    #[serde(rename = "toAge")]
    pub to_age: f64,
    #[serde(rename = "yearlyAmount")]
    pub yearly_amount: f64,
    #[serde(rename = "inflationAdjusted")]
    pub inflation_adjusted: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LumpSumEvent {
    pub id: String,
    pub label: String,
    pub age: f64,
    pub amount: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RegimeModelInput {
    #[serde(rename = "stayGrowth")]
    pub stay_growth: f64,
    #[serde(rename = "stayCrisis")]
    pub stay_crisis: f64,
    #[serde(rename = "growthMean")]
    pub growth_mean: f64,
    #[serde(rename = "growthStd")]
    pub growth_std: f64,
    #[serde(rename = "crisisMean")]
    pub crisis_mean: f64,
    #[serde(rename = "crisisStd")]
    pub crisis_std: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RetirementInput {
    #[serde(rename = "simulationMode")]
    pub simulation_mode: Option<String>,
    #[serde(rename = "historicalMomentTargeting")]
    pub historical_moment_targeting: Option<bool>,

    #[serde(rename = "currentAge")]
    pub current_age: f64,
    #[serde(rename = "retirementAge")]
    pub retirement_age: f64,
    #[serde(rename = "simulateUntilAge")]
    pub simulate_until_age: f64,
    #[serde(rename = "currentSavings")]
    pub current_savings: f64,

    #[serde(rename = "meanReturn")]
    pub mean_return: f64,
    #[serde(rename = "returnVariability")]
    pub return_variability: f64,
    #[serde(rename = "returnSkewness")]
    pub return_skewness: f64,
    #[serde(rename = "returnKurtosis")]
    pub return_kurtosis: f64,

    #[serde(rename = "equityBondCorrelation")]
    pub equity_bond_correlation: f64,

    #[serde(rename = "inflationMean")]
    pub inflation_mean: f64,
    #[serde(rename = "inflationVariability")]
    pub inflation_variability: f64,
    #[serde(rename = "inflationSkewness")]
    pub inflation_skewness: f64,
    #[serde(rename = "inflationKurtosis")]
    pub inflation_kurtosis: f64,
    #[serde(rename = "inflationCrisisSpread")]
    pub inflation_crisis_spread: Option<f64>,

    #[serde(rename = "blockLength")]
    pub block_length: Option<usize>,

    #[serde(rename = "annualFeePercent")]
    pub annual_fee_percent: f64,
    #[serde(rename = "taxOnGainsPercent")]
    pub tax_on_gains_percent: f64,

    pub seed: Option<f64>,
    #[serde(rename = "safeWithdrawalRate")]
    pub safe_withdrawal_rate: f64,
    pub simulations: f64,

    #[serde(rename = "regimeModel")]
    pub regime_model: RegimeModelInput,

    #[serde(rename = "historicalAnnualReturns")]
    pub historical_annual_returns: Option<Vec<f64>>,
    #[serde(rename = "historicalMonthlyReturns")]
    pub historical_monthly_returns: Option<Vec<f64>>,
}
