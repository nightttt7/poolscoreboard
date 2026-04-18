import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Note: `singleWorker: true` keeps the per-Durable-Object storage path short
// enough to satisfy Windows MAX_PATH; without it Miniflare's DO sqlite store
// fails with SQLITE_CANTOPEN on Windows.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        miniflare: {
          bindings: {
            ADMIN_PASSWORD: "test-admin-password",
          },
        },
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
      },
    },
  },
});