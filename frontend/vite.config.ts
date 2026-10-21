import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  // The static website build uses relative asset paths so it works from any subpath (e.g. user.github.io/repo/).
  base: process.env.VITE_STATIC ? "./" : "/",
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.VITE_API_URL ?? "http://127.0.0.1:8000", changeOrigin: true } },
  },
  build: { rollupOptions: { output: { manualChunks: { charts: ["recharts"], vendor: ["react", "react-dom", "react-router-dom", "@tanstack/react-query", "@tanstack/react-table"] } } } },
  test: { environment: "node" },
});
