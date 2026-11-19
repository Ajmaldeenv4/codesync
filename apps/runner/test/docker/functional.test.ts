import { RUN_LIMITS } from "@codesync/shared";
import { beforeAll, describe, expect, test } from "vitest";
import {
  dockerAvailable,
  PREPARE_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  sandbox,
  sandboxContainers,
} from "./setup";

describe.skipIf(!dockerAvailable)("sandbox runs real programs", () => {
  beforeAll(() => sandbox.prepare(() => undefined), PREPARE_TIMEOUT_MS);

  test(
    "JavaScript: stdin in, stdout and stderr out, exit code",
    async () => {
      const result = await sandbox.run(
        "javascript",
        "const s = require('fs').readFileSync(0, 'utf8');\n" +
          "console.log('upper:', s.trim().toUpperCase());\n" +
          "console.error('to stderr');\n" +
          "process.exit(3);",
        "hello sandbox\n",
      );
      expect(result).toMatchObject({
        stdout: "upper: HELLO SANDBOX\n",
        stderr: "to stderr\n",
        exit_code: 3,
        timed_out: false,
        oom_killed: false,
        output_truncated: false,
      });
      expect(result.duration_ms).toBeLessThan(RUN_LIMITS.timeoutMs);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "Python: stdin, unicode output, uncaught exception",
    async () => {
      const result = await sandbox.run(
        "python",
        "import sys\nname = sys.stdin.read().strip()\nprint(f'héllo {name} ✓')\nraise ValueError('boom')",
        "Ada",
      );
      expect(result.stdout).toBe("héllo Ada ✓\n");
      expect(result.stderr).toContain("ValueError: boom");
      expect(result.exit_code).toBe(1);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a ~100 KB multibyte program spanning several env chunks arrives byte-exact",
    async () => {
      const filler = "# " + "é".repeat(49_000) + "\n";
      const code = filler + "print(len(open('/tmp/main', encoding='utf8').read()))\n";
      const result = await sandbox.run("python", code, "");
      expect(result.stderr).toBe("");
      expect(Number(result.stdout.trim())).toBe(code.length);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "output past the 64 KB cap is cut off and the program is stopped",
    async () => {
      const result = await sandbox.run("python", "while True: print('x' * 1000)", "");
      expect(result.output_truncated).toBe(true);
      expect(Buffer.byteLength(result.stdout)).toBe(RUN_LIMITS.outputBytes);
      expect(result.timed_out).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "every run's container is removed afterwards",
    async () => {
      await sandbox.run("javascript", "console.log(1)", "");
      expect(await sandboxContainers()).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );
});
