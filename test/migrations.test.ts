import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, type Db } from "../src/db.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/orders_test";

describe("order payment migration", () => {
  let admin: Db;
  let freshDb: Db;
  let existingDb: Db;
  let freshSchema: string;
  let existingSchema: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    freshSchema = `migration_fresh_${randomUUID().replace(/-/g, "")}`;
    existingSchema = `migration_existing_${randomUUID().replace(/-/g, "")}`;
    await admin.query(`CREATE SCHEMA "${freshSchema}"`);
    await admin.query(`CREATE SCHEMA "${existingSchema}"`);
    freshDb = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${freshSchema}` });
    existingDb = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${existingSchema}` });
  });

  afterAll(async () => {
    await freshDb?.end();
    await existingDb?.end();
    if (admin) {
      if (freshSchema) await admin.query(`DROP SCHEMA "${freshSchema}" CASCADE`);
      if (existingSchema) await admin.query(`DROP SCHEMA "${existingSchema}" CASCADE`);
      await admin.end();
    }
  });

  it("applies all migrations on a fresh schema and is idempotent", async () => {
    const applied = await migrate(freshDb);
    expect(applied).toEqual(["001_init.sql", "002_order_payment_amounts.sql"]);
    expect(await migrate(freshDb)).toEqual([]);

    const { rows } = await freshDb.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'orders'`,
      [freshSchema],
    );
    expect(rows.map((row) => row.column_name)).toContain("amount_paid_kop");
    expect(rows.map((row) => row.column_name)).toContain("discount_percent");
  });

  it("backfills existing orders when applying the new migration", async () => {
    await existingDb.query(
      `CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const initialMigration = await readFile(join(MIGRATIONS_DIR, "001_init.sql"), "utf8");
    await existingDb.query(initialMigration);
    await existingDb.query(`INSERT INTO schema_migrations (name) VALUES ('001_init.sql')`);
    await existingDb.query(
      `INSERT INTO orders (id, customer_id, amount_kop, status, created_at, updated_at)
       VALUES ('legacy-order', 'c_legacy', 12345, 'paid', now(), now())`,
    );

    expect(await migrate(existingDb)).toEqual(["002_order_payment_amounts.sql"]);
    const { rows } = await existingDb.query(
      `SELECT amount_paid_kop, discount_percent FROM orders WHERE id = 'legacy-order'`,
    );
    expect(Number(rows[0].amount_paid_kop)).toBe(12345);
    expect(rows[0].discount_percent).toBe("0");
  });
});
