import { defineConfig } from "vite";

export default defineConfig({
  resolve: { conditions: ["@benchtop-plc/source", "module", "browser", "development|production"] },
  build: { emptyOutDir: false },
});
