// Shared client types.

/** Denoise strategy applied to the local microphone before it is published. */
export type DenoiseMode = "off" | "basic" | "smart";

/** Strength of the smart-mode denoiser (0..1, mapped inside the worklet). */
export type DenoiseStrength = number;

export interface JoinResponse {
  token: string;
  livekitHost: string;
  iceServers?: IceServer[];
  room: string;
  identity: string;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface DenoiseSettings {
  mode: DenoiseMode;
  strength: number; // 0..1, smart-mode intensity
  agc: boolean; // browser auto-gain (basic/smart)
  echoCancellation: boolean; // browser AEC (off/basic/smart)
  model: string | null; // selected WASM model id, e.g. "rnnoise" | "dtln" | null
}

export const DEFAULT_SETTINGS: DenoiseSettings = {
  mode: "smart",
  strength: 0.85,
  agc: true,
  echoCancellation: true,
  model: null,
};
