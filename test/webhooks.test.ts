import { describe, expect, it } from "vitest";
import { apiOrder, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("POST /webhooks/order", () => {
  it("создаёт заказ", async () => {
    const o = apiOrder({ amount: 1000, discountPercent: 10, amountPaid: 900 });
    const res = await postWebhook(ctx.app, o);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "created" });
    const { rows } = await ctx.db.query(
      `SELECT amount_kop, amount_paid_kop, discount_percent FROM orders WHERE id = $1`,
      [o.id],
    );
    expect(Number(rows[0].amount_kop)).toBe(100000);
    expect(Number(rows[0].amount_paid_kop)).toBe(90000);
    expect(rows[0].discount_percent).toBe("10");
  });

  it("повтор того же события ничего не меняет", async () => {
    const o = apiOrder();
    await postWebhook(ctx.app, o);
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
  });

  it("равный updatedAt с отличающимися данными считается stale", async () => {
    const original = apiOrder({ amount: 1000, status: "pending" });
    await postWebhook(ctx.app, original);

    const res = await postWebhook(ctx.app, {
      ...original,
      amount: 2000,
      amountPaid: 1800,
      status: "paid",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT amount_kop, status FROM orders WHERE id = $1`, [original.id]);
    expect(Number(rows[0].amount_kop)).toBe(100000);
    expect(rows[0].status).toBe("pending");
  });

  it("устаревшее событие после нового игнорируется", async () => {
    const o = apiOrder({ status: "paid", updatedAt: "2026-02-10T12:00:00Z" });
    await postWebhook(ctx.app, { ...o, status: "refunded", updatedAt: "2026-02-11T12:00:00Z" });
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT status FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0].status).toBe("refunded");
  });

  it("новое событие обновляет заказ", async () => {
    const o = apiOrder({ status: "pending" });
    await postWebhook(ctx.app, o);
    const res = await postWebhook(ctx.app, { ...o, status: "paid", updatedAt: "2026-02-11T00:00:00Z" });
    expect(res.json()).toEqual({ result: "updated" });
  });

  it("невалидное тело — 400", async () => {
    const res = await postWebhook(ctx.app, { id: "x" });
    expect(res.statusCode).toBe(400);
  });

  it("некорректный JSON — 400 с безопасным форматом ошибки", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/order",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_request", message: "Malformed JSON" });
  });

  it("превышение лимита тела — 413", async () => {
    const payload = JSON.stringify({ data: "x".repeat(1024 * 1024) });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/order",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: "payload_too_large",
      message: "Request body too large",
    });
  });

  it("неподдерживаемый Content-Type — 415", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/order",
      headers: { "content-type": "application/xml" },
      payload: "<order />",
    });

    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({
      error: "unsupported_media_type",
      message: "Unsupported Content-Type",
    });
  });

  it("неизвестный маршрут — 404 в общем формате", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/missing-route" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found", message: "Route not found" });
  });

  it("неожиданная ошибка — безопасный 500 без произвольного statusCode", async () => {
    const sync = ctx.container.sync;
    const originalRun = sync.run;
    sync.run = async () => {
      throw Object.assign(new Error("internal database detail"), { statusCode: 418 });
    };

    try {
      const res = await ctx.app.inject({ method: "POST", url: "/sync" });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "internal", message: "Internal error" });
    } finally {
      sync.run = originalRun;
    }
  });
});
