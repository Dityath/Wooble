import { env } from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${env.API_PORT ?? "3001"}`, ws: true },
      "/health": `http://localhost:${env.API_PORT ?? "3001"}`,
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react-vendor";
          if (id.includes("/node_modules/@tanstack/")) return "tanstack-vendor";
          if (id.includes("/node_modules/@radix-ui/")) return "radix-vendor";
          if (id.includes("/node_modules/lucide-react/")) return "icons-vendor";
        },
      },
    },
  },
});
