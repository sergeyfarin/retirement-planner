use js_sys::Math;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PercentileSeries<T> {
    pub p10: T,
    pub p25: T,
    pub p50: T,
    pub p75: T,
    pub p90: T,
}

pub struct RandomSource {
    state: Option<u32>,
    spare_normal: Option<f64>,
}

impl RandomSource {
    pub fn new(seed: Option<f64>) -> Self {
        let state = if let Some(s) = seed {
            if s.is_finite() {
                Some((s.round() as i64) as u32)
            } else {
                None
            }
        } else {
            None
        };

        Self {
            state,
            spare_normal: None,
        }
    }

    pub fn random(&mut self) -> f64 {
        if let Some(state) = &mut self.state {
            // Mulberry32
            *state = state.wrapping_add(0x6D2B79F5);
            let mut t = *state ^ (*state >> 15);
            t = t.wrapping_mul(1 | *state);
            t ^= t.wrapping_add(t.wrapping_mul(t ^ (t >> 7)) & (61 | t)); // Approximation of JS Math.imul

            // Following exact JS imul steps:
            let js_imul1 = (*state ^ (*state >> 15)).wrapping_mul(1 | *state);
            let js_imul2 = (js_imul1 ^ (js_imul1 >> 7)).wrapping_mul(61 | js_imul1);
            let t_val = js_imul1 ^ js_imul1.wrapping_add(js_imul2);
            let final_val = t_val ^ (t_val >> 14);
            (final_val as f64) / 4294967296.0
        } else {
            Math::random()
        }
    }

    pub fn normal(&mut self, mean: f64, std: f64) -> f64 {
        if std <= 0.0 {
            return mean;
        }

        if let Some(cached) = self.spare_normal.take() {
            return mean + std * cached;
        }

        let mut u = 0.0;
        let mut v = 0.0;
        while u == 0.0 {
            u = self.random();
        }
        while v == 0.0 {
            v = self.random();
        }

        let mag = (-2.0 * u.ln()).sqrt();
        let z0 = mag * (2.0 * std::f64::consts::PI * v).cos();
        let z1 = mag * (2.0 * std::f64::consts::PI * v).sin();

        self.spare_normal = Some(z1);
        mean + std * z0
    }
}

pub fn percentile(sorted_array: &[f64], p: f64) -> f64 {
    let len = sorted_array.len();
    if len == 0 {
        return 0.0;
    }
    if p <= 0.0 {
        return sorted_array[0];
    }
    if p >= 1.0 {
        return sorted_array[len - 1];
    }

    let index = p * (len - 1) as f64;
    let lower = index.floor() as usize;
    let upper = index.ceil() as usize;
    let weight = index % 1.0;

    if lower == upper {
        return sorted_array[lower];
    }

    sorted_array[lower] * (1.0 - weight) + sorted_array[upper] * weight
}

pub fn summarize(values: &[f64]) -> PercentileSeries<f64> {
    let mut sorted = values.to_vec();
    // f64 doesn't implement Ord directly because of NaN, but our values are always finite
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    PercentileSeries {
        p10: percentile(&sorted, 0.1),
        p25: percentile(&sorted, 0.25),
        p50: percentile(&sorted, 0.5),
        p75: percentile(&sorted, 0.75),
        p90: percentile(&sorted, 0.9),
    }
}

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}
