import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// drizzle v1 migration layout: drizzle/migrations/<name>/migration.sql
const readDrizzleMigrations = async (migrationsDir: string) => {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    folders.map(async (name) => ({
      name,
      queries: (await readFile(join(migrationsDir, name, "migration.sql"), "utf8"))
        .split("--> statement-breakpoint")
        .map((query) => query.trim())
        .filter(Boolean),
    })),
  );
};

export default defineConfig(async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const migrations = await readDrizzleMigrations(join(root, "drizzle", "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // fake values: presigning is offline crypto and all outbound
            // requests (R2 S3 API, resend) are stubbed with fetchMock
            BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
            BETTER_AUTH_URL: "http://localhost:8787",
            // deliberately different from BETTER_AUTH_URL: native clients send the
            // API's own origin, which must stay trusted independently of ORIGIN_URL
            ORIGIN_URL: "http://localhost:5173",
            ACCOUNT_ID: "test-account",
            BUCKET_NAME: "test-bucket",
            R2_ACCESS_ID_KEY: "test-access-key-id",
            R2_SECRET: "test-secret-access-key",
            RESEND_SECRET: "re_test_key",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            // svix (via better-auth) ships CJS files containing ESM syntax;
            // pre-bundling converts it into something workerd can load
            include: ["svix"],
          },
        },
      },
    },
  };
});
