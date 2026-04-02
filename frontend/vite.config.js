import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/upload": "http://localhost:4000",
      "/pdf": "http://localhost:4000",
      "/page": "http://localhost:4000",
      "/document": "http://localhost:4000",
      "/health": "http://localhost:4000",
      "/sample": "http://localhost:4000"
    }
  }
});
