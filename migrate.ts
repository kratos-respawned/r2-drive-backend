import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DATABASE_NAME = "r2-drive";
const MIGRATIONS_DIR = "./drizzle/migrations";
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

function getEnvironmentFlag(): string {
  const args = process.argv.slice(2);
  const env = args[0];

  if (!env || !["local", "cloud"].includes(env)) {
    console.error("Usage: bun run migrate.ts <local|cloud>");
    console.error("  local - Run migrations against local D1 database");
    console.error("  cloud - Run migrations against production D1 database");
    process.exit(1);
  }

  return env === "local" ? "--local" : "--remote";
}

function execWrangler(command: string, flag: string): string {
  try {
    const result = execSync(`bunx wrangler ${command} ${flag}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result;
  } catch (error: any) {
    if (error.stderr) {
      // Check if it's a "table doesn't exist" error which is expected on first run
      if (error.stderr.includes("no such table")) {
        return "";
      }
    }
    throw error;
  }
}

function ensureMigrationsTable(flag: string): void {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `;

  console.log("Ensuring _migrations table exists...");
  execSync(
    `bunx wrangler d1 execute ${DATABASE_NAME} ${flag} --command="${createTableSQL.replace(/\n/g, " ")}"`,
    { stdio: "inherit" }
  );
}

function getAppliedMigrations(flag: string): Set<string> {
  try {
    const result = execWrangler(
      `d1 execute ${DATABASE_NAME} --command="SELECT tag FROM _migrations ORDER BY id"`,
      flag
    );

    const applied = new Set<string>();

    // Parse the JSON output from wrangler
    const lines = result.split("\n");
    for (const line of lines) {
      // Look for migration tags in the output
      const match = line.match(/"tag":\s*"([^"]+)"/);
      if (match) {
        applied.add(match[1]);
      }
      // Also handle array format output
      if (line.includes('"results"')) {
        try {
          const jsonStart = result.indexOf("{");
          const jsonEnd = result.lastIndexOf("}");
          if (jsonStart !== -1 && jsonEnd !== -1) {
            const json = JSON.parse(result.slice(jsonStart, jsonEnd + 1));
            if (json.results) {
              for (const row of json.results) {
                if (row.tag) applied.add(row.tag);
              }
            }
          }
        } catch {
          // Continue with line-by-line parsing
        }
      }
    }

    // Also try to parse as raw JSON array output
    try {
      const jsonMatch = result.match(/\[\s*\{[^]*\}\s*\]/);
      if (jsonMatch) {
        const rows = JSON.parse(jsonMatch[0]);
        for (const row of rows) {
          if (row.tag) applied.add(row.tag);
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    return applied;
  } catch (error) {
    // Table might not exist yet
    return new Set<string>();
  }
}

function getJournalEntries(): JournalEntry[] {
  if (!existsSync(JOURNAL_PATH)) {
    console.error(`Journal file not found at ${JOURNAL_PATH}`);
    console.error("Run 'bun run db:generate' first to generate migrations.");
    process.exit(1);
  }

  const journal: Journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));
  return journal.entries.sort((a, b) => a.idx - b.idx);
}

function runMigration(entry: JournalEntry, flag: string): void {
  const migrationFile = join(MIGRATIONS_DIR, `${entry.tag}.sql`);

  if (!existsSync(migrationFile)) {
    console.error(`Migration file not found: ${migrationFile}`);
    process.exit(1);
  }

  console.log(`\nRunning migration: ${entry.tag}`);

  // Execute the migration SQL file
  execSync(
    `bunx wrangler d1 execute ${DATABASE_NAME} ${flag} --file="${migrationFile}"`,
    { stdio: "inherit" }
  );

  // Record the migration as applied
  const recordSQL = `INSERT INTO _migrations (tag) VALUES ('${entry.tag}');`;
  execSync(
    `bunx wrangler d1 execute ${DATABASE_NAME} ${flag} --command="${recordSQL}"`,
    { stdio: "inherit" }
  );

  console.log(`✓ Migration ${entry.tag} applied successfully`);
}

async function main() {
  const flag = getEnvironmentFlag();
  const environment = flag === "--local" ? "LOCAL" : "CLOUD";

  console.log(`\n🚀 Running D1 migrations (${environment})\n`);
  console.log("=".repeat(50));

  // Ensure migrations tracking table exists
  ensureMigrationsTable(flag);

  // Get all migrations from journal
  const allMigrations = getJournalEntries();
  console.log(`Found ${allMigrations.length} migration(s) in journal`);

  // Get already applied migrations
  const appliedMigrations = getAppliedMigrations(flag);
  console.log(`${appliedMigrations.size} migration(s) already applied`);

  // Find pending migrations
  const pendingMigrations = allMigrations.filter(
    (entry) => !appliedMigrations.has(entry.tag)
  );

  if (pendingMigrations.length === 0) {
    console.log("\n✓ Database is up to date. No migrations to run.");
    return;
  }

  console.log(`\n${pendingMigrations.length} pending migration(s) to apply:`);
  for (const migration of pendingMigrations) {
    console.log(`  - ${migration.tag}`);
  }

  console.log("\n" + "=".repeat(50));

  // Run each pending migration in order
  for (const migration of pendingMigrations) {
    runMigration(migration, flag);
  }

  console.log("\n" + "=".repeat(50));
  console.log(`\n✓ All migrations completed successfully!`);
}

main().catch((error) => {
  console.error("\n❌ Migration failed:", error.message);
  process.exit(1);
});
