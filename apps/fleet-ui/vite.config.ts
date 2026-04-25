import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The UI is served under /ui/ in production (fastify @fastify/static mounts the
// built dist at that prefix). In dev, Vite serves at the root of :5173 and
// proxies /pipelines, /remotecfg, /health to the manager on :9090. The
// `base: "/ui/"` ensures built asset URLs (index-*.js, etc.) resolve correctly
// when served from /ui/.
export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/pipelines": "http://localhost:9090",
      "/remotecfg": "http://localhost:9090",
      "/health": "http://localhost:9090",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
