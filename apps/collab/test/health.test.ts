import { afterAll, beforeAll, expect, test } from "vitest";
import { startServer, type RunningServer } from "./helpers";

let running: RunningServer;

beforeAll(async () => {
  running = await startServer();
});

afterAll(() => running.collab.close());

test("GET /health reports ok", async () => {
  const res = await fetch(`${running.httpUrl}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", service: "collab" });
});

test("unknown routes return 404", async () => {
  const res = await fetch(`${running.httpUrl}/nope`);
  expect(res.status).toBe(404);
});
