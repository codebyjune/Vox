import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri spawns the dev server on a fixed port and injects it into the webview.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Bind on localhost (NOT 127.0.0.1) so Tauri v2's WebView (origin
    // http://tauri.localhost) treats the page as a secure context. With
    // 127.0.0.1, WKWebView marks it as non-secure and `navigator.mediaDevices`
    // becomes undefined — getUserMedia() throws.
    host: "localhost",
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
