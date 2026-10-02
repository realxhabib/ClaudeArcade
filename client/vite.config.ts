import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@xapps\/sdk\/react$/, replacement: src("sdk/react.tsx") },
      { find: /^@xapps\/sdk\/host$/, replacement: src("sdk/host.ts") },
      { find: /^@xapps\/sdk\/protocol$/, replacement: src("sdk/protocol.ts") },
      { find: /^@xapps\/sdk$/, replacement: src("sdk/index.ts") },
      { find: /^@\//, replacement: src("") },
    ],
  },
  // The arcade server serves the build and the lobby socket; in dev, proxy the socket to it.
  server: { proxy: { "/lobby": { target: "ws://127.0.0.1:8787", ws: true } } },
});
