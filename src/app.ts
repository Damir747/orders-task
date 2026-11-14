import Fastify, { type FastifyInstance } from "fastify";
import type { Container } from "./container.js";
import { AppError, UpstreamError } from "./errors.js";
import { customerRoutes } from "./routes/customers.js";
import { syncRoutes } from "./routes/sync.js";
import { webhookRoutes } from "./routes/webhooks.js";

const FASTIFY_CLIENT_ERRORS: Record<string, { statusCode: number; code: string; message: string }> = {
  FST_ERR_CTP_INVALID_JSON_BODY: { statusCode: 400, code: "bad_request", message: "Malformed JSON" },
  FST_ERR_CTP_EMPTY_JSON_BODY: { statusCode: 400, code: "bad_request", message: "Malformed JSON" },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { statusCode: 400, code: "bad_request", message: "Invalid request body" },
  FST_ERR_CTP_BODY_TOO_LARGE: { statusCode: 413, code: "payload_too_large", message: "Request body too large" },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    statusCode: 415,
    code: "unsupported_media_type",
    message: "Unsupported Content-Type",
  },
};

export function buildApp(c: Container, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof UpstreamError) {
      req.log.error({ err }, "Upstream request failed");
      return reply
        .code(err.statusCode)
        .send({ error: err.code, message: "Upstream service error" });
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    // This Fastify version emits a code-less SyntaxError for malformed JSON.
    const code =
      typeof err.code === "string"
        ? err.code
        : err.name === "SyntaxError" && "statusCode" in err && err.statusCode === 400
          ? "FST_ERR_CTP_INVALID_JSON_BODY"
          : "";
    const clientError = FASTIFY_CLIENT_ERRORS[code];
    if (clientError) {
      return reply
        .code(clientError.statusCode)
        .send({ error: clientError.code, message: clientError.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "internal", message: "Internal error" });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).send({ error: "not_found", message: "Route not found" });
  });

  app.get("/health", async () => ({ status: "ok" }));
  syncRoutes(app, c);
  webhookRoutes(app, c);
  customerRoutes(app, c);
  return app;
}
