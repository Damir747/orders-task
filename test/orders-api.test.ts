import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpOrdersApi } from "../src/clients/orders-api.js";
import { UpstreamError } from "../src/errors.js";
import { setupTestApp } from "./helpers.js";

const ctx = setupTestApp();
const getFakeOrdersPage = ctx.api.getOrdersPage;

afterEach(() => {
  vi.unstubAllGlobals();
  ctx.api.getOrdersPage = getFakeOrdersPage;
});

function stubOrdersResponse(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("HttpOrdersApi.getOrdersPage", () => {
  it("accepts a string nextCursor", async () => {
    stubOrdersResponse({ items: [], nextCursor: "page-2" });

    const page = await new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 }).getOrdersPage(
      null,
      100,
    );

    expect(page).toEqual({ items: [], nextCursor: "page-2" });
  });

  it("accepts nextCursor null", async () => {
    stubOrdersResponse({ items: [], nextCursor: null });

    const page = await new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 }).getOrdersPage(
      null,
      100,
    );

    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("rejects an empty string nextCursor", async () => {
    stubOrdersResponse({ items: [], nextCursor: "" });

    const request = new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 }).getOrdersPage(
      null,
      100,
    );

    await expect(request).rejects.toBeInstanceOf(UpstreamError);
  });

  it("rejects a response without nextCursor", async () => {
    stubOrdersResponse({ items: [] });

    const request = new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 }).getOrdersPage(
      null,
      100,
    );

    await expect(request).rejects.toBeInstanceOf(UpstreamError);
  });

  it.each([42, false, {}, []])("rejects nextCursor with invalid type: %j", async (nextCursor) => {
    stubOrdersResponse({ items: [], nextCursor });

    const request = new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 }).getOrdersPage(
      null,
      100,
    );

    await expect(request).rejects.toBeInstanceOf(UpstreamError);
  });

  it("continues to require items to be an array", async () => {
    stubOrdersResponse({ items: {}, nextCursor: null });

    const request = new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 }).getOrdersPage(
      null,
      100,
    );

    await expect(request).rejects.toBeInstanceOf(UpstreamError);
  });

  it("returns a failed sync and records the error for an invalid HTTP cursor", async () => {
    stubOrdersResponse({ items: [], nextCursor: "" });
    const httpApi = new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 });
    ctx.api.getOrdersPage = (cursor) => httpApi.getOrdersPage(cursor, 100);

    const response = await ctx.app.inject({ method: "POST", url: "/sync" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "upstream_error" });
    const { rows } = await ctx.db.query(`SELECT pages, received, error FROM sync_runs ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({ pages: 0, received: 0 });
    expect(rows[0].error).toContain("unexpected /orders response");
  });
});
