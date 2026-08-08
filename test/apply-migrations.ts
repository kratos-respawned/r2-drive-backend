import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.db_r2_drive, env.TEST_MIGRATIONS);
