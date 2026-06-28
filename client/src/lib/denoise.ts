// MicPipeline owns the local-microphone capture + denoise graph and produces
// the MediaStreamTrack that gets published to LiveKit.
//
// Modes:
//   off    -> raw mic, no browser DSP, no worklet
//   basic  -> browser noiseSuppression + (optional) AEC/AGC, no worklet
//   smart  -> browser AEC only; noise removed in an AudioWorklet
//             (built-in spectral noise-gate, upgradeable to a WASM model:
//              RNNoise / DTLN / DeepFilterNet compiled from Rust)
//
// Design note: real-time audio must stay inside the webview's audio thread, so
// the live path lives in the AudioWorklet. The Rust layer (src-tauri) owns the
// settings, selects the active WASM model, and can batch-process recordings
// offline — see its denoise module.

import { WORKLET_URL, WASM_MODELS } from "../config";
import type { DenoiseSettings } from "../types";

export class MicPipeline {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private rawStream: MediaStream | null = null;
  private _workletFallback = false;
  settings: DenoiseSettings;

  constructor(settings: DenoiseSettings) {
    this.settings = { ...settings };
  }

  /** True when smart mode was requested but the worklet failed to load. */
  get workletFallback(): boolean {
    return this._workletFallback;
  }

  /** Capture and (in smart mode) process the mic, returning the track to publish. */
  async getMicTrack(): Promise<MediaStreamTrack> {
    this.stop();

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Microphone access unavailable. " +
          "Ensure the app runs in a secure context (localhost / HTTPS). " +
          "In a Tauri macOS build, the app also needs the " +
          "com.apple.security.device.audio-input entitlement and " +
          "NSMicrophoneUsageDescription in Info.plist.",
      );
    }

    this.rawStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: this.audioConstraintsFor(this.settings),
    });

    if (this.settings.mode !== "smart") {
      return this.rawTrack();
    }

    // Smart mode: route through the denoise worklet.
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    this.ctx = ctx;
    // Browsers may leave AudioContext suspended without an explicit user gesture.
    // join() is always called from a button click, so resume() is safe here.
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (err) {
      // Worklet unavailable (file missing, packaging issue, CSP block): keep
      // the call alive but bypass processing. The flag lets the UI surface
      // this so users don't think Smart mode is actually AI-denoising.
      console.warn("denoise worklet load failed, using passthrough", err);
      this._workletFallback = true;
      return this.rawTrack();
    }

    this.source = ctx.createMediaStreamSource(this.rawStream);
    this.dest = ctx.createMediaStreamDestination();

    this.worklet = new AudioWorkletNode(ctx, "denoise-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      processorOptions: {
        model: this.settings.model,
        strength: this.settings.strength,
        wasmUrl: this.settings.model ? WASM_MODELS[this.settings.model] : null,
      },
    });

    this.setStrength(this.settings.strength);
    this.source.connect(this.worklet);
    this.worklet.connect(this.dest);
    // NOTE: deliberately NOT connected to ctx.destination -> no local echo.

    const track = this.dest.stream.getAudioTracks()[0];
    if (!track) {
      return this.rawTrack();
    }
    return track;
  }

  /** Live-adjust the denoise strength without republishing. */
  setStrength(v: number): void {
    this.settings.strength = Math.max(0, Math.min(1, v));
    const param = this.worklet?.parameters.get("strength");
    if (param) param.value = this.settings.strength;
  }

  /** Switch the active WASM model (requires a republish via rebuild). */
  setModel(model: string | null): void {
    this.settings.model = model;
  }

  private audioConstraintsFor(s: DenoiseSettings): MediaTrackConstraints {
    switch (s.mode) {
      case "off":
        return {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        };
      case "basic":
        return {
          echoCancellation: s.echoCancellation,
          noiseSuppression: true,
          autoGainControl: s.agc,
          channelCount: 1,
        };
      case "smart":
        // Browser AEC is great at echo; let the worklet own noise removal.
        return {
          echoCancellation: s.echoCancellation,
          noiseSuppression: false,
          autoGainControl: s.agc,
          channelCount: 1,
          sampleRate: 48000,
        };
    }
  }

  private rawTrack(): MediaStreamTrack {
    const t = this.rawStream?.getAudioTracks()[0];
    if (!t) throw new Error("microphone track unavailable");
    return t;
  }

  /** Release everything; called before rebuilding or on leave. */
  stop(): void {
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.dest?.disconnect();
    this.worklet = null;
    this.source = null;
    this.dest = null;
    this._workletFallback = false;
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.rawStream?.getTracks().forEach((t) => t.stop());
    this.rawStream = null;
  }
}
