import { createServer, type Server } from "node:http";

/** HTTP server for the collab service. WebSocket upgrades are added in Phase 2. */
export function createCollabServer(): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "collab" }));
      return;
    }
    res.writeHead(404).end();
  });
}
