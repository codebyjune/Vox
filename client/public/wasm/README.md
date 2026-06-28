# WASM denoise models (optional, for Smart → AI mode)

The Smart mode works out of the box with a **built-in DSP** noise gate
(runs in `public/worklets/denoise-processor.js` — no model required).

To upgrade to a real AI model, drop the compiled `.wasm` into this folder and
select it in the **Engine** dropdown. The names must match `WASM_MODELS` in
`src/config.ts`:

| Dropdown option      | Expected file      |
| -------------------- | ------------------ |
| RNNoise (WASM)       | `rnnoise.wasm`     |
| DTLN-rs (WASM)       | `dtln.wasm`        |
| DeepFilterNet (WASM) | `deepfilter.wasm`  |

## Required WASM ABI

The worklet calls, per 10 ms frame (480 f32 samples @ 48 kHz):

```c
// exports
void denoise_frame(float* in, float* out);   // 480 samples in / 480 out
unsigned char memory[];                        // WebAssembly linear memory
// optional but recommended:
void* malloc(size_t);                          // scratch alloc
```

If the model lacks `denoise_frame` / `memory`, the worklet falls back to the
built-in DSP automatically (a warning is logged).

## Compiling the Rust models to WASM

Each model is a Rust crate; build with `wasm32-unknown-unknown` and the right
exports. Example for DTLN-rs:

```bash
rustup target add wasm32-unknown-unknown
# In the dtln-rs crate, ensure a thin C-ABI shim:
#   #[no_mangle] pub unsafe extern "C"
#   fn denoise_frame(in_ptr: *const f32, out_ptr: *mut f32) { ... }
cargo build --release --target wasm32-unknown-unknown
wasm-tools strip target/wasm32-unknown-unknown/release/dtln.wasm \
  -o client/public/wasm/dtln.wasm
```

For RNNoise use the prebuilt `rnnoise.wasm` from `picovoice`/`jitsi`, or wrap
the C library with `wasi-sdk` and add the `denoise_frame` shim.

A matching reference algorithm lives in the Tauri Rust layer at
`client/src-tauri/src/denoise.rs` — it is the single source of truth for the
DSP math and is also usable for offline/batched processing of recordings.
