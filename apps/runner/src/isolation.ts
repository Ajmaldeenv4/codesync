// Startup self-test: proves the host's Docker really enforces the sandbox limits. Some hosts
// (nested Docker, missing cgroup controllers) accept the flags and silently ignore them, so the
// runner refuses to accept code until a probe container reports the limits from the inside.
import type { Limits } from "./spec";

/** Run inside the sandbox; prints one JSON object describing its own confinement. */
export const PROBE_CODE = `
import json, os

def read(*paths):
    for p in paths:
        try:
            with open(p) as f:
                return f.read().strip()
        except OSError:
            pass
    return None

status = dict(l.split(":", 1) for l in open("/proc/self/status").read().splitlines() if ":" in l)

def can_write(path):
    try:
        with open(path, "w") as f:
            f.write("x")
        return True
    except OSError:
        return False

print(json.dumps({
    "uid": os.getuid(),
    "cap_eff": status["CapEff"].strip(),
    "no_new_privs": status["NoNewPrivs"].strip(),
    "interfaces": sorted(os.listdir("/sys/class/net")),
    "memory_max": read("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    "swap_max": read("/sys/fs/cgroup/memory.swap.max"),
    "pids_max": read("/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"),
    "cpu_max": read("/sys/fs/cgroup/cpu.max"),
    "root_writable": can_write("/codesync-probe"),
    "docker_socket": os.path.exists("/var/run/docker.sock"),
}))
`;

export interface IsolationReport {
  uid: number;
  cap_eff: string;
  no_new_privs: string;
  interfaces: string[];
  memory_max: string | null;
  swap_max: string | null;
  pids_max: string | null;
  cpu_max: string | null;
  root_writable: boolean;
  docker_socket: boolean;
}

/** Lists every way the report falls short of the limits; empty means the sandbox is sound. */
export function isolationProblems(report: IsolationReport, limits: Limits): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, problem: string) => {
    if (!ok) problems.push(problem);
  };

  check(report.uid === 65534, `runs as uid ${report.uid}, expected 65534`);
  check(/^0+$/.test(report.cap_eff), `has Linux capabilities ${report.cap_eff}`);
  check(report.no_new_privs === "1", "no-new-privileges is not set");
  check(
    report.interfaces.every((name) => name === "lo"),
    `has network interfaces: ${report.interfaces.join(", ")}`,
  );
  check(
    report.memory_max !== null && Number(report.memory_max) === limits.memoryBytes,
    `memory limit is ${report.memory_max ?? "unknown"}, expected ${limits.memoryBytes}`,
  );
  // Absent when the kernel has swap accounting off; then there is no swap limit to check.
  check(
    report.swap_max === null || report.swap_max === "0",
    `swap limit is ${report.swap_max}, expected 0`,
  );
  check(
    report.pids_max !== null && Number(report.pids_max) === limits.pids,
    `process limit is ${report.pids_max ?? "unknown"}, expected ${limits.pids}`,
  );
  check(cpuShare(report.cpu_max) === limits.cpus, `CPU limit is ${report.cpu_max ?? "unknown"}`);
  check(!report.root_writable, "the root filesystem is writable");
  check(!report.docker_socket, "the Docker socket is visible");
  return problems;
}

/** cgroup v2 cpu.max is "<quota> <period>" in microseconds, or "max <period>" when unlimited. */
function cpuShare(cpuMax: string | null): number | null {
  const match = /^(\d+) (\d+)$/.exec(cpuMax ?? "");
  return match ? Number(match[1]) / Number(match[2]) : null;
}
