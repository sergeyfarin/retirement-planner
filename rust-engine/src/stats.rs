use crate::calculations::{percentile, summarize};
use crate::engine::{RuinSurface, SequenceRiskBucket};
use crate::engine2::build_cashflow_arrays;
use crate::structs::{IncomeSource, LumpSumEvent, RetirementInput, SpendingPeriod};

pub fn build_sequence_risk_summary(
    annual_real_returns_by_sim: &[Vec<f64>],
    final_balances: &[f64],
    depleted_flags: &[bool],
) -> Vec<SequenceRiskBucket> {
    let sim_count = annual_real_returns_by_sim.len();
    if sim_count == 0 {
        return vec![];
    }

    let min_length = annual_real_returns_by_sim
        .iter()
        .map(|series| series.len().max(1))
        .min()
        .unwrap_or(1);
    let early_years = 1.max(10.min(min_length));

    struct EnrichedIndex {
        index: usize,
        early_mean: f64,
    }

    let mut enriched: Vec<EnrichedIndex> = annual_real_returns_by_sim
        .iter()
        .enumerate()
        .map(|(index, series)| {
            let sum: f64 = series.iter().take(early_years).sum();
            EnrichedIndex {
                index,
                early_mean: sum / (early_years as f64),
            }
        })
        .collect();

    enriched.sort_by(|a, b| {
        a.early_mean
            .partial_cmp(&b.early_mean)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let bucket_count = 5;
    let mut buckets: Vec<SequenceRiskBucket> = Vec::with_capacity(bucket_count);

    for bucket in 0..bucket_count {
        let from = (bucket * sim_count) / bucket_count;
        let to = ((bucket + 1) * sim_count) / bucket_count;
        let members = &enriched[from..to];
        if members.is_empty() {
            continue;
        }

        let early_mean_sum: f64 = members.iter().map(|m| m.early_mean).sum();
        let early_mean = early_mean_sum / (members.len() as f64);

        let mut ruin_count = 0;
        let mut member_final_balances = Vec::with_capacity(members.len());

        for member in members {
            let idx = member.index;
            if depleted_flags[idx] || final_balances[idx] <= 0.0 {
                ruin_count += 1;
            }
            member_final_balances.push(final_balances[idx]);
        }

        let p_series = summarize(&member_final_balances);
        let ending_median = p_series.p50;

        let label = if bucket == 0 {
            format!("Q{} (worst early sequence)", bucket + 1)
        } else if bucket == bucket_count - 1 {
            format!("Q{} (best early sequence)", bucket + 1)
        } else {
            format!("Q{}", bucket + 1)
        };

        buckets.push(SequenceRiskBucket {
            bucket_label: label,
            early_years_mean_return: early_mean,
            ruin_probability: (ruin_count as f64) / (members.len() as f64),
            ending_median,
        });
    }

    buckets
}

pub fn replay_ruin_probability(
    growth_factors: &[Vec<f64>],
    monthly_net_flow: &[f64],
    lump_sum_by_month: &[f64],
    current_savings: f64,
    sample_count: usize,
    months: u32,
) -> f64 {
    let mut ruin_count = 0;

    for sim in 0..sample_count {
        let mut balance = current_savings;
        let mut ruined = false;

        for month in 0..months as usize {
            balance += monthly_net_flow[month] + lump_sum_by_month[month];
            balance *= growth_factors[sim][month];
            if balance <= 0.0 {
                balance = 0.0;
                ruined = true;
            }
        }

        if ruined || balance <= 0.0 {
            ruin_count += 1;
        }
    }

    (ruin_count as f64) / (sample_count.max(1) as f64)
}

pub fn build_ruin_surface(
    input: &RetirementInput,
    spending_periods: &[SpendingPeriod],
    income_sources: &[IncomeSource],
    lump_sum_events: &[LumpSumEvent],
    growth_factors: &[Vec<f64>],
    months: u32,
    sim_count: usize,
) -> RuinSurface {
    let spending_multipliers = vec![0.8, 0.9, 1.0, 1.1, 1.2];

    let offsets = vec![-6.0, -3.0, 0.0, 3.0, 6.0];
    let mut retirement_ages: Vec<usize> = offsets
        .iter()
        .map(|&offset| {
            let age = input.retirement_age + offset;
            (input.simulate_until_age - 1.0)
                .min((input.current_age + 1.0).max(age))
                .round() as usize
        })
        .collect();

    retirement_ages.sort_unstable();
    retirement_ages.dedup();

    let sampled_scenarios = sim_count.min(800);

    let ruin_probabilities: Vec<Vec<f64>> = spending_multipliers
        .iter()
        .map(|&multiplier| {
            let scaled_spending: Vec<SpendingPeriod> = spending_periods
                .iter()
                .map(|period| SpendingPeriod {
                    yearly_amount: period.yearly_amount * multiplier,
                    ..period.clone()
                })
                .collect();

            retirement_ages
                .iter()
                .map(|&ret_age| {
                    let mut adjusted_input = input.clone();
                    adjusted_input.retirement_age = ret_age as f64;

                    let adjusted_income: Vec<IncomeSource> = income_sources
                        .iter()
                        .map(|source| {
                            if source.id == "is-default" {
                                IncomeSource {
                                    to_age: ret_age as f64,
                                    ..source.clone()
                                }
                            } else {
                                source.clone()
                            }
                        })
                        .collect();

                    let arrays = build_cashflow_arrays(
                        &adjusted_input,
                        &scaled_spending,
                        &adjusted_income,
                        lump_sum_events,
                        months,
                    );

                    replay_ruin_probability(
                        growth_factors,
                        &arrays.monthly_net_flow,
                        &arrays.lump_sum_by_month,
                        input.current_savings,
                        sampled_scenarios,
                        months,
                    )
                })
                .collect()
        })
        .collect();

    RuinSurface {
        retirement_ages,
        spending_multipliers,
        ruin_probabilities,
    }
}

pub fn find_retirement_balance_target(
    retirement_balances: &[f64],
    ending_balances: &[f64],
    target_success_probability: f64,
) -> f64 {
    let outcome_count = retirement_balances.len().min(ending_balances.len());
    if outcome_count == 0 {
        return 0.0;
    }

    struct Outcome {
        retirement_balance: f64,
        ending_positive: bool,
    }

    let mut outcomes: Vec<Outcome> = (0..outcome_count)
        .map(|index| Outcome {
            retirement_balance: retirement_balances[index],
            ending_positive: ending_balances[index] > 0.0,
        })
        .collect();

    outcomes.sort_by(|a, b| {
        a.retirement_balance
            .partial_cmp(&b.retirement_balance)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut suffix_success = vec![0; outcome_count + 1];
    for index in (0..outcome_count).rev() {
        suffix_success[index] = suffix_success[index + 1]
            + if outcomes[index].ending_positive {
                1
            } else {
                0
            };
    }

    let mut required_target = outcomes[outcome_count - 1].retirement_balance;
    for index in 0..outcome_count {
        let sample_size = (outcome_count - index) as f64;
        let success_probability = (suffix_success[index] as f64) / sample_size;
        if success_probability >= target_success_probability {
            required_target = outcomes[index].retirement_balance;
            break;
        }
    }

    required_target.max(0.0)
}
