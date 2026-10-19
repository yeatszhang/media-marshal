import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
// @ts-expect-error 构建插件为跨工具共享的本地 ESM。
import { typescriptDecorators } from "./scripts/typescript-decorators.mjs";

export default defineConfig({
  plugins: [typescriptDecorators()],
  resolve: {
    alias: {
      "@media-marshal/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
      "@media-marshal/media-core": fileURLToPath(
        new URL("./packages/media-core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/desktop/src/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 15000,
  },
});
