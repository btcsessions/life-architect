import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:4600" } },
  test: { root: ".", include: ["server/**/*.test.ts"], env: { VITEST: "1" } },
} as any);
