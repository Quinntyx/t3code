import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    outDir: "dist",
    deps: { alwaysBundle: [/^@t3tools\//, /^effect\//] },
  },
});
