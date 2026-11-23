// Web -> runner: every run is signed with RUNNER_HMAC_KEY and attributed to the signed-in user.
import type { Language, RunResult } from "@codesync/shared";
import { SIGNATURE_HEADER, signRequest } from "@codesync/shared/hmac";

export type RunnerResponse =
  | { ok: true; result: RunResult }
  | { ok: false; status: number; body: Record<string, unknown>; retryAfter: string | null };

export async function requestRun(
  input: { userId: string; language: Language; code: string; stdin: string },
  env: { RUNNER_URL?: string | undefined; RUNNER_HMAC_KEY?: string | undefined } = {
    RUNNER_URL: process.env.RUNNER_URL,
    RUNNER_HMAC_KEY: process.env.RUNNER_HMAC_KEY,
  },
  // A stopped machine wakes on the first request and needs a few seconds to verify its sandbox.
  wakeUp = { attempts: 10, delayMs: 2_000 },
): Promise<RunnerResponse> {
  for (let attempt = 1; ; attempt++) {
    const response = await sendRun(input, env);
    const waking = !response.ok && response.body.error === "warming_up";
    if (!waking || attempt >= wakeUp.attempts) return response;
    await new Promise((resolve) => setTimeout(resolve, wakeUp.delayMs));
  }
}

async function sendRun(
  input: { userId: string; language: Language; code: string; stdin: string },
  env: { RUNNER_URL?: string | undefined; RUNNER_HMAC_KEY?: string | undefined },
): Promise<RunnerResponse> {
  const key = env.RUNNER_HMAC_KEY;
  if (!key) {
    return { ok: false, status: 500, body: { error: "server_misconfigured" }, retryAfter: null };
  }
  const base = (env.RUNNER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  const body = JSON.stringify(input);

  let res: Response;
  try {
    res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signRequest(body, key) },
      body,
      // The sandbox kills programs at 5 s; leave room for container start and teardown.
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: 502, body: { error: "runner_unreachable" }, retryAfter: null };
  }

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, result: payload as unknown as RunResult };
  // Pass through what the user can act on; anything else is our fault, not theirs.
  const status = [413, 429, 503].includes(res.status) ? res.status : 502;
  return { ok: false, status, body: payload, retryAfter: res.headers.get("retry-after") };
}
