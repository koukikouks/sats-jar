import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The backend answers on the app's own origin at /api, so it needs no CORS. In development and
// preview this proxy forwards to a local backend (backend/src/server.ts); hosting adds its own rewrite.
const backend = process.env.SATS_JAR_BACKEND ?? "http://localhost:8787";
const proxy = { "/api": { target: backend, rewrite: (path: string) => path.replace(/^\/api/, "") } };

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
