use crate::structs::{IncomeSource, LumpSumEvent, RetirementInput, SpendingPeriod, WithdrawalStrategy};

/// Stateful evaluator for dynamic withdrawal strategies. Shared by the main simulation
/// loop and the ruin-surface replay so the two never diverge. Returns the effective
/// monthly spending (a positive outflow) given the running balance.
///
/// - `fixed`: spending follows the planned real-terms schedule unchanged.
/// - `guardrails`: Guyton-Klinger — during retirement, if the current withdrawal rate
///   drifts above/below the initial rate by `guardrail_band`, spending is cut/raised by
///   `adjustment`, clamped to [floor, ceiling] × initial real spending. Decisions are
///   made once per retirement year.
/// - `percentOfPortfolio`: during retirement, spend `withdrawal_percent` of the current
///   balance each year (recomputed annually), clamped to [floor, ceiling] × initial real
///   spending so it never collapses to near-zero or explodes.
pub struct WithdrawalRunner {
    kind: u8, // 0 fixed, 1 guardrails, 2 percent
    retire_month: usize,
    guardrail_band: f64,
    adjustment: f64,
    withdrawal_percent: f64,
    spending_floor: f64,
    spending_ceiling: f64,
    // state
    initialized: bool,
    multiplier: f64,
    initial_rate: f64,
    initial_annual_spending: f64,
    held_monthly_spending: f64,
}

impl WithdrawalRunner {
    pub fn new(strategy: &WithdrawalStrategy, retire_month: usize) -> Self {
        let kind = match strategy.kind.as_str() {
            "guardrails" => 1,
            "percentOfPortfolio" => 2,
            _ => 0,
        };
        WithdrawalRunner {
            kind,
            retire_month,
            guardrail_band: strategy.guardrail_band.unwrap_or(0.2).max(0.01),
            adjustment: strategy.adjustment.unwrap_or(0.1).clamp(0.0, 0.9),
            withdrawal_percent: strategy.withdrawal_percent.unwrap_or(0.04).max(0.0),
            spending_floor: strategy.spending_floor.unwrap_or(0.6).max(0.0),
            spending_ceiling: strategy.spending_ceiling.unwrap_or(1.4).max(0.0),
            initialized: false,
            multiplier: 1.0,
            initial_rate: 0.0,
            initial_annual_spending: 0.0,
            held_monthly_spending: 0.0,
        }
    }

    /// `base` is the month's planned spending already expressed in real terms, which the
    /// caller computes — with nominal items deflated by that path's realized inflation, it
    /// is path-dependent and can no longer be read from a precomputed array.
    pub fn monthly_spending(&mut self, m: usize, balance: f64, base: f64) -> f64 {
        // Accumulation phase, or the fixed strategy: follow the planned schedule.
        if self.kind == 0 || m < self.retire_month {
            return base;
        }
        let is_year_start = (m - self.retire_month) % 12 == 0;

        if !self.initialized {
            self.initial_annual_spending = base * 12.0;
            self.initial_rate = if balance > 0.0 {
                self.initial_annual_spending / balance
            } else {
                0.0
            };
            self.multiplier = 1.0;
            self.held_monthly_spending = base;
            self.initialized = true;
        }

        let floor_annual = self.spending_floor * self.initial_annual_spending;
        let ceiling_annual = self.spending_ceiling * self.initial_annual_spending;

        if self.kind == 1 {
            // Guyton-Klinger guardrails.
            if is_year_start && balance > 0.0 && self.initial_rate > 0.0 {
                let current_annual = base * 12.0 * self.multiplier;
                let current_rate = current_annual / balance;
                if current_rate > self.initial_rate * (1.0 + self.guardrail_band) {
                    self.multiplier *= 1.0 - self.adjustment;
                } else if current_rate < self.initial_rate * (1.0 - self.guardrail_band) {
                    self.multiplier *= 1.0 + self.adjustment;
                }
                let min_mult = self.spending_floor;
                let max_mult = self.spending_ceiling;
                self.multiplier = self.multiplier.clamp(min_mult, max_mult);
            }
            base * self.multiplier
        } else {
            // Percent-of-portfolio (recomputed annually, held for the year).
            if is_year_start {
                let target_annual = self.withdrawal_percent * balance.max(0.0);
                let clamped = target_annual.clamp(floor_annual, ceiling_annual);
                self.held_monthly_spending = clamped / 12.0;
            }
            self.held_monthly_spending
        }
    }
}

/// Inverts 12-fold compounding: given the requested *annual* arithmetic mean and standard
/// deviation, returns the monthly (mean, std) whose compounding over 12 independent months
/// reproduces them.
///
/// ```text
///   E[(1+r_a)]   = E[(1+r_m)]^12          ⇒  m = (1+M)^(1/12) − 1
///   E[(1+r_a)^2] = E[(1+r_m)^2]^12        ⇒  s = sqrt( ((1+M)^2 + S^2)^(1/12) − (1+M)^(2/12) )
/// ```
///
/// Both identities need only independence, not normality, since the expectation of a
/// product of independent factors is the product of expectations — so higher moments of
/// the retargeted history do not enter.
///
/// The naive `M/12` and `S/√12` are the *log*-scale intuition applied to arithmetic
/// returns; used here they overshoot, because compounding adds the cross-product terms
/// this inversion removes. At a 5%/15% target they yield 5.12%/15.79% instead of
/// 5.00%/15.00%.
///
/// This corrects the compounding artifact only. The block bootstrap deliberately preserves
/// serial dependence, which inflates realized annual variance further and is not an error —
/// see README §4.4 for the measured residual.
pub fn monthly_targets_for_annual_moments(annual_mean: f64, annual_std: f64) -> (f64, f64) {
    let growth = 1.0 + annual_mean;
    // A non-positive gross return (total loss or worse) has no real 12th root; fall back to
    // the naive scaling rather than produce NaN. Not reachable from the UI, which bounds
    // the mean well above −100%.
    if !growth.is_finite() || growth <= 0.0 || !annual_std.is_finite() {
        return (annual_mean / 12.0, annual_std.max(0.0) / 12.0_f64.sqrt());
    }

    let monthly_mean = growth.powf(1.0 / 12.0) - 1.0;
    let monthly_second_moment = (growth * growth + annual_std * annual_std).powf(1.0 / 12.0);
    let monthly_variance = monthly_second_moment - growth.powf(2.0 / 12.0);
    (monthly_mean, monthly_variance.max(0.0).sqrt())
}

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
    /// income − base spending, per month (the fixed-strategy net flow).
    pub monthly_net_flow: Vec<f64>,
    /// income only, per month (positive = inflow), nominal items deflated by the
    /// *expected* inflation index. Used by the ruin-surface/coast replay, which cannot
    /// recover per-path realized inflation from the stored growth factors.
    pub monthly_income_flow: Vec<f64>,
    /// base planned spending, per month (positive = outflow), same expected-index caveat.
    pub monthly_spending_flow: Vec<f64>,
    /// Inflation-adjusted income, constant in real terms — no deflation needed.
    pub monthly_real_income_flow: Vec<f64>,
    /// Face value of nominal income; divide by the path's realized inflation index.
    pub monthly_nominal_income_flow: Vec<f64>,
    /// Inflation-adjusted spending, constant in real terms.
    pub monthly_real_spending_flow: Vec<f64>,
    /// Face value of nominal spending; divide by the path's realized inflation index.
    pub monthly_nominal_spending_flow: Vec<f64>,
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

/// Splits spending at `age` into the part that is constant in real terms and the face
/// value of the part that is fixed in nominal terms. The nominal part must be deflated by
/// the *realized* inflation index of the path it is simulated on, which is only known
/// inside the simulation loop.
pub fn split_spending_at_age(age: f64, spending_periods: &[SpendingPeriod]) -> (f64, f64) {
    let mut real = 0.0;
    let mut nominal_face = 0.0;
    for period in spending_periods
        .iter()
        .filter(|period| period.from_age <= age && period.to_age > age)
    {
        if period.inflation_adjusted.unwrap_or(true) {
            real += period.yearly_amount;
        } else {
            nominal_face += period.yearly_amount;
        }
    }
    (real, nominal_face)
}

/// Income counterpart of [`split_spending_at_age`].
pub fn split_income_at_age(age: f64, income_sources: &[IncomeSource]) -> (f64, f64) {
    let mut real = 0.0;
    let mut nominal_face = 0.0;
    for source in income_sources
        .iter()
        .filter(|source| source.from_age <= age && source.to_age > age)
    {
        if source.inflation_adjusted.unwrap_or(true) {
            real += source.yearly_amount;
        } else {
            nominal_face += source.yearly_amount;
        }
    }
    (real, nominal_face)
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
    let mut monthly_income_flow = vec![0.0; months as usize];
    let mut monthly_spending_flow = vec![0.0; months as usize];
    let mut monthly_real_income_flow = vec![0.0; months as usize];
    let mut monthly_nominal_income_flow = vec![0.0; months as usize];
    let mut monthly_real_spending_flow = vec![0.0; months as usize];
    let mut monthly_nominal_spending_flow = vec![0.0; months as usize];
    let mut lump_sum_by_month = vec![0.0; months as usize];

    for m in 0..months {
        let age = input.current_age + (m as f64) / 12.0;
        let inflation_index = expected_inflation_index_at_age(input, age);

        let (real_income, nominal_income) = split_income_at_age(age, income_sources);
        let (real_spending, nominal_spending) = split_spending_at_age(age, spending_periods);
        monthly_real_income_flow[m as usize] = real_income / 12.0;
        monthly_nominal_income_flow[m as usize] = nominal_income / 12.0;
        monthly_real_spending_flow[m as usize] = real_spending / 12.0;
        monthly_nominal_spending_flow[m as usize] = nominal_spending / 12.0;

        // Expected-index versions, retained for the replay paths.
        let income = income_at_age(age, income_sources, inflation_index) / 12.0;
        let spending = spending_at_age(age, spending_periods, inflation_index) / 12.0;
        monthly_income_flow[m as usize] = income;
        monthly_spending_flow[m as usize] = spending;
        monthly_net_flow[m as usize] = income - spending;
    }

    for event in lump_sum_events {
        let month_index = ((event.age - input.current_age) * 12.0).round() as isize;
        if month_index >= 0 && month_index < months as isize {
            lump_sum_by_month[month_index as usize] += event.amount;
        }
    }

    CashflowArrays {
        monthly_net_flow,
        monthly_income_flow,
        monthly_spending_flow,
        monthly_real_income_flow,
        monthly_nominal_income_flow,
        monthly_real_spending_flow,
        monthly_nominal_spending_flow,
        lump_sum_by_month,
    }
}
