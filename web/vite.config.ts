import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Dev: vite on :5173, proxy /api to director-server on :47821 (or
  // wherever DIRECTOR_PORT points). Keep these in sync with the Go
  // sides (director-app/main.go and director/main.go).
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.DIRECTOR_PORT || 47821}`,
    },
  },
});
