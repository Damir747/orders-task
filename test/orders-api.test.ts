import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpOrdersApi } from "../src/clients/orders-api.js";
import { UpstreamError } from "../src/errors.js";
import { setupTestApp } from "./helpers.js";

const ctx = setupTestApp();
const getFakeOrdersPage = ctx.api.getOrdersPage;
const getFakeCustomer = ctx.api.getCustomer;

afterEach(() => {
  vi.unstubAllGlobals();
  ctx.api.getOrdersPage = getFakeOrdersPage;
  ctx.api.getCustomer = getFakeCustomer;
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

function stubRawResponse(body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(body, {
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

  it("does not retry a SyntaxError while parsing response JSON", async () => {
    const response = new Response("invalid", { status: 200 });
    vi.spyOn(response, "json").mockRejectedValue(new SyntaxError("invalid JSON"));
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const request = new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 2 }).getOrdersPage(
      null,
      100,
    );

    await expect(request).rejects.toBeInstanceOf(UpstreamError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a non-SyntaxError while reading the response body", async () => {
    const failedResponse = new Response("", { status: 200 });
    vi.spyOn(failedResponse, "json").mockRejectedValue(new TypeError("temporary body read failure"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failedResponse)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const page = await new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 2 }).getOrdersPage(
      null,
      100,
    );

    expect(page).toEqual({ items: [], nextCursor: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    stubOrdersResponse({ items: [], nextCursor: "", diagnostic: "upstream-private-detail" });
    const httpApi = new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 });
    ctx.api.getOrdersPage = (cursor) => httpApi.getOrdersPage(cursor, 100);

    const response = await ctx.app.inject({ method: "POST", url: "/sync" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "upstream_error", message: "Upstream service error" });
    expect(response.json().message).not.toContain("upstream-private-detail");
    const { rows } = await ctx.db.query(`SELECT pages, received, error FROM sync_runs ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({ pages: 0, received: 0 });
    expect(rows[0].error).toContain("unexpected /orders response");
  });

  it("maps malformed JSON from /orders to a safe 502 sync error", async () => {
    stubRawResponse('{"items":');
    const httpApi = new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 });
    ctx.api.getOrdersPage = (cursor) => httpApi.getOrdersPage(cursor, 100);

    const response = await ctx.app.inject({ method: "POST", url: "/sync" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "upstream_error",
      message: "Upstream service error",
    });
    const { rows } = await ctx.db.query(`SELECT error FROM sync_runs ORDER BY id DESC LIMIT 1`);
    expect(rows[0].error).toContain("invalid JSON response");
  });

  it("maps malformed JSON from /customers/:id to a safe 502", async () => {
    stubRawResponse('{"timezone":');
    const httpApi = new HttpOrdersApi("http://orders.test", { rps: 1000, maxAttempts: 1 });
    ctx.api.getCustomer = (id) => httpApi.getCustomer(id);

    const response = await ctx.app.inject({
      method: "GET",
      url: "/customers/c_1/daily-totals?from=2026-02-10&to=2026-02-10",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "upstream_error",
      message: "Upstream service error",
    });
  });
});
