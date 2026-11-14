import { describe, expect, it } from "vitest";
import { apiOrder, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

async function waitForAdvisoryWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await ctx.db.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state = 'active'
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'
         AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'`,
    );
    if (rows[0].count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${expected} PostgreSQL advisory lock waiters`);
}

async function runWithOrderLock<T>(
  orderId: string,
  expectedWaiters: number,
  startRequests: () => Promise<T>,
): Promise<T> {
  const client = await ctx.db.connect();
  let transactionStarted = false;
  let releaseError: Error | undefined;
  let pending: Promise<T> | undefined;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [orderId]);

    pending = startRequests();
    void pending.catch(() => undefined);
    await waitForAdvisoryWaiters(expectedWaiters);

    await client.query("COMMIT");
    transactionStarted = false;
    return await pending;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
        transactionStarted = false;
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        throw new AggregateError([error, rollbackError], "Test advisory lock rollback failed");
      }
    }
    if (pending) await pending.catch(() => undefined);
    throw error;
  } finally {
    client.release(releaseError);
  }
}

describe("concurrent order versions", () => {
  it("keeps the newest of two concurrent webhooks for an existing order", async () => {
    const id = "concurrent-webhook";
    const baseline = apiOrder({ id, updatedAt: "2026-02-10T00:00:00Z", status: "pending" });
    await postWebhook(ctx.app, baseline);

    const older = apiOrder({ ...baseline, updatedAt: "2026-02-11T00:00:00Z", status: "pending" });
    const newer = apiOrder({ ...baseline, updatedAt: "2026-02-12T00:00:00Z", status: "refunded" });
    const responses = await runWithOrderLock(id, 2, () =>
      Promise.all([postWebhook(ctx.app, older), postWebhook(ctx.app, newer)]),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const { rows } = await ctx.db.query(
      `SELECT count(*)::int AS count, max(updated_at) AS updated_at, max(status) AS status
       FROM orders WHERE id = $1`,
      [id],
    );
    expect(rows[0].count).toBe(1);
    expect(rows[0].updated_at.toISOString()).toBe("2026-02-12T00:00:00.000Z");
    expect(rows[0].status).toBe("refunded");
  });

  it("serializes concurrent first inserts for the same order id", async () => {
    const id = "concurrent-first-insert";
    const older = apiOrder({ id, updatedAt: "2026-02-11T00:00:00Z", status: "pending" });
    const newer = apiOrder({ id, updatedAt: "2026-02-12T00:00:00Z", status: "paid" });
    const responses = await runWithOrderLock(id, 2, () =>
      Promise.all([postWebhook(ctx.app, older), postWebhook(ctx.app, newer)]),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses.map((response) => response.json().result)).toContain("created");
    const { rows } = await ctx.db.query(
      `SELECT count(*)::int AS count, max(updated_at) AS updated_at, max(status) AS status
       FROM orders WHERE id = $1`,
      [id],
    );
    expect(rows[0].count).toBe(1);
    expect(rows[0].updated_at.toISOString()).toBe("2026-02-12T00:00:00.000Z");
    expect(rows[0].status).toBe("paid");
  });

  it("serializes a sync update and webhook for the same order", async () => {
    const id = "concurrent-sync-webhook";
    const baseline = apiOrder({ id, updatedAt: "2026-02-10T00:00:00Z", status: "pending" });
    await postWebhook(ctx.app, baseline);

    const syncOrder = apiOrder({ ...baseline, updatedAt: "2026-02-11T00:00:00Z", status: "pending" });
    const webhookOrder = apiOrder({ ...baseline, updatedAt: "2026-02-12T00:00:00Z", status: "paid" });
    ctx.api.pages.set(null, { items: [syncOrder], nextCursor: null });

    const [syncResponse, webhookResponse] = await runWithOrderLock(id, 2, () =>
      Promise.all([
        ctx.app.inject({ method: "POST", url: "/sync" }),
        postWebhook(ctx.app, webhookOrder),
      ]),
    );

    expect(syncResponse.statusCode).toBe(200);
    expect(webhookResponse.statusCode).toBe(200);
    expect(syncResponse.json().applied + syncResponse.json().stale).toBe(1);
    const { rows } = await ctx.db.query(
      `SELECT updated_at, status FROM orders WHERE id = $1`,
      [id],
    );
    expect(rows[0].updated_at.toISOString()).toBe("2026-02-12T00:00:00.000Z");
    expect(rows[0].status).toBe("paid");
  });
});
