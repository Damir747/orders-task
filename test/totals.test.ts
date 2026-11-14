import { describe, expect, it, vi } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("GET /customers/:id/daily-totals", () => {
  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { date: "2026-02-09", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-02-10", total: 1000, gross: 1000, discount: 0, net: 1000 },
      { date: "2026-02-11", total: 349, gross: 349, discount: 0, net: 349 },
    ]);
  });

  it("uses authoritative paid amounts and aggregates gross, discount, and net", async () => {
    await postWebhook(
      ctx.app,
      apiOrder({ amount: 2500, discountPercent: 16.5, amountPaid: 2087.5 }),
    );
    await postWebhook(
      ctx.app,
      apiOrder({ amount: 1000, discountPercent: "20", amountPaid: 750 }),
    );
    await postWebhook(
      ctx.app,
      apiOrder({ amount: 500, discountPercent: 0, amountPaid: 499 }),
    );

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([
      { date: "2026-02-10", total: 4000, gross: 4000, discount: 663.5, net: 3336.5 },
    ]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500, amountPaid: 400 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, amountPaid: 650, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, amountPaid: 800, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([
      { date: "2026-02-10", total: 500, gross: 500, discount: 100, net: 400 },
    ]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([
      { date: "2026-02-10", total: 800, gross: 800, discount: 0, net: 800 },
    ]);
  });

  it("группирует Berlin по календарным дням до и после перехода на летнее время", async () => {
    ctx.api.customers.set("c_berlin", "Europe/Berlin");
    await postWebhook(
      ctx.app,
      apiOrder({ customerId: "c_berlin", amount: 100, createdAt: "2026-03-28T22:30:00Z" }),
    );
    await postWebhook(
      ctx.app,
      apiOrder({ customerId: "c_berlin", amount: 200, createdAt: "2026-03-29T22:30:00Z" }),
    );

    const res = await dailyTotals(ctx.app, "c_berlin", "2026-03-28", "2026-03-30");
    expect(res.json()).toEqual([
      { date: "2026-03-28", total: 100, gross: 100, discount: 0, net: 100 },
      { date: "2026-03-29", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-03-30", total: 200, gross: 200, discount: 0, net: 200 },
    ]);
  });

  it("относит заказ около UTC-полуночи к следующему дню Berlin", async () => {
    ctx.api.customers.set("c_berlin", "Europe/Berlin");
    await postWebhook(
      ctx.app,
      apiOrder({ customerId: "c_berlin", amount: 300, createdAt: "2026-02-10T23:30:00Z" }),
    );

    const res = await dailyTotals(ctx.app, "c_berlin", "2026-02-10", "2026-02-11");
    expect(res.json()).toEqual([
      { date: "2026-02-10", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-02-11", total: 300, gross: 300, discount: 0, net: 300 },
    ]);
  });

  it("включает локальные даты from и to и исключает соседние даты", async () => {
    ctx.api.customers.set("c_berlin", "Europe/Berlin");
    await postWebhook(
      ctx.app,
      apiOrder({ customerId: "c_berlin", amount: 50, createdAt: "2026-03-26T22:59:59Z" }),
    );
    await postWebhook(
      ctx.app,
      apiOrder({ customerId: "c_berlin", amount: 100, createdAt: "2026-03-26T23:00:00Z" }),
    );
    await postWebhook(
      ctx.app,
      apiOrder({ customerId: "c_berlin", amount: 200, createdAt: "2026-03-31T21:59:59Z" }),
    );
    await postWebhook(
      ctx.app,
      apiOrder({ customerId: "c_berlin", amount: 400, createdAt: "2026-03-31T22:00:00Z" }),
    );

    const res = await dailyTotals(ctx.app, "c_berlin", "2026-03-27", "2026-03-31");
    expect(res.json()).toEqual([
      { date: "2026-03-27", total: 100, gross: 100, discount: 0, net: 100 },
      { date: "2026-03-28", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-03-29", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-03-30", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-03-31", total: 200, gross: 200, discount: 0, net: 200 },
    ]);
  });

  it("считает историческую дату независимо от текущего летнего смещения", async () => {
    ctx.api.customers.set("c_1", "Europe/Berlin");
    await postWebhook(
      ctx.app,
      apiOrder({ amount: 500, createdAt: "2026-02-10T22:30:00Z" }),
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
    try {
      const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
      expect(res.json()).toEqual([
        { date: "2026-02-10", total: 500, gross: 500, discount: 0, net: 500 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("таймзона клиента берётся из API один раз", async () => {
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    ctx.api.customers.set("c_1", "UTC");
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    const { rows } = await ctx.db.query(`SELECT timezone FROM customers WHERE id = 'c_1'`);
    expect(rows[0].timezone).toBe("Europe/Moscow");
  });

  it("валидирует даты", async () => {
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-30", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-03-02", "2026-03-01")).statusCode).toBe(400);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });
});
