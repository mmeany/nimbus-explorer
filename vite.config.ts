import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Settings tailored for Tauri: fixed port, no screen clearing, ignore Rust sources.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
  },
});
