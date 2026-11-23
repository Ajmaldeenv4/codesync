import { SIGNATURE_HEADER, verifyRequest } from "@codesync/shared/hmac";
import { afterEach, describe, expect, test, vi } from "vitest";
import { requestRun } from "./runner";

const KEY = "web-runner-test-key-that-is-long-enough-12345";
const env = { RUNNER_URL: "http://runner.test:4000/", RUNNER_HMAC_KEY: KEY };
const input = { userId: "user_1", language: "python" as const, code: "print(1)", stdin: "" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestRun", () => {
  test("signs the exact body it sends, including the user id", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        stdout: "1\n",
        stderr: "",
        exit_code: 0,
        duration_ms: 5,
        timed_out: false,
        oom_killed: false,
        output_truncated: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestRun(input, env);
    expect(result.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://runner.test:4000/run");
    const headers = init.headers as Record<string, string>;
    expect(JSON.parse(init.body as string)).toEqual(input);
    expect(verifyRequest(init.body as string, headers[SIGNATURE_HEADER], KEY)).toEqual({
      ok: true,
    });
  });

  test("passes rate limits through with Retry-After, and hides other runner errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "4" } }),
      ),
    );
    expect(await requestRun(input, env)).toMatchObject({ ok: false, status: 429, retryAfter: "4" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "bad_signature" }, { status: 401 })),
    );
    expect(await requestRun(input, env)).toMatchObject({ ok: false, status: 502 });
  });

  test("waits for a waking runner, but not forever", async () => {
    const result = { stdout: "hi", stderr: "", exit_code: 0, duration_ms: 1 };
    const waking = () => Response.json({ error: "warming_up" }, { status: 503 });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => waking())
      .mockImplementationOnce(async () => Response.json(result));
    vi.stubGlobal("fetch", fetchMock);
    const woken = await requestRun(input, env, { attempts: 5, delayMs: 1 });
    expect(woken).toMatchObject({ ok: true, result });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const never = vi.fn(async () => waking());
    vi.stubGlobal("fetch", never);
    const gaveUp = await requestRun(input, env, { attempts: 3, delayMs: 1 });
    expect(gaveUp).toMatchObject({ ok: false, status: 503 });
    expect(never).toHaveBeenCalledTimes(3);
  });

  test("an unreachable runner is a 502, a missing key a 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
    );
    expect(await requestRun(input, env)).toMatchObject({ ok: false, status: 502 });
    expect(await requestRun(input, { RUNNER_URL: env.RUNNER_URL })).toMatchObject({
      ok: false,
      status: 500,
    });
  });
});
