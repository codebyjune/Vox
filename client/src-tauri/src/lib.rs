//! VoiceApp desktop client entry point (Tauri v2).
//!
//! Wires the store plugin (for persisted settings) and a couple of Rust-layer
//! commands around the [`denoise`] module.

mod denoise;

use denoise::{apply_denoise, list_models, Settings};
use tauri::Manager;

/// Offline denoise for a Float32 PCM buffer (mono, 48 kHz).
/// Powers preview/batch processing; the live mic path runs in the worklet.
///
/// Caps the input at 10 minutes @ 48 kHz (≈ 28.8 M samples, ≈ 115 MB f32)
/// to keep a buggy or hostile caller from OOM-ing the process.
#[tauri::command]
fn denoise_buffer(samples: Vec<f32>, settings: Settings) -> Result<Vec<f32>, String> {
    const MAX_SAMPLES: usize = 48_000 * 60 * 10;
    if samples.len() > MAX_SAMPLES {
        return Err(format!(
            "denoise_buffer: payload too large ({} samples, max {})",
            samples.len(),
            MAX_SAMPLES
        ));
    }
    Ok(apply_denoise(samples, settings))
}

/// Which WASM AI models are bundled on disk (so the UI only offers real ones).
#[tauri::command]
fn available_models(app: tauri::AppHandle) -> Vec<String> {
    match app.path().resource_dir() {
        Ok(dir) => list_models(&dir),
        Err(_) => Vec::new(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![denoise_buffer, available_models])
        .run(tauri::generate_context!())
        .expect("error while running VoiceApp");
}
