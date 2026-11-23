# Measured results

Written by `pnpm load` on 2026-11-23. 13th Gen Intel(R) Core(TM) i7-13700HX (24 threads), 16 GB, Windows_NT 10.0.26200, Node
v26.13.0.

Everything ran on one machine: clients, server and Postgres over loopback, sandboxes in local
Docker. These numbers show what the software adds. Internet latency to a deployed server comes on
top and is not included.

| Metric                                                                            | Result             |
| --------------------------------------------------------------------------------- | ------------------ |
| Sync latency, edit in A to visible in B, p50 / p95 (500 edits)                    | 0.6 / 1 ms         |
| 50 clients in one room: lost edits, dropped connections, identical text           | 0 of 9800, 0, yes  |
| 50 clients: edit to visible everywhere, p50 / p95                                 | 1.5 / 3.2 ms       |
| 100 clients in one room: lost edits, dropped connections, identical text          | 0 of 19800, 0, yes |
| 100 clients: edit to visible everywhere, p50 / p95                                | 2.4 / 5.5 ms       |
| 200 clients in one room: lost edits, dropped connections, identical text          | 0 of 39800, 0, yes |
| 200 clients: edit to visible everywhere, p50 / p95                                | 3.6 / 8.3 ms       |
| Recovery after kill -9: restart to first synced document, p50 / p95 (10 restarts) | 607.1 / 664.3 ms   |
| Documents intact after kill -9                                                    | 10 of 10           |
| javascript sandbox run, request to result, p50 / p95 (100 runs, 0 failed)         | 288.3 / 346.2 ms   |
| python sandbox run, request to result, p50 / p95 (100 runs, 0 failed)             | 273.9 / 315.2 ms   |
| Sandbox security tests passed                                                     | 10 of 10           |

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
- **Security tests:** `apps/runner/test/docker/security.test.ts` against real containers.
