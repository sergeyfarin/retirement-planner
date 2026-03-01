use crate::structs::{IncomeSource, LumpSumEvent, RetirementInput, SpendingPeriod};
use std::collections::HashSet;

pub fn apply_moment_targeting(
    value: f64,
    source_mean: f64,
    source_std: f64,
    target_mean: f64,
    target_std: f64,
) -> f64 {
    let safe_target_std = target_std.max(0.0);
    if !value.is_finite()
        || !source_mean.is_finite()
        || !source_std.is_finite()
        || source_std <= 1e-12
    {
        return target_mean;
    }
    let normalized = (value - source_mean) / source_std;
    target_mean + normalized * safe_target_std
}

pub fn detect_regimes(annual_returns: &[f64]) -> Vec<u8> {
    let len = annual_returns.len().max(1) as f64;
    let mean = annual_returns.iter().sum::<f64>() / len;
    let variance = annual_returns
        .iter()
        .map(|&v| (v - mean).powi(2))
        .sum::<f64>()
        / len;
    let std_dev = variance.max(0.0).sqrt();
    let crisis_threshold = mean - 0.65 * std_dev;

    let mut labels: Vec<u8> = annual_returns
        .iter()
        .enumerate()
        .map(|(index, &value)| {
            let start = index.saturating_sub(2);
            let window = &annual_returns[start..=index];
            let window_len = window.len().max(1) as f64;
            let window_mean = window.iter().sum::<f64>() / window_len;
            let window_variance = window
                .iter()
                .map(|&v| (v - window_mean).powi(2))
                .sum::<f64>()
                / window_len;
            let rolling_std = window_variance.max(0.0).sqrt();

            let crisis_by_return = value <= crisis_threshold;
            let crisis_by_volatility = rolling_std >= std_dev * 1.15;

            if crisis_by_return || crisis_by_volatility {
                1
            } else {
                0
            }
        })
        .collect();

    if labels.len() > 2 {
        for index in 1..labels.len() - 1 {
            if labels[index] == 0 && labels[index - 1] == 1 && labels[index + 1] == 1 {
                labels[index] = 1;
            }
        }
    }

    labels
}

pub fn detect_regimes_monthly(monthly_returns: &[f64]) -> Vec<u8> {
    let len = monthly_returns.len().max(1) as f64;
    let mean = monthly_returns.iter().sum::<f64>() / len;
    let variance = monthly_returns
        .iter()
        .map(|&v| (v - mean).powi(2))
        .sum::<f64>()
        / len;
    let std_dev = variance.max(0.0).sqrt();
    let crisis_threshold = mean - 0.75 * std_dev;

    let mut labels: Vec<u8> = monthly_returns
        .iter()
        .enumerate()
        .map(|(index, &value)| {
            let start = index.saturating_sub(5);
            let window = &monthly_returns[start..=index];
            let window_len = window.len().max(1) as f64;
            let window_mean = window.iter().sum::<f64>() / window_len;
            let window_variance = window
                .iter()
                .map(|&v| (v - window_mean).powi(2))
                .sum::<f64>()
                / window_len;
            let rolling_std = window_variance.max(0.0).sqrt();

            let crisis_by_return = value <= crisis_threshold;
            let crisis_by_volatility = rolling_std >= std_dev * 1.2;

            if crisis_by_return || crisis_by_volatility {
                1
            } else {
                0
            }
        })
        .collect();

    if labels.len() > 2 {
        for index in 1..labels.len() - 1 {
            if labels[index] == 0 && labels[index - 1] == 1 && labels[index + 1] == 1 {
                labels[index] = 1;
            }
        }
    }

    labels
}

pub struct RegimePools<T> {
    pub growth: Vec<T>,
    pub crisis: Vec<T>,
}

pub fn bootstrap_pool_by_regime(annual_returns: &[f64], labels: &[u8]) -> RegimePools<f64> {
    let mut growth = Vec::new();
    let mut crisis = Vec::new();

    for (index, &label) in labels.iter().enumerate() {
        if label == 1 {
            crisis.push(annual_returns[index]);
        } else {
            growth.push(annual_returns[index]);
        }
    }

    let fallback_growth = if !growth.is_empty() {
        growth
    } else {
        annual_returns.to_vec()
    };

    let fallback_crisis = if !crisis.is_empty() {
        crisis
    } else {
        let mut sorted = annual_returns.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let take_count = 4.max((annual_returns.len() as f64 * 0.35).floor() as usize);
        sorted.into_iter().take(take_count).collect()
    };

    RegimePools {
        growth: fallback_growth,
        crisis: fallback_crisis,
    }
}

pub fn bootstrap_indices_by_regime_monthly(
    monthly_returns: &[f64],
    labels: &[u8],
) -> RegimePools<usize> {
    let mut growth = Vec::new();
    let mut crisis = Vec::new();

    for (index, &label) in labels.iter().enumerate() {
        if label == 1 {
            crisis.push(index);
        } else {
            growth.push(index);
        }
    }

    let fallback_growth = if !growth.is_empty() {
        growth
    } else {
        (0..monthly_returns.len()).collect()
    };

    let fallback_crisis = if !crisis.is_empty() {
        crisis
    } else {
        let mut indices: Vec<usize> = (0..monthly_returns.len()).collect();
        indices.sort_by(|&a, &b| {
            monthly_returns[a]
                .partial_cmp(&monthly_returns[b])
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let take_count = 12.max((monthly_returns.len() as f64 * 0.3).floor() as usize);
        indices.into_iter().take(take_count).collect()
    };

    RegimePools {
        growth: fallback_growth,
        crisis: fallback_crisis,
    }
}

pub fn estimate_markov_stay_probabilities(labels: &[u8]) -> (f64, f64) {
    let mut growth_stay = 0.0;
    let mut growth_total = 0.0;
    let mut crisis_stay = 0.0;
    let mut crisis_total = 0.0;

    for index in 1..labels.len() {
        let prev = labels[index - 1];
        let curr = labels[index];
        if prev == 0 {
            growth_total += 1.0;
            if curr == 0 {
                growth_stay += 1.0;
            }
        } else {
            crisis_total += 1.0;
            if curr == 1 {
                crisis_stay += 1.0;
            }
        }
    }

    let stay_growth = crate::engine::clamp_transition_probability(if growth_total > 0.0 {
        growth_stay / growth_total
    } else {
        0.88
    });
    let stay_crisis = crate::engine::clamp_transition_probability(if crisis_total > 0.0 {
        crisis_stay / crisis_total
    } else {
        0.72
    });

    (stay_growth, stay_crisis)
}

pub fn monthly_returns_to_annual_series(monthly_returns: &[f64]) -> Vec<f64> {
    let mut annual = Vec::new();
    let mut acc = 1.0;
    let mut month_count = 0;
    for &monthly_return in monthly_returns {
        acc *= 1.0 + monthly_return;
        month_count += 1;
        if month_count == 12 {
            annual.push(acc - 1.0);
            acc = 1.0;
            month_count = 0;
        }
    }
    annual
}

pub struct CashflowArrays {
    pub monthly_net_flow: Vec<f64>,
    pub lump_sum_by_month: Vec<f64>,
}

pub fn expected_inflation_index_at_age(input: &RetirementInput, age: f64) -> f64 {
    let years_from_now = (age - input.current_age).max(0.0);
    1e-9_f64.max((1.0 + input.inflation_mean).powf(years_from_now))
}

pub fn spending_at_age(age: f64, spending_periods: &[SpendingPeriod], inflation_index: f64) -> f64 {
    spending_periods
        .iter()
        .filter(|period| period.from_age <= age && period.to_age > age)
        .fold(0.0, |sum, period| {
            let is_inflation_adjusted = period.inflation_adjusted.unwrap_or(true);
            sum + if is_inflation_adjusted {
                period.yearly_amount
            } else {
                period.yearly_amount / inflation_index
            }
        })
}

pub fn income_at_age(age: f64, income_sources: &[IncomeSource], inflation_index: f64) -> f64 {
    income_sources
        .iter()
        .filter(|source| source.from_age <= age && source.to_age > age)
        .fold(0.0, |sum, source| {
            let is_inflation_adjusted = source.inflation_adjusted.unwrap_or(true);
            sum + if is_inflation_adjusted {
                source.yearly_amount
            } else {
                source.yearly_amount / inflation_index
            }
        })
}

pub fn build_cashflow_arrays(
    input: &RetirementInput,
    spending_periods: &[SpendingPeriod],
    income_sources: &[IncomeSource],
    lump_sum_events: &[LumpSumEvent],
    months: u32,
) -> CashflowArrays {
    let mut monthly_net_flow = vec![0.0; months as usize];
    let mut lump_sum_by_month = vec![0.0; months as usize];

    for m in 0..months {
        let age = input.current_age + (m as f64) / 12.0;
        let inflation_index = expected_inflation_index_at_age(input, age);
        let income = income_at_age(age, income_sources, inflation_index);
        let spending = spending_at_age(age, spending_periods, inflation_index);
        monthly_net_flow[m as usize] = (income - spending) / 12.0;
    }

    for event in lump_sum_events {
        let month_index = ((event.age - input.current_age) * 12.0).round() as isize;
        if month_index >= 0 && month_index < months as isize {
            lump_sum_by_month[month_index as usize] += event.amount;
        }
    }

    CashflowArrays {
        monthly_net_flow,
        lump_sum_by_month,
    }
}
