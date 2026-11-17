import { createServer, type Server } from "node:http";

/** HTTP server for the sandbox runner. POST /run is added in Phase 4. */
export function createRunnerServer(): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "runner" }));
      return;
    }
    res.writeHead(404).end();
  });
}
