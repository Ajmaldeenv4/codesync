import { RUN_LIMITS, runnerRequestSchema, utf8Length } from "@codesync/shared";
import { SIGNATURE_HEADER, verifyRequest } from "@codesync/shared/hmac";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RateLimiter } from "./rate-limit";
import type { SandboxRunner } from "./sandbox";

export interface RunnerServerOptions {
  /** Shared with the web app, which signs every /run request. */
  hmacKey: string;
  sandbox: SandboxRunner;
  /** Burst of runs per user, and how fast it refills. */
  rateLimit?: { capacity: number; refillPerSecond: number };
  /** Containers allowed at once; more requests get 503 until one finishes. */
  maxConcurrentRuns?: number;
}

/** JSON overhead on top of the code and stdin limits (escaping can roughly double text). */
const MAX_BODY_BYTES = (RUN_LIMITS.codeBytes + RUN_LIMITS.stdinBytes) * 2 + 16 * 1024;

export function createRunnerServer(options: RunnerServerOptions): Server {
  const { hmacKey, sandbox, maxConcurrentRuns = 4 } = options;
  const { capacity, refillPerSecond } = options.rateLimit ?? { capacity: 5, refillPerSecond: 0.2 };
  const limiter = new RateLimiter(capacity, refillPerSecond);
  let running = 0;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://runner.invalid").pathname;

    if (req.method === "GET" && path === "/health") {
      return json(res, 200, { status: "ok", service: "runner", ready: sandbox.ready });
    }
    if (req.method !== "POST" || path !== "/run") return json(res, 404, { error: "not_found" });

    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === null) return json(res, 413, { error: "payload_too_large" });

    // Only the web app (holder of the HMAC key) may run code, and only recently-signed bodies.
    const header = req.headers[SIGNATURE_HEADER];
    const verified = verifyRequest(body, Array.isArray(header) ? header[0] : header, hmacKey);
    if (!verified.ok) return json(res, 401, { error: "bad_signature", reason: verified.reason });

    let parsed;
    try {
      parsed = runnerRequestSchema.safeParse(JSON.parse(body));
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    if (!parsed.success) return json(res, 400, { error: "invalid_body" });
    const { userId, language, code, stdin } = parsed.data;

    if (utf8Length(code) > RUN_LIMITS.codeBytes) {
      return json(res, 413, { error: "code_too_large", limit: RUN_LIMITS.codeBytes });
    }
    if (utf8Length(stdin) > RUN_LIMITS.stdinBytes) {
      return json(res, 413, { error: "stdin_too_large", limit: RUN_LIMITS.stdinBytes });
    }
    if (!sandbox.ready) return json(res, 503, { error: "warming_up" });

    const retryAfter = limiter.take(userId);
    if (retryAfter > 0) {
      res.setHeader("retry-after", String(retryAfter));
      return json(res, 429, { error: "rate_limited", retryAfterSeconds: retryAfter });
    }
    if (running >= maxConcurrentRuns) {
      res.setHeader("retry-after", "2");
      return json(res, 503, { error: "busy" });
    }

    running += 1;
    try {
      const result = await sandbox.run(language, code, stdin);
      return json(res, 200, result);
    } finally {
      running -= 1;
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error("run failed", err);
      if (!res.headersSent) json(res, 500, { error: "run_failed" });
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Reads the body as UTF-8, or null once it exceeds `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}
