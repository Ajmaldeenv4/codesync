// Spec §4.3 security suite: each attack must be blocked or contained by the sandbox flags.
// Python is used for most probes because its errors are explicit; JS gets its own network check.
import { RUN_LIMITS } from "@codesync/shared";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  dockerAvailable,
  PREPARE_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  sandbox,
  sandboxContainers,
} from "./setup";

describe.skipIf(!dockerAvailable)("sandbox security", () => {
  beforeAll(() => sandbox.prepare(() => undefined), PREPARE_TIMEOUT_MS);

  afterAll(async () => {
    // Nothing may be left running after attacks either.
    expect(await sandboxContainers()).toBe(0);
  });

  test(
    "network access is blocked (Python: no interface but loopback, TCP and UDP fail)",
    async () => {
      const result = await sandbox.run(
        "python",
        [
          "import os, socket",
          // --network=none leaves only the loopback interface.
          "print('interfaces', sorted(os.listdir('/sys/class/net')))",
          "try:",
          "    socket.create_connection(('1.1.1.1', 80), timeout=2)",
          "    print('tcp open')",
          "except OSError:",
          "    print('tcp blocked')",
          "try:",
          "    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)",
          "    s.sendto(b'x', ('1.1.1.1', 53))",
          "    print('udp open')",
          "except OSError:",
          "    print('udp blocked')",
        ].join("\n"),
        "",
      );
      expect(result.stdout).toBe("interfaces ['lo']\ntcp blocked\nudp blocked\n");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "network access is blocked (JavaScript: fetch)",
    async () => {
      const result = await sandbox.run(
        "javascript",
        "fetch('http://1.1.1.1', { signal: AbortSignal.timeout(2000) })" +
          ".then(() => console.log('open'), () => console.log('blocked'))",
        "",
      );
      expect(result.stdout.trim()).toBe("blocked");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a fork bomb is contained by the pids limit and the run still ends",
    async () => {
      const result = await sandbox.run(
        "python",
        [
          "import os",
          "while True:",
          "    try:",
          "        os.fork()",
          "    except OSError:",
          "        pass",
        ].join("\n"),
        "",
      );
      // Either the wall-clock kill or the process failing; never an unbounded run.
      expect(result.duration_ms).toBeLessThan(RUN_LIMITS.timeoutMs + 2_000);
      // The host (and the sandbox) still work afterwards.
      const after = await sandbox.run("python", "print('still alive')", "");
      expect(after.stdout).toBe("still alive\n");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a program cannot start more than 64 processes",
    async () => {
      const result = await sandbox.run(
        "python",
        [
          "import os, signal, time",
          "pids = []",
          "try:",
          "    for _ in range(500):",
          "        pid = os.fork()",
          "        if pid == 0:",
          "            time.sleep(30)",
          "            os._exit(0)",
          "        pids.append(pid)",
          "    print('unlimited', len(pids))",
          "except OSError:",
          "    print('stopped', len(pids))",
          "for pid in pids:",
          "    os.kill(pid, signal.SIGKILL)",
        ].join("\n"),
        "",
      );
      const [outcome, count] = result.stdout.trim().split(" ");
      expect(outcome).toBe("stopped");
      expect(Number(count)).toBeLessThan(RUN_LIMITS.pids);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a memory bomb is OOM-killed at 128 MB",
    async () => {
      const result = await sandbox.run(
        "python",
        ["blocks = []", "while True:", "    blocks.append(bytearray(16 * 1024 * 1024))"].join("\n"),
        "",
      );
      expect(
        result.oom_killed || result.exit_code === 137 || /MemoryError/.test(result.stderr),
      ).toBe(true);
      expect(result.timed_out).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "an infinite loop is killed at the 5 s wall-clock limit",
    async () => {
      const result = await sandbox.run("javascript", "for (;;) {}", "");
      expect(result.timed_out).toBe(true);
      expect(result.duration_ms).toBeGreaterThanOrEqual(RUN_LIMITS.timeoutMs - 100);
      expect(result.duration_ms).toBeLessThan(RUN_LIMITS.timeoutMs + 2_000);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "writing to / (or anywhere outside the small /tmp) fails",
    async () => {
      const result = await sandbox.run(
        "python",
        [
          "for path in ['/evil', '/etc/evil', '/usr/local/evil']:",
          "    try:",
          "        open(path, 'w').write('x')",
          "        print('wrote', path)",
          "    except OSError as e:",
          "        print('blocked', path, type(e).__name__)",
        ].join("\n"),
        "",
      );
      expect(result.stdout).not.toContain("wrote");
      expect(result.stdout.match(/blocked/g)).toHaveLength(3);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "the /tmp scratch space is capped at 16 MB",
    async () => {
      const result = await sandbox.run(
        "python",
        [
          "try:",
          "    with open('/tmp/big', 'wb') as f:",
          "        f.write(b'0' * (32 * 1024 * 1024))",
          "    print('wrote 32MB')",
          "except OSError as e:",
          "    print('blocked', type(e).__name__)",
        ].join("\n"),
        "",
      );
      expect(result.stdout).toContain("blocked");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "host files and secrets are not reachable",
    async () => {
      const result = await sandbox.run(
        "python",
        [
          "import os",
          "checks = {}",
          "checks['docker_socket'] = os.path.exists('/var/run/docker.sock')",
          "checks['repo'] = os.path.exists('/repo') or os.path.exists('/app')",
          "try:",
          "    open('/etc/shadow').read()",
          "    checks['shadow'] = True",
          "except OSError:",
          "    checks['shadow'] = False",
          "env = open('/proc/self/environ', 'rb').read().decode(errors='replace')",
          "checks['secrets_in_env'] = any(k in env for k in ['SECRET', 'HMAC', 'DATABASE_URL', 'CODESYNC_CODE'])",
          "print(checks)",
        ].join("\n"),
        "",
      );
      expect(result.stdout.trim()).toBe(
        "{'docker_socket': False, 'repo': False, 'shadow': False, 'secrets_in_env': False}",
      );
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "code runs as nobody with no Linux capabilities and no privilege escalation",
    async () => {
      const result = await sandbox.run(
        "python",
        [
          "import os",
          "status = open('/proc/self/status').read().splitlines()",
          "fields = dict(line.split(':', 1) for line in status if ':' in line)",
          "print(os.getuid(), os.getgid(), fields['CapEff'].strip(), fields['NoNewPrivs'].strip())",
        ].join("\n"),
        "",
      );
      expect(result.stdout.trim()).toBe("65534 65534 0000000000000000 1");
    },
    RUN_TIMEOUT_MS,
  );
});
