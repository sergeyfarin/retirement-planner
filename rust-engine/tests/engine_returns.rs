//! Return-generation primitives: regime transitions, shaped draws, clamps.

mod common;

use common::assert_close;
use rust_engine::calculations::RandomSource;
use rust_engine::engine::{
    annual_to_monthly_return, clamp_annual_return, clamp_monthly_return,
    clamp_transition_probability, draw_cornish_fisher_score, draw_monthly_return_shaped,
    draw_student_t, get_growth_stationary_probability, initial_regime_state,
    spread_annual_return_across_months, student_t_degrees_from_kurtosis, transition_regime_state,
};

#[test]
fn transition_probabilities_stay_strictly_inside_zero_and_one() {
    assert_eq!(clamp_transition_probability(0.0), 0.001);
    assert_eq!(clamp_transition_probability(1.0), 0.999);
    assert_eq!(clamp_transition_probability(-4.0), 0.001);
    assert_eq!(clamp_transition_probability(0.5), 0.5);
}

#[test]
fn stationary_probability_matches_the_two_state_markov_solution() {
    // π_growth = (1 - stayCrisis) / (2 - stayGrowth - stayCrisis)
    assert_close(get_growth_stationary_probability(0.9, 0.7), 0.75, 1e-12);
    // Symmetric persistence ⇒ equal shares.
    assert_close(get_growth_stationary_probability(0.8, 0.8), 0.5, 1e-12);
}

#[test]
fn stationary_probability_falls_back_when_both_states_are_absorbing() {
    // stayGrowth = stayCrisis = 1 makes the denominator vanish; the chain has no unique
    // stationary distribution, so the engine reports an even split rather than dividing by
    // zero.
    assert_eq!(get_growth_stationary_probability(1.0, 1.0), 0.5);
}

#[test]
fn initial_state_is_drawn_at_roughly_the_stationary_rate() {
    let mut rng = RandomSource::new(Some(2024.0));
    let trials = 20_000;
    let growth = (0..trials)
        .filter(|_| initial_regime_state(0.9, 0.7, &mut rng) == 0)
        .count() as f64
        / trials as f64;
    assert_close(growth, 0.75, 0.02);
}

#[test]
fn regime_transitions_respect_the_stay_probabilities() {
    let mut rng = RandomSource::new(Some(11.0));
    let trials = 20_000;

    let stayed_growth = (0..trials)
        .filter(|_| transition_regime_state(0, 0.9, 0.7, &mut rng) == 0)
        .count() as f64
        / trials as f64;
    assert_close(stayed_growth, 0.9, 0.02);

    let stayed_crisis = (0..trials)
        .filter(|_| transition_regime_state(1, 0.9, 0.7, &mut rng) == 1)
        .count() as f64
        / trials as f64;
    assert_close(stayed_crisis, 0.7, 0.02);
}

#[test]
fn regime_transitions_are_deterministic_at_the_extremes() {
    let mut rng = RandomSource::new(Some(3.0));
    for _ in 0..100 {
        assert_eq!(transition_regime_state(0, 1.0, 1.0, &mut rng), 0);
        assert_eq!(transition_regime_state(1, 1.0, 1.0, &mut rng), 1);
        assert_eq!(transition_regime_state(0, 0.0, 0.0, &mut rng), 1);
        assert_eq!(transition_regime_state(1, 0.0, 0.0, &mut rng), 0);
    }
}

#[test]
fn cornish_fisher_reduces_to_the_normal_score_for_normal_moments() {
    let mut shaped = RandomSource::new(Some(808.0));
    let mut plain = RandomSource::new(Some(808.0));
    for _ in 0..200 {
        assert_eq!(
            draw_cornish_fisher_score(0.0, 3.0, &mut shaped),
            plain.normal(0.0, 1.0)
        );
    }
}

#[test]
fn cornish_fisher_moves_skew_and_kurtosis_in_the_requested_direction() {
    let sample = |skew: f64, kurt: f64| -> (f64, f64) {
        let mut rng = RandomSource::new(Some(5150.0));
        let n = 200_000;
        let values: Vec<f64> = (0..n)
            .map(|_| draw_cornish_fisher_score(skew, kurt, &mut rng))
            .collect();
        let mean = values.iter().sum::<f64>() / n as f64;
        let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64;
        let sd = var.sqrt();
        let skewness = values
            .iter()
            .map(|v| ((v - mean) / sd).powi(3))
            .sum::<f64>()
            / n as f64;
        let kurtosis = values
            .iter()
            .map(|v| ((v - mean) / sd).powi(4))
            .sum::<f64>()
            / n as f64;
        (skewness, kurtosis)
    };

    let (baseline_skew, baseline_kurt) = sample(0.0, 3.0);
    assert_close(baseline_skew, 0.0, 0.05);
    assert_close(baseline_kurt, 3.0, 0.1);

    let (negative_skew, _) = sample(-0.8, 3.0);
    assert!(
        negative_skew < -0.3,
        "expected left tail, got {negative_skew}"
    );

    let (positive_skew, _) = sample(0.8, 3.0);
    assert!(
        positive_skew > 0.3,
        "expected right tail, got {positive_skew}"
    );

    let (_, fat_kurt) = sample(0.0, 7.0);
    assert!(fat_kurt > 3.5, "expected fatter tails, got {fat_kurt}");
}

#[test]
fn cornish_fisher_bounds_extreme_moment_requests() {
    // Skew is bounded to ±1.5 and excess kurtosis to [0, 8], so absurd inputs saturate
    // rather than producing a wilder expansion.
    let draw = |skew: f64, kurt: f64| {
        let mut rng = RandomSource::new(Some(31.0));
        (0..500)
            .map(|_| draw_cornish_fisher_score(skew, kurt, &mut rng))
            .collect::<Vec<f64>>()
    };
    assert_eq!(draw(5.0, 3.0), draw(1.5, 3.0));
    assert_eq!(draw(0.0, 100.0), draw(0.0, 11.0));
    // Kurtosis below normal is treated as normal, never negative excess.
    assert_eq!(draw(0.0, 1.0), draw(0.0, 3.0));
}

#[test]
fn monthly_shaped_draws_scale_the_annual_moments() {
    let mut rng = RandomSource::new(Some(606.0));
    let n = 100_000;
    let values: Vec<f64> = (0..n)
        .map(|_| draw_monthly_return_shaped(0.12, 0.24, 0.0, 3.0, &mut rng))
        .collect();
    let mean = values.iter().sum::<f64>() / n as f64;
    let sd = (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64).sqrt();
    assert_close(mean, 0.01, 0.002);
    assert_close(sd, 0.24 / 12.0_f64.sqrt(), 0.002);
}

#[test]
fn student_t_has_unit_ish_scale_and_fat_tails() {
    let mut rng = RandomSource::new(Some(404.0));
    let n = 100_000;
    let values: Vec<f64> = (0..n).map(|_| draw_student_t(8.0, &mut rng)).collect();
    let mean = values.iter().sum::<f64>() / n as f64;
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64;
    assert_close(mean, 0.0, 0.02);
    // Var(t_ν) = ν/(ν−2) = 8/6 ≈ 1.333.
    assert_close(var, 8.0 / 6.0, 0.05);
    assert!(values.iter().any(|v| v.abs() > 5.0), "expected fat tails");
}

#[test]
fn student_t_floors_the_degrees_of_freedom_at_three() {
    // df ≤ 2 would give infinite variance and a divide-by-tiny chi-square; the floor keeps
    // every draw finite.
    let mut rng = RandomSource::new(Some(17.0));
    for df in [-10.0, 0.0, 1.0, 2.4] {
        for _ in 0..500 {
            assert!(draw_student_t(df, &mut rng).is_finite());
        }
    }
}

#[test]
fn degrees_of_freedom_map_kurtosis_into_the_supported_band() {
    // Normal or thinner ⇒ effectively Gaussian.
    assert_eq!(student_t_degrees_from_kurtosis(3.0), 40.0);
    assert_eq!(student_t_degrees_from_kurtosis(1.0), 40.0);
    assert_eq!(student_t_degrees_from_kurtosis(3.04), 40.0);
    // Mild excess clamps to the upper bound, heavy excess to the lower.
    assert_eq!(student_t_degrees_from_kurtosis(3.06), 60.0);
    assert_eq!(student_t_degrees_from_kurtosis(100.0), 5.0);
    // Interior: excess 1.0 ⇒ 4 + 6/1 = 10.
    assert_close(student_t_degrees_from_kurtosis(4.0), 10.0, 1e-12);
}

#[test]
fn return_clamps_bound_both_horizons() {
    assert_eq!(clamp_annual_return(-2.0), -0.95);
    assert_eq!(clamp_annual_return(9.0), 1.2);
    assert_eq!(clamp_annual_return(0.07), 0.07);
    assert_eq!(clamp_monthly_return(-1.0), -0.6);
    assert_eq!(clamp_monthly_return(1.0), 0.6);
    assert_eq!(clamp_monthly_return(0.01), 0.01);
}

#[test]
fn annual_to_monthly_is_the_twelfth_root_of_the_clamped_gross_return() {
    assert_close(annual_to_monthly_return(0.0), 0.0, 1e-15);
    let monthly = annual_to_monthly_return(0.06);
    assert_close((1.0 + monthly).powi(12) - 1.0, 0.06, 1e-12);
    // Clamped first: −200% has no real twelfth root.
    assert_close(
        annual_to_monthly_return(-2.0),
        0.05_f64.powf(1.0 / 12.0) - 1.0,
        1e-12,
    );
    assert!(annual_to_monthly_return(-2.0).is_finite());
}

#[test]
fn spreading_an_annual_return_preserves_it_exactly() {
    let mut rng = RandomSource::new(Some(90210.0));
    for annual in [-0.35, -0.05, 0.0, 0.08, 0.4] {
        let months = spread_annual_return_across_months(annual, 0.04, -0.3, 4.0, &mut rng);
        let compounded = months.iter().fold(1.0, |acc, r| acc * (1.0 + r)) - 1.0;
        assert_close(compounded, annual, 1e-9);
        // Real intra-year texture, not twelve identical months.
        assert!(months.iter().any(|r| (r - months[0]).abs() > 1e-6));
    }
}

#[test]
fn spreading_without_dispersion_returns_twelve_equal_months() {
    let mut rng = RandomSource::new(Some(1.0));
    for std in [0.0, -0.1, f64::NAN] {
        let months = spread_annual_return_across_months(0.09, std, 0.0, 3.0, &mut rng);
        assert!(months.iter().all(|r| (r - months[0]).abs() < 1e-15));
        assert_close(
            months.iter().fold(1.0, |acc, r| acc * (1.0 + r)) - 1.0,
            0.09,
            1e-12,
        );
    }
}

#[test]
fn spreading_produces_finite_months_for_extreme_annual_inputs() {
    let mut rng = RandomSource::new(Some(2.0));
    for annual in [-5.0, 20.0] {
        let months = spread_annual_return_across_months(annual, 0.5, 1.5, 12.0, &mut rng);
        assert!(months.iter().all(|r| r.is_finite() && *r > -1.0));
    }
}
