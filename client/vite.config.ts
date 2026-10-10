import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Catalyst Web Client Hosting serves the app under /app/. In dev, API calls are proxied to the
// Development environment, where the browser's Catalyst sign-in cookie applies.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    proxy: { "/server": { target: process.env.FOS_DEV_ORIGIN ?? "https://franchiseos-60082871087.development.catalystserverless.in", changeOrigin: true } },
  },
});
