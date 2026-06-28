// AudioWorklet: "denoise-processor"
// ---------------------------------------------------------------------------
// Real-time microphone denoise running on the dedicated audio render thread.
//
// Two engines, switchable without republishing:
//
//   1) Built-in DSP (always available): adaptive noise-gate with smoothed
//      attack/release + 80 Hz high-pass. Great for steady noise (fans, AC,
//      PC coil whine) while keeping speech clear. Strength is a live AudioParam.
//
//   2) WASM AI model (optional upgrade): drop a model compiled from Rust into
//      client/public/wasm/ and set settings.model. The worklet lazily fetches
//      and instantiates it, then routes 10 ms frames through the model.
//      Expected WASM ABI (see public/wasm/README.md):
//         exports.denoise_frame(inPtr, outPtr)   // 480 f32 in/out @ 48 kHz
//         exports.memory                         // growable linear memory
//      If the ABI does not match, it silently falls back to the DSP engine.
//
// Inputs/outputs: mono (channel 0). Works at the host quantum (usually 128).
// ---------------------------------------------------------------------------

const FRAME = 480; // 10 ms @ 48 kHz (RNNoise/DTLN frame size)

class DenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "strength",
        defaultValue: 0.85,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.strength = o.strength ?? 0.85;

    // --- built-in DSP state ---
    this.noiseFloor = 0.02; // estimated background level
    this.env = 0; // smoothed input envelope
    this.gain = 1; // current gate gain
    this.hpState = [0, 0]; // high-pass biquad state

    // --- WASM model state ---
    this.wasmUrl = o.wasmUrl || null;
    this.wasm = null; // { exports, inPtr, outPtr }
    this.frameBuf = new Float32Array(FRAME);
    this.frameFill = 0;

    if (this.wasmUrl) {
      this.initWasm(this.wasmUrl).catch((e) =>
        console.warn("denoise wasm init failed, using DSP", e)
      );
    }

    // Allow the main thread to push new WASM URLs / messages.
    this.port.onmessage = (e) => {
      if (e.data && e.data.wasmUrl) {
        this.wasmUrl = e.data.wasmUrl;
        this.initWasm(this.wasmUrl).catch(() => {});
      }
    };
  }

  // ---- high-pass biquad at ~80 Hz (remove rumble / desk thumps) ----
  highpass(x) {
    // RBJ high-pass, fc=80Hz, Q=0.707 @ 48kHz
    const c = Math.cos(2 * Math.PI * 80 / sampleRate);
    const s = Math.sin(2 * Math.PI * 80 / sampleRate);
    const alpha = s / (2 * 0.707);
    const b0 = (1 + c) / 2;
    const b1 = -(1 + c);
    const b2 = (1 + c) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * c;
    const a2 = 1 - alpha;
    const y =
      (b0 * x + b1 * this.hpState[0] + b2 * this.hpState[1] -
        a1 * this.hpState[0] - a2 * this.hpState[1]) /
      a0;
    this.hpState[1] = this.hpState[0];
    this.hpState[0] = x;
    return y;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const inCh = input[0];
    const outCh = output[0];
    const strength = (parameters.strength && parameters.strength.length > 1)
      ? parameters.strength[0]
      : (parameters.strength ? parameters.strength[0] : this.strength);

    if (this.wasm) {
      this.processWasm(inCh, outCh);
    } else {
      this.processDsp(inCh, outCh, strength);
    }
    return true;
  }

  // ---- built-in DSP engine ----
  processDsp(inCh, outCh, strength) {
    const n = inCh.length;
    // One-pole smoothing constants (attack fast, release slow to avoid pumping).
    const attack = 0.4;
    const release = 0.0015;
    // How far above the noise floor speech must be to fully open the gate.
    const openMargin = 0.012 + 0.03 * (1 - strength);
    // Floor the gain can be pushed down to when only noise is present.
    const minGain = 1 - strength; // 0 at strength=1 (full suppress) .. 1 at 0

    for (let i = 0; i < n; i++) {
      let x = this.highpass(inCh[i]);
      const absx = x < 0 ? -x : x;

      // Envelope follower.
      this.env = absx > this.env ? this.env * (1 - attack) + absx * attack
                                 : this.env + release * (absx - this.env);

      // Slow minimum-tracking noise-floor estimate (drift down gently, never below floor).
      if (this.env < this.noiseFloor) {
        this.noiseFloor = this.env * 0.0002 + this.noiseFloor * 0.9998;
      } else {
        this.noiseFloor = this.noiseFloor * 0.9999 + 0.02 * 0.0001;
      }

      // Target gate gain.
      const target = this.env > this.noiseFloor + openMargin
        ? 1
        : minGain * (this.env / Math.max(this.noiseFloor + openMargin, 1e-6));

      // Smooth the gain itself to avoid musical-noise artifacts.
      const g = target > this.gain
        ? this.gain + 0.2 * (target - this.gain)
        : this.gain + 0.008 * (target - this.gain);
      this.gain = g < minGain ? minGain : g > 1 ? 1 : g;

      outCh[i] = x * this.gain;
    }
  }

  // ---- WASM model engine (buffered FRAME-size windows) ----
  processWasm(inCh, outCh) {
    const { exports, memory, inPtr, outPtr } = this.wasm;
    let i = 0;
    let written = 0;
    while (i < inCh.length) {
      const need = FRAME - this.frameFill;
      const take = Math.min(need, inCh.length - i);
      this.frameBuf.set(inCh.subarray(i, i + take), this.frameFill);
      this.frameFill += take;
      i += take;
      if (this.frameFill < FRAME) {
        // Not enough yet: zero-fill to avoid clicks. Latency stays bounded
        // because we return immediately; the next quantum completes the frame.
        for (; written < outCh.length; written++) outCh[written] = 0;
        return;
      }
      // Write input. Heap view captured fresh — never reused across frames.
      const heapIn = new Float32Array(memory.buffer);
      heapIn.set(this.frameBuf, inPtr >> 2);
      try {
        exports.denoise_frame(inPtr, outPtr);
      } catch {
        this.wasm = null; // ABI mismatch -> DSP takes over next block
        this.processDsp(inCh, outCh, this.strength);
        return;
      }
      // CRITICAL: denoise_frame may have called memory.grow, which detaches
      // the previous ArrayBuffer. Re-fetch the heap view BEFORE reading output.
      const heapOut = new Float32Array(memory.buffer);
      const out = heapOut.subarray(outPtr >> 2, (outPtr >> 2) + FRAME);
      for (let k = 0; k < FRAME && written < outCh.length; k++, written++) {
        outCh[written] = out[k];
      }
      this.frameFill = 0;
    }
  }

  async initWasm(url) {
    const resp = await fetch(url);
    const bytes = await resp.arrayBuffer();
    const result = await WebAssembly.instantiate(bytes, { env: { memory: undefined } });
    const exports = result.instance.exports;
    if (!exports.denoise_frame || !exports.memory) {
      throw new Error("wasm missing denoise_frame/memory exports");
    }
    // Ensure enough memory for two 480-f32 frames.
    const needed = FRAME * 4 * 2;
    if (exports.memory.buffer.byteLength < needed && exports.grow_memory) {
      exports.grow_memory(1);
    }
    // Allocate I/O scratch inside linear memory (start-of-heap convention).
    const inPtr = exports.malloc ? exports.malloc(FRAME * 4) : 0;
    const outPtr = exports.malloc ? exports.malloc(FRAME * 4) : FRAME * 4;
    this.wasm = { exports, memory: exports.memory, inPtr, outPtr };
    this.port.postMessage({ type: "wasm-ready" });
  }
}

registerProcessor("denoise-processor", DenoiseProcessor);
