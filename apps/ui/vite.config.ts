import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export default defineConfig({
  envDir: resolve(fileURLToPath(new URL("../..", import.meta.url))),
  plugins: [react()],
  resolve: { preserveSymlinks: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});

