use crate::calculations::{clamp, PercentileSeries, RandomSource};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RegimeModel {
    pub stay_growth: f64,
    pub stay_crisis: f64,
    pub growth_mean: f64,
    pub growth_std: f64,
    pub crisis_mean: f64,
    pub crisis_std: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReturnMoments {
    pub arithmetic_mean: f64,
    pub geometric_mean: f64,
    pub std_dev: f64,
    pub skewness: f64,
    pub kurtosis: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SimulationResult {
    pub months: u32,
    pub ages: Vec<f64>,
    pub retire_month: u32,
    pub percentiles: PercentileSeries<Vec<f64>>,
    pub final_percentiles: PercentileSeries<f64>,
    pub retire_percentiles: PercentileSeries<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SequenceRiskBucket {
    pub bucket_label: String,
    pub early_years_mean_return: f64,
    pub ruin_probability: f64,
    pub ending_median: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuinSurface {
    pub retirement_ages: Vec<usize>,
    pub spending_multipliers: Vec<f64>,
    pub ruin_probabilities: Vec<Vec<f64>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SummaryStats {
    pub fi_target: f64,
    pub fi_target_swr: f64,
    pub fi_target_p95: f64,
    pub success_probability: f64,
    pub fi_probability_swr: f64,
    pub fi_probability_p95: f64,
    pub return_moments: ReturnMoments,
    pub sequence_risk: Vec<SequenceRiskBucket>,
    pub ruin_surface: RuinSurface,
    pub shortfall_low: f64,
    pub shortfall_median: f64,
    pub shortfall_high: f64,
    pub depleted_years_low: f64,
    pub depleted_years_median: f64,
    pub depleted_years_high: f64,
    pub retire_low: f64,
    pub final_median: f64,
    pub final_low: f64,
    pub final_high: f64,
    pub retire_median: f64,
    pub retire_high: f64,
}

const MIN_STATE_PROBABILITY: f64 = 0.001;
const FI_TARGET_SUCCESS_PROBABILITY: f64 = 0.95;

pub fn clamp_transition_probability(value: f64) -> f64 {
    clamp(value, MIN_STATE_PROBABILITY, 1.0 - MIN_STATE_PROBABILITY)
}

pub fn get_growth_stationary_probability(stay_growth: f64, stay_crisis: f64) -> f64 {
    let denominator = 2.0 - stay_growth - stay_crisis;
    if denominator <= 1e-9 {
        return 0.5;
    }
    (1.0 - stay_crisis) / denominator
}

pub fn initial_regime_state(stay_growth: f64, stay_crisis: f64, rng: &mut RandomSource) -> u8 {
    let growth_probability =
        clamp_transition_probability(get_growth_stationary_probability(stay_growth, stay_crisis));
    if rng.random() < growth_probability {
        0
    } else {
        1
    }
}

pub fn transition_regime_state(
    current_state: u8,
    stay_growth: f64,
    stay_crisis: f64,
    rng: &mut RandomSource,
) -> u8 {
    if current_state == 0 {
        if rng.random() < stay_growth {
            0
        } else {
            1
        }
    } else {
        if rng.random() < stay_crisis {
            1
        } else {
            0
        }
    }
}

pub fn draw_cornish_fisher_score(skewness: f64, kurtosis: f64, rng: &mut RandomSource) -> f64 {
    let z = rng.normal(0.0, 1.0);
    let excess_kurtosis = clamp(kurtosis - 3.0, 0.0, 8.0);
    let bounded_skew = clamp(skewness, -1.5, 1.5);

    let z2 = z * z;
    let z3 = z2 * z;

    let skew_term = (bounded_skew / 6.0) * (z2 - 1.0);
    let kurt_term = (excess_kurtosis / 24.0) * (z3 - 3.0 * z);
    let skew_sq_term = -(bounded_skew * bounded_skew / 36.0) * (2.0 * z3 - 5.0 * z);

    z + skew_term + kurt_term + skew_sq_term
}

pub fn draw_monthly_return_shaped(
    annual_mean: f64,
    annual_std: f64,
    skewness: f64,
    kurtosis: f64,
    rng: &mut RandomSource,
) -> f64 {
    let monthly_mean = annual_mean / 12.0;
    let monthly_std = annual_std / 12.0_f64.sqrt();
    monthly_mean + monthly_std * draw_cornish_fisher_score(skewness, kurtosis, rng)
}

pub fn draw_student_t(df: f64, rng: &mut RandomSource) -> f64 {
    let safe_df = df.round().max(3.0) as usize;
    let z = rng.normal(0.0, 1.0);
    let mut chi_square = 0.0;
    for _ in 0..safe_df {
        let n = rng.normal(0.0, 1.0);
        chi_square += n * n;
    }
    z / (chi_square / safe_df as f64).sqrt()
}

pub fn student_t_degrees_from_kurtosis(kurtosis: f64) -> f64 {
    let excess = (kurtosis - 3.0).max(0.0);
    if excess < 0.05 {
        return 40.0;
    }
    let implied_df = 4.0 + 6.0 / excess;
    implied_df.clamp(5.0, 60.0)
}

pub fn clamp_annual_return(value: f64) -> f64 {
    clamp(value, -0.95, 1.2)
}

pub fn clamp_monthly_return(value: f64) -> f64 {
    clamp(value, -0.6, 0.6)
}

pub fn annual_to_monthly_return(annual_return: f64) -> f64 {
    let capped = clamp_annual_return(annual_return);
    (1.0 + capped).powf(1.0 / 12.0) - 1.0
}
