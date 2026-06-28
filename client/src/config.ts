// Runtime configuration. In production override via a packaged .env or by
// editing this default to your deployed backend URL.
export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8080";

// Files under client/public/ are served at the app root in both dev and prod.
// Use BASE_URL (always "/", or whatever you set as `base` in vite.config) so
// the path resolves correctly regardless of where this module lives.
const PUB = import.meta.env.BASE_URL;

// Where the AudioWorklet processor is served from.
export const WORKLET_URL = `${PUB}worklets/denoise-processor.js`;

// WASM model URLs (drop the files into client/public/wasm to enable AI mode).
export const WASM_MODELS: Record<string, string> = {
  rnnoise: `${PUB}wasm/rnnoise.wasm`,
  dtln: `${PUB}wasm/dtln.wasm`,
  deepfilter: `${PUB}wasm/deepfilter.wasm`,
};
