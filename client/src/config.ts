// Runtime configuration. In production override via a packaged .env or by
// editing this default to your deployed backend URL.
export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8080";

// Where AudioWorklet + (optional) WASM model files are served from.
export const WORKLET_URL = new URL("./worklets/denoise-processor.js", import.meta.url).href;

// WASM model URLs (drop the files into client/public/wasm to enable AI mode).
export const WASM_MODELS: Record<string, string> = {
  rnnoise: new URL("./wasm/rnnoise.wasm", import.meta.url).href,
  dtln: new URL("./wasm/dtln.wasm", import.meta.url).href,
  deepfilter: new URL("./wasm/deepfilter.wasm", import.meta.url).href,
};
