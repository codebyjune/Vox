//! Rust-layer denoise.
//!
//! This module is the single source of truth for the DSP math (mirrored in the
//! AudioWorklet at `client/public/worklets/denoise-processor.js`) and owns the
//! denoise settings model shared with the frontend.
//!
//! Two roles:
//!   1. Offline / batched processing of audio buffers via [`apply_denoise`]
//!      (powers a future "record & test" feature; proves the Rust path works).
//!   2. Discovering which WASM AI models are bundled, so the UI only offers
//!      engines that actually exist on disk.
//!
//! The *live* real-time path still runs in the webview's audio thread, because
//! routing per-quantum audio across the IPC boundary would add latency. The
//! Rust-compiled WASM models are consumed by that worklet.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Denoise strategy, matching the TypeScript `DenoiseMode` union.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DenoiseMode {
    Off,
    Basic,
    #[default]
    Smart,
}

/// Full settings payload, matching `client/src/types.ts`.
#[derive(Clone, Debug, Deserialize)]
#[allow(dead_code)] // fields exist to match the frontend wire format
pub struct Settings {
    #[serde(default)]
    pub mode: DenoiseMode,
    #[serde(default = "default_strength")]
    pub strength: f32,
    #[serde(default = "default_true")]
    pub agc: bool,
    #[serde(default = "default_true")]
    pub echo_cancellation: bool,
    #[serde(default)]
    pub model: Option<String>,
}

fn default_strength() -> f32 {
    0.85
}
fn default_true() -> bool {
    true
}

/// One-pole high-pass + adaptive noise-gate state (per channel, mono here).
#[derive(Clone)]
pub struct Denoiser {
    noise_floor: f32,
    env: f32,
    gain: f32,
    hp: [f32; 2],
    sample_rate: f32,
}

impl Denoiser {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            noise_floor: 0.02,
            env: 0.0,
            gain: 1.0,
            hp: [0.0; 2],
            sample_rate,
        }
    }

    /// High-pass RBJ biquad coefficient (alpha) at fc=80 Hz, Q=0.707.
    fn hp_alpha(&self) -> f32 {
        let w = 2.0 * std::f32::consts::PI * 80.0 / self.sample_rate;
        w.sin() / (2.0 * 0.707)
    }

    fn highpass(&mut self, x: f32) -> f32 {
        let c = (2.0 * std::f32::consts::PI * 80.0 / self.sample_rate).cos();
        let alpha = self.hp_alpha();
        let b0 = (1.0 + c) / 2.0;
        let b1 = -(1.0 + c);
        let b2 = (1.0 + c) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * c;
        let a2 = 1.0 - alpha;
        let y = (b0 * x + b1 * self.hp[0] + b2 * self.hp[1] - a1 * self.hp[0] - a2 * self.hp[1]) / a0;
        self.hp[1] = self.hp[0];
        self.hp[0] = x;
        y
    }

    /// In-place DSP denoise (adaptive noise gate), matching the worklet.
    pub fn process(&mut self, samples: &mut [f32], strength: f32) {
        let attack = 0.4_f32;
        let release = 0.0015_f32;
        let open_margin = 0.012 + 0.03 * (1.0 - strength);
        let min_gain = 1.0 - strength;

        for s in samples.iter_mut() {
            let x = self.highpass(*s);
            let absx = x.abs();

            // Envelope follower.
            self.env = if absx > self.env {
                self.env * (1.0 - attack) + absx * attack
            } else {
                self.env + release * (absx - self.env)
            };

            // Minimum-tracking noise-floor estimate.
            if self.env < self.noise_floor {
                self.noise_floor = self.env * 0.0002 + self.noise_floor * 0.9998;
            } else {
                self.noise_floor = self.noise_floor * 0.9999 + 0.000002;
            }

            let denom = (self.noise_floor + open_margin).max(1e-6);
            let target = if self.env > self.noise_floor + open_margin {
                1.0
            } else {
                min_gain * (self.env / denom)
            };

            let rate = if target > self.gain { 0.2 } else { 0.008 };
            self.gain += rate * (target - self.gain);
            self.gain = self.gain.clamp(min_gain, 1.0);

            *s = x * self.gain;
        }
    }
}

/// Process a flat f32 buffer with the given settings. Used for offline
/// preview / batch jobs (not the live mic path).
pub fn apply_denoise(samples: Vec<f32>, settings: Settings) -> Vec<f32> {
    match settings.mode {
        DenoiseMode::Off => samples,
        DenoiseMode::Basic => {
            // Browser handles this for the live track; nothing to do offline.
            samples
        }
        DenoiseMode::Smart => {
            let mut d = Denoiser::new(48000.0);
            let mut out = samples;
            d.process(&mut out, settings.strength);
            out
        }
    }
}

/// List bundled WASM model ids that are actually present in the resource dir.
pub fn list_models(resource_dir: &Path) -> Vec<String> {
    let dir = resource_dir.join("resources").join("wasm");
    let known = ["rnnoise", "dtln", "deepfilter"];
    let mut found = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("wasm") {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if known.contains(&stem) {
                    found.push(stem.to_string());
                }
            }
        }
    }
    found
}
