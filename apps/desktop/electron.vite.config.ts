import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
// @ts-expect-error 构建插件为跨工具共享的本地 ESM。
import { typescriptDecorators } from "../../scripts/typescript-decorators.mjs";

const alias = {
  "@media-marshal/contracts": resolve(
    "..",
    "..",
    "packages/contracts/src/index.ts",
  ),
  "@media-marshal/media-core": resolve(
    "..",
    "..",
    "packages/media-core/src/index.ts",
  ),
};
export default defineConfig({
  main: {
    plugins: [typescriptDecorators()],
    resolve: { alias },
    build: {
      externalizeDeps: {
        exclude: ["@media-marshal/contracts", "@media-marshal/media-core"],
        include: ["better-sqlite3"],
      },
      rolldownOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          worker: resolve("src/worker/index.ts"),
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: { externalizeDeps: false, isolatedEntries: true },
  },
  renderer: {
    resolve: { alias },
    plugins: [
      typescriptDecorators(),
      react(),
      tailwind(),
      {
        name: "development-csp",
        transformIndexHtml(html, context) {
          if (!context.server) return html;
          return html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace(
              "connect-src 'self'",
              "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
            );
        },
      },
    ],
  },
});
