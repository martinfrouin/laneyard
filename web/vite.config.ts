import react from "@vitejs/plugin-react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: join(here, "..", "dist", "web"), emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://localhost:7890", ws: true },
    },
  },
});
