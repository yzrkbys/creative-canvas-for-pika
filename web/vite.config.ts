import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER = process.env.PIKA_CANVAS_SERVER_URL ?? "http://localhost:8797";

export default defineConfig({
  plugins: [react()],
  // Emit built JS/CSS under /static so they don't collide with the server's
  // /assets route (which serves generated images/videos).
  build: { assetsDir: "static" },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: SERVER, changeOrigin: true },
      "/assets": { target: SERVER, changeOrigin: true },
      "/ws": { target: SERVER, ws: true, changeOrigin: true },
    },
  },
});
