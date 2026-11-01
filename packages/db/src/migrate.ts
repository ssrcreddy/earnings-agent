import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./client";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = createPool(connectionString, 1);
  try {
    // Extensions first: drizzle-kit does not generate CREATE EXTENSION.
    await pool.query("create extension if not exists vector");
    await pool.query("create extension if not exists pgcrypto");
    await migrate(createDb(pool), { migrationsFolder: path.resolve(here, "../migrations") });
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  runMigrations(url)
    .then(() => console.log("migrations applied"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
