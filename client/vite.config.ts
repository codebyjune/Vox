import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri spawns the dev server on a fixed port and injects it into the webview.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri v2 on macOS/Linux needs 127.0.0.1 to reach the dev server. If you
    // ever expose the dev server to another device on the LAN, switch to
    // "0.0.0.0" so the WebView can resolve it.
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
