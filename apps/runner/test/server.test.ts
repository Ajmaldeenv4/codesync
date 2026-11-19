import type { Language, RunResult } from "@codesync/shared";
import { RUN_LIMITS } from "@codesync/shared";
import { SIGNATURE_HEADER, signRequest } from "@codesync/shared/hmac";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { SandboxRunner } from "../src/sandbox";
import { createRunnerServer } from "../src/server";

const KEY = "runner-test-hmac-key-that-is-long-enough-123";

const OK_RESULT: RunResult = {
  stdout: "ok\n",
  stderr: "",
  exit_code: 0,
  duration_ms: 12,
  timed_out: false,
  oom_killed: false,
  output_truncated: false,
};

class FakeSandbox implements SandboxRunner {
  ready = true;
  calls: { language: Language; code: string; stdin: string }[] = [];
  release: (() => void) | null = null;
  hold = false;

  async run(language: Language, code: string, stdin: string): Promise<RunResult> {
    this.calls.push({ language, code, stdin });
    if (this.hold) await new Promise<void>((resolve) => (this.release = resolve));
    return OK_RESULT;
  }
}

const sandbox = new FakeSandbox();
const server = createRunnerServer({
  hmacKey: KEY,
  sandbox,
  rateLimit: { capacity: 3, refillPerSecond: 0.001 },
  maxConcurrentRuns: 1,
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  sandbox.ready = true;
  sandbox.calls = [];
  sandbox.hold = false;
});

let userCounter = 0;
const freshUser = () => `user_${++userCounter}`;

function run(body: unknown, sign = true) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return fetch(`${base}/run`, {
    method: "POST",
    headers: sign ? { [SIGNATURE_HEADER]: signRequest(text, KEY) } : {},
    body: text,
  });
}

describe("health and routing", () => {
  test("reports readiness", async () => {
    sandbox.ready = false;
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "runner", ready: false });
  });

  test("unknown routes return 404", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("POST /run", () => {
  test("a signed, valid request runs and returns the result", async () => {
    const res = await run({ userId: freshUser(), language: "python", code: "print('ok')" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_RESULT);
    expect(sandbox.calls).toEqual([{ language: "python", code: "print('ok')", stdin: "" }]);
  });

  test("unsigned or wrongly signed requests are rejected before anything runs", async () => {
    const body = { userId: freshUser(), language: "python", code: "x" };
    expect((await run(body, false)).status).toBe(401);
    const forged = await fetch(`${base}/run`, {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: signRequest("{}", KEY) },
      body: JSON.stringify(body),
    });
    expect(forged.status).toBe(401);
    expect(sandbox.calls).toHaveLength(0);
  });

  test("invalid bodies are 400", async () => {
    expect((await run("not json")).status).toBe(400);
    expect((await run({ userId: freshUser(), language: "ruby", code: "x" })).status).toBe(400);
  });

  test("code over 100 KB and stdin over 64 KB are 413", async () => {
    const big = "a".repeat(RUN_LIMITS.codeBytes + 1);
    expect((await run({ userId: freshUser(), language: "python", code: big })).status).toBe(413);
    const bigStdin = "a".repeat(RUN_LIMITS.stdinBytes + 1);
    const res = await run({ userId: freshUser(), language: "python", code: "x", stdin: bigStdin });
    expect(res.status).toBe(413);
    expect(sandbox.calls).toHaveLength(0);
  });

  test("the size limit counts UTF-8 bytes, not characters", async () => {
    const twoByteChars = "é".repeat(RUN_LIMITS.codeBytes / 2 + 1);
    const res = await run({ userId: freshUser(), language: "python", code: twoByteChars });
    expect(res.status).toBe(413);
  });

  test("503 while images are still being pulled", async () => {
    sandbox.ready = false;
    const res = await run({ userId: freshUser(), language: "python", code: "x" });
    expect(res.status).toBe(503);
  });

  test("each user is rate limited independently", async () => {
    const alice = freshUser();
    for (let i = 0; i < 3; i++) {
      expect((await run({ userId: alice, language: "python", code: "x" })).status).toBe(200);
    }
    const limited = await run({ userId: alice, language: "python", code: "x" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    expect((await run({ userId: freshUser(), language: "python", code: "x" })).status).toBe(200);
  });

  test("runs beyond the concurrency limit get 503 busy", async () => {
    sandbox.hold = true;
    const first = run({ userId: freshUser(), language: "python", code: "slow" });
    await expect.poll(() => sandbox.calls.length).toBe(1);

    const second = await run({ userId: freshUser(), language: "python", code: "x" });
    expect(second.status).toBe(503);

    sandbox.release?.();
    expect((await first).status).toBe(200);
  });
});
