import type { Language, RunResult } from "@codesync/shared";
import { SIGNATURE_HEADER, signRequest } from "@codesync/shared/hmac";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, RUNNER_KEY, startService } from "./harness";
import { summarize, type Summary } from "./stats";

const HELLO: Record<Language, string> = {
  javascript: "console.log('hello')",
  python: "print('hello')",
};

export interface RunnerLoad {
  language: Language;
  failures: number;
  /** Whole request: create container, run, collect output, remove container. */
  request: Summary;
  /** Only the program, from container start to exit. */
  program: Summary;
}

/** Sequential "hello" runs through the runner's signed HTTP API. */
export async function runnerLoad(runs = 100): Promise<RunnerLoad[]> {
  const port = await freePort();
  const server = await startService(
    "runner",
    { RUNNER_PORT: String(port), RUNNER_HMAC_KEY: RUNNER_KEY },
    "sandbox limits verified",
  );
  try {
    const results: RunnerLoad[] = [];
    for (const language of ["javascript", "python"] as const) {
      const request: number[] = [];
      const program: number[] = [];
      let failures = 0;
      for (let i = 0; i < runs; i++) {
        // A user per run, so the per-user rate limit isn't what gets measured.
        const body = JSON.stringify({
          userId: `${language}-${i}`,
          language,
          code: HELLO[language],
          stdin: "",
        });
        const startedAt = performance.now();
        const res = await fetch(`http://127.0.0.1:${port}/run`, {
          method: "POST",
          headers: { [SIGNATURE_HEADER]: signRequest(body, RUNNER_KEY) },
          body,
        });
        const result = (await res.json()) as RunResult;
        request.push(performance.now() - startedAt);
        if (res.ok && result.stdout === "hello\n") program.push(result.duration_ms);
        else failures += 1;
      }
      results.push({
        language,
        failures,
        request: summarize(request),
        program: summarize(program),
      });
    }
    return results;
  } finally {
    await server.kill();
  }
}

export interface SecurityTally {
  passed: number;
  total: number;
}

/** Runs the sandbox security suite and counts what it blocked. */
export function securityTally(): SecurityTally {
  const dir = mkdtempSync(path.join(tmpdir(), "codesync-load-"));
  const output = path.join(dir, "security.json");
  try {
    const runner = fileURLToPath(new URL("../../apps/runner", import.meta.url));
    const vitest = path.join(runner, "node_modules", "vitest", "vitest.mjs");
    spawnSync(
      process.execPath,
      [vitest, "run", "test/docker/security.test.ts", "--reporter=json", `--outputFile=${output}`],
      { cwd: runner, env: { ...process.env, REQUIRE_DOCKER: "1" } },
    );
    const report = JSON.parse(readFileSync(output, "utf8")) as {
      numPassedTests: number;
      numTotalTests: number;
    };
    return { passed: report.numPassedTests, total: report.numTotalTests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
