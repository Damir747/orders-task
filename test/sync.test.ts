import { describe, expect, it } from "vitest";
import { apiOrder, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("POST /sync", () => {
  it("проходит все страницы и останавливается на пустой странице с тем же курсором", async () => {
    const [a, b, c] = [apiOrder(), apiOrder(), apiOrder()];
    ctx.api.pages.set(null, { items: [a, b], nextCursor: "p2" });
    ctx.api.pages.set("p2", { items: [c], nextCursor: "p3" });
    ctx.api.pages.set("p3", { items: [], nextCursor: "p3" });

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pages: 3, received: 3, applied: 3, invalid: 0 });
    const { rows } = await ctx.db.query(`SELECT count(*)::int AS n FROM orders`);
    expect(rows[0].n).toBe(3);
  });

  it("завершает пагинацию по nextCursor null", async () => {
    ctx.api.pages.set(null, { items: [apiOrder()], nextCursor: null });

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pages: 1, received: 1, applied: 1 });
    expect(ctx.api.calls).toBe(1);
  });

  it("продолжает после пустой страницы с новым курсором", async () => {
    const order = apiOrder();
    ctx.api.pages.set(null, { items: [], nextCursor: "p2" });
    ctx.api.pages.set("p2", { items: [order], nextCursor: null });

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pages: 2, received: 1, applied: 1 });
    expect(ctx.api.calls).toBe(2);
    const { rows } = await ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE id = $1`, [order.id]);
    expect(rows[0].n).toBe(1);
  });

  it("ошибкой завершает синхронизацию при повторном курсоре на непустой странице", async () => {
    const order = apiOrder();
    ctx.api.pages.set(null, { items: [], nextCursor: "p2" });
    ctx.api.pages.set("p2", { items: [order], nextCursor: "p2" });

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "upstream_error" });
    const { rows } = await ctx.db.query(`SELECT error FROM sync_runs ORDER BY id DESC LIMIT 1`);
    expect(rows[0].error).toContain("repeated cursor");
  });

  it("ошибкой завершает синхронизацию при цикле из нескольких курсоров", async () => {
    ctx.api.pages.set(null, { items: [], nextCursor: "p2" });
    ctx.api.pages.set("p2", { items: [], nextCursor: "p3" });
    ctx.api.pages.set("p3", { items: [apiOrder()], nextCursor: "p2" });

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "upstream_error" });
    const { rows } = await ctx.db.query(`SELECT error FROM sync_runs ORDER BY id DESC LIMIT 1`);
    expect(rows[0].error).toContain("repeated cursor");
  });

  it("ошибкой завершает синхронизацию при достижении предела страниц", async () => {
    const maxPages = 1_000;
    for (let page = 0; page < maxPages; page++) {
      ctx.api.pages.set(page === 0 ? null : `p${page}`, { items: [], nextCursor: `p${page + 1}` });
    }

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "upstream_error" });
    expect(ctx.api.calls).toBe(maxPages);
    const { rows } = await ctx.db.query(`SELECT pages, error FROM sync_runs ORDER BY id DESC LIMIT 1`);
    expect(rows[0].pages).toBe(maxPages);
    expect(rows[0].error).toContain("page limit");
  });

  it("невалидные заказы пропускает, а не падает", async () => {
    ctx.api.pages.set(null, { items: [apiOrder(), { id: "broken" }, apiOrder({ amount: "abc" })], nextCursor: null });
    const res = await ctx.app.inject({ method: "POST", url: "/sync" });
    expect(res.json()).toMatchObject({ received: 3, applied: 1, invalid: 2 });
  });

  it("не откатывает более свежую версию заказа", async () => {
    const fresh = apiOrder({ status: "refunded", updatedAt: "2026-02-12T00:00:00Z" });
    await ctx.app.inject({ method: "POST", url: "/webhooks/order", payload: fresh });
    ctx.api.pages.set(null, { items: [{ ...fresh, status: "paid", updatedAt: "2026-02-10T12:00:00Z" }], nextCursor: null });

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });
    expect(res.json()).toMatchObject({ stale: 1 });
    const { rows } = await ctx.db.query(`SELECT status FROM orders WHERE id = $1`, [fresh.id]);
    expect(rows[0].status).toBe("refunded");
  });

  it("строковые суммы и даты без зоны", async () => {
    const o = apiOrder({
      amount: "2500.00",
      discountPercent: "7",
      amountPaid: "2325.00",
      createdAt: "2026-02-10T21:30:00",
    });
    ctx.api.pages.set(null, { items: [o], nextCursor: null });
    await ctx.app.inject({ method: "POST", url: "/sync" });
    const { rows } = await ctx.db.query(
      `SELECT amount_kop, amount_paid_kop, discount_percent, created_at FROM orders WHERE id = $1`,
      [o.id],
    );
    expect(Number(rows[0].amount_kop)).toBe(250000);
    expect(Number(rows[0].amount_paid_kop)).toBe(232500);
    expect(rows[0].discount_percent).toBe("7");
    expect(rows[0].created_at.toISOString()).toBe("2026-02-10T21:30:00.000Z");
  });

  it("сохраняет точные копейки из исходных number и string значений", async () => {
    const o = apiOrder({ amount: 1.15, amountPaid: "0.29" });
    ctx.api.pages.set(null, { items: [o], nextCursor: null });

    const res = await ctx.app.inject({ method: "POST", url: "/sync" });
    expect(res.json()).toMatchObject({ received: 1, applied: 1, invalid: 0 });

    const { rows } = await ctx.db.query(
      `SELECT amount_kop, amount_paid_kop FROM orders WHERE id = $1`,
      [o.id],
    );
    expect(Number(rows[0].amount_kop)).toBe(115);
    expect(Number(rows[0].amount_paid_kop)).toBe(29);
  });
});
