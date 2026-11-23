// `pnpm load`: measures the numbers in load/results.md. Needs Postgres (DATABASE_URL) and Docker.
import { getPrisma } from "@codesync/db";
import { loadEnvFileIfExists } from "@codesync/shared/node";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { recovery, roomLoad, syncLatency, type RoomLoad } from "./collab-load";
import { runnerLoad, securityTally } from "./runner-load";
import type { Summary } from "./stats";

loadEnvFileIfExists(new URL("../../.env", import.meta.url));

const step = async <T>(label: string, work: () => Promise<T> | T): Promise<T> => {
  console.log(`${label}…`);
  const result = await work();
  console.log(JSON.stringify(result));
  return result;
};

const latency = await step("sync latency", () => syncLatency());
const rooms: RoomLoad[] = [];
for (const clients of [50, 100, 200]) {
  rooms.push(await step(`${clients} clients in one room`, () => roomLoad(clients)));
}
const recovered = await step("crash recovery", () => recovery());
const runs = await step("sandbox runs", () => runnerLoad());
const security = await step("security suite", () => securityTally());
await getPrisma().$disconnect();

const machine = {
  os: `${os.type()} ${os.release()}`,
  cpu: `${os.cpus()[0]?.model.trim() ?? "unknown"} (${os.cpus().length} threads)`,
  memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  node: process.version,
  date: new Date().toISOString().slice(0, 10),
};

const ms = (s: Summary) => `${s.p50} / ${s.p95} ms`;
const clean = (r: RoomLoad) =>
  r.lost === 0 && r.disconnects === 0 && r.converged && r.connected === r.clients;

const markdown = `# Measured results

Written by \`pnpm load\` on ${machine.date}. ${machine.cpu}, ${machine.memoryGb} GB, ${machine.os}, Node
${machine.node}.

Everything ran on one machine: clients, server and Postgres over loopback, sandboxes in local
Docker. These numbers show what the software adds. Internet latency to a deployed server comes on
top and is not included.

| Metric | Result |
| --- | --- |
| Sync latency, edit in A to visible in B, p50 / p95 (${latency.count} edits) | ${ms(latency)} |
${rooms
  .map(
    (r) =>
      `| ${r.clients} clients in one room: lost edits, dropped connections, identical text | ${r.lost} of ${r.deliveries + r.lost}, ${r.disconnects}, ${r.converged ? "yes" : "NO"}${clean(r) ? "" : " (NOT CLEAN)"} |
| ${r.clients} clients: edit to visible everywhere, p50 / p95 | ${ms(r.latency)} |`,
  )
  .join("\n")}
| Recovery after kill -9: restart to first synced document, p50 / p95 (${recovered.runs} restarts) | ${ms(recovered.milliseconds)} |
| Documents intact after kill -9 | ${recovered.intact} of ${recovered.runs} |
${runs
  .map(
    (r) =>
      `| ${r.language} sandbox run, request to result, p50 / p95 (${r.request.count} runs, ${r.failures} failed) | ${ms(r.request)} |`,
  )
  .join("\n")}
| Sandbox security tests passed | ${security.passed} of ${security.total} |

## How each number is measured

- **Sync latency:** one client inserts text every 20 ms; the time is from the local insert to the
  change event in a second client, through the real collab server process writing to Postgres.
- **Clients in one room:** all clients observe while 10 of them make 2 edits per second each for
  10 s. Every edit must reach every other client, no connection may drop, and every document must
  end identical. All clients share one load-generator process, so its own CPU use is included in
  the latency.
- **Recovery:** a 20 KB document is saved, the server is killed with SIGKILL, restarted, and timed
  from launching the process until a new client has the whole document.
- **Sandbox run:** sequential signed requests running a one-line program, including creating and
  removing the container.
- **Security tests:** \`apps/runner/test/docker/security.test.ts\` against real containers.
`;

writeFileSync(new URL("../results.md", import.meta.url), markdown);
writeFileSync(
  new URL("../results.json", import.meta.url),
  `${JSON.stringify({ machine, latency, rooms, recovered, runs, security }, null, 2)}\n`,
);
console.log("wrote load/results.md and load/results.json");
process.exit(0);
