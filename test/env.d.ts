/// <reference types="@cloudflare/vitest-pool-workers/types" />

// test-only binding provided via vitest.config.ts
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
