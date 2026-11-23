import { RUN_LIMITS } from "@codesync/shared";
import { expect, test } from "vitest";
import { isolationProblems, type IsolationReport } from "../src/isolation";

const sound: IsolationReport = {
  uid: 65534,
  cap_eff: "0000000000000000",
  no_new_privs: "1",
  interfaces: ["lo"],
  memory_max: "134217728",
  swap_max: "0",
  pids_max: "64",
  cpu_max: "50000 100000",
  root_writable: false,
  docker_socket: false,
};

test("a fully confined container has no problems", () => {
  expect(isolationProblems(sound, RUN_LIMITS)).toEqual([]);
});

// Each of these is a host that accepted the Docker flags but did not enforce one of them.
test.each<[string, Partial<IsolationReport>]>([
  ["runs as root", { uid: 0 }],
  ["keeps capabilities", { cap_eff: "00000000a80425fb" }],
  ["allows privilege escalation", { no_new_privs: "0" }],
  ["has a network interface", { interfaces: ["eth0", "lo"] }],
  ["has no memory limit", { memory_max: "max" }],
  ["cannot report its memory limit", { memory_max: null }],
  ["allows swap", { swap_max: "max" }],
  ["has no process limit", { pids_max: "max" }],
  ["has no CPU limit", { cpu_max: "max 100000" }],
  ["cannot report its CPU limit", { cpu_max: null }],
  ["has a writable root", { root_writable: true }],
  ["can see the Docker socket", { docker_socket: true }],
])("a container that %s is reported", (_name, override) => {
  expect(isolationProblems({ ...sound, ...override }, RUN_LIMITS)).toHaveLength(1);
});
