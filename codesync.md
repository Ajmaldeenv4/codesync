# CodeSync: Build Spec

> **How to use this file:** Start a new Claude Code session in an empty repo named `codesync`, attach this file, and say:
> *"Read codesync.md. Enter plan mode, propose a plan for Phase 0 and Phase 1, then build phase by phase. After each phase, run the tests, commit, and stop so I can review."*
>
> Build one phase at a time. Each phase should end working, tested and committed.

---

## 1. What we are building

**CodeSync** is a real-time collaborative code editor, like Google Docs for code. Users sign in with GitHub, create a room, and share the link. Everyone in the room:
- edits the same file at the same time without conflicts
- sees each other's cursors and selections, with names and colors
- chats in a side panel
- runs the code (JavaScript or Python) and sees the output, executed safely in a sandbox

When everyone leaves and comes back later, the room's code and history are still there.

### Resume claims this project must make true
- **Monaco** editor with conflict-free real-time editing via **Yjs CRDT over WebSockets**, **multi-cursor presence** and **in-room chat**.
- A **sandboxed code-execution service** that runs **JavaScript and Python** in **disposable Docker containers** with **`--network=none`** and a **128 MB memory cap**.
- **Y.Doc state persisted to PostgreSQL** through a **custom y-websocket server**, for room recovery and history.
- Deployed on **Vercel** (frontend) and **Fly.io** (servers), with **GitHub OAuth** via NextAuth.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Frontend | **Next.js** (App Router) + TypeScript + Tailwind |
| Editor | **Monaco** (`@monaco-editor/react`) + `y-monaco` binding |
| CRDT | **Yjs**; awareness protocol for cursors and presence |
| Collaboration server | **Custom Node.js y-websocket server** (`ws` + `y-protocols`), written by us rather than the stock binary |
| Auth | **NextAuth (Auth.js)** with the **GitHub** provider; JWT session shared with the WS server |
| Database | **PostgreSQL** + Prisma |
| Execution service | Separate Node.js (or Go) service that drives Docker through the Docker Engine API (`dockerode`) |
| Testing | Vitest (units), Playwright (two-browser collaboration E2E), k6 or a Node script (load) |
| Deploy | Vercel (Next.js), Fly.io (collab server + runner), Neon or Fly Postgres |
| CI | GitHub Actions: lint, typecheck, unit + E2E |

> **Important for Claude:** check the current docs for `y-monaco`, `y-websocket`, NextAuth/Auth.js (v5 API) and Next.js before coding, and pin versions. Don't write from memory.

---

## 3. Architecture

```
 Browser A ─┐                                   ┌─ Browser B
            │  HTTPS (pages, auth, REST)        │
            ▼                                   ▼
     ┌──────────────── Next.js on Vercel ────────────────┐
     │ pages · NextAuth (GitHub) · /api/rooms · /api/run │
     └───────┬───────────────────────────────┬───────────┘
             │ wss:// (Yjs sync + awareness   │ HTTPS (signed request)
             │        + chat, JWT in query)   │
     ┌───────▼────────────────┐     ┌────────▼─────────────────┐
     │ Collab server (Fly.io) │     │ Runner service (Fly.io)  │
     │ custom y-websocket     │     │ docker run --rm          │
     │ rooms in memory        │     │  --network=none          │
     │ debounced persistence  │     │  --memory=128m ...       │
     └───────┬────────────────┘     └──────────────────────────┘
             │
     ┌───────▼────────┐
     │  PostgreSQL    │  rooms · members · doc_updates · snapshots · chat
     └────────────────┘
```

---

## 4. Core components (detailed requirements)

### 4.1 Rooms and auth
- Sign in with GitHub through NextAuth, and store users in Postgres.
- `POST /api/rooms` creates a room with `{id (nanoid), name, language: "javascript"|"python", owner_id}`.
- `/room/[id]` is the editor page. Anyone with the link who is signed in can join, and joining adds them to `room_members`.
- The WebSocket connection must carry a short-lived signed token (a JWT signed with a shared secret). The collab server **rejects** connections without a valid token for that room.

### 4.2 Collaboration server (`apps/collab/`)
- Write our own server on `ws` + `y-protocols` (sync + awareness), using the y-websocket server as reference only.
- Keep one `Y.Doc` per room in memory and load it from Postgres when the first client joins.
- **Persistence:**
  - Append each incremental Yjs update to `doc_updates(room_id, seq, update BYTEA, created_at)`.
  - Every N updates (for example 200), or when the last client leaves, compact them into `snapshots(room_id, state BYTEA, version, created_at)` and delete the compacted updates.
  - Debounce writes (about 500 ms) so typing doesn't produce one DB write per keystroke.
- **History:** keep the snapshots, list them at `GET /api/rooms/{id}/history`, and let users preview or restore an old version (read-only view, plus a restore button for the owner).
- **Chat:** store messages in a `Y.Array` on the same doc, so they sync and persist the same way. Also mirror them to a `chat_messages` table.
- **Presence:** use the awareness protocol to share `{name, color, avatar, cursor, selection}`. Show colored remote cursors with name labels via `y-monaco`, and a member list with online dots.
- Add a health endpoint, plus metrics for connected clients, active rooms and updates per second.

### 4.3 Execution sandbox (`apps/runner/`)
- `POST /run {language, code, stdin?}` returns `{stdout, stderr, exit_code, duration_ms, timed_out}`.
- Every run creates a **fresh container** and removes it afterwards:
  ```
  docker run --rm --network=none --memory=128m --memory-swap=128m --cpus=0.5 \
    --pids-limit=64 --read-only --tmpfs /tmp:size=16m --user 65534:65534 \
    --cap-drop=ALL --security-opt no-new-privileges \
    node:20-alpine | python:3.12-alpine
  ```
- Enforce a **wall-clock timeout** of 5 s by killing the container, cap output at 64 KB, and cap code size at 100 KB.
- The runner accepts only requests signed by the Next.js backend (HMAC), and rate-limits by user.
- Pre-pull the images on startup to avoid slow first runs.
- **Security tests:** a test suite proves that each of these is blocked or contained: network access, a fork bomb, a memory bomb, an infinite loop, writing to `/`, and reading host files.

> **Fly.io note:** the runner needs a Docker daemon. On Fly.io, run it on a Machine whose image installs and starts `dockerd`. Machines are full VMs, so this is possible, but **verify it against current Fly docs in Phase 4**. If it isn't workable, deploy only the runner on a small VPS and keep everything else as planned. Update the README and resume wording to match what you actually deploy.

### 4.4 Frontend
- **Landing page:** sign in, "New room", and your recent rooms.
- **Room page:**
  - Monaco editor (language set per room) with remote cursors
  - top bar with room name, share-link button, members and a language badge
  - Run button with an output panel showing stdout, stderr, exit code and duration
  - collapsible chat panel and a history drawer
- **Connection status:** show connected, reconnecting or offline. Allow offline edits, which merge when the connection comes back (Yjs handles this).

---

## 5. Repository layout (monorepo, pnpm workspaces)

```
codesync/
├── apps/
│   ├── web/        # Next.js (Vercel)
│   ├── collab/     # custom y-websocket server (Fly.io)
│   └── runner/     # Docker sandbox service (Fly.io)
├── packages/
│   ├── db/         # Prisma schema + client
│   └── shared/     # token signing, types
├── e2e/            # Playwright two-browser tests
├── load/           # load-test script
├── docker-compose.yml   # postgres + collab + runner for local dev
├── .env.example
└── README.md
```

---

## 6. Build phases

**Phase 0: Skeleton.** Set up the pnpm monorepo, Next.js app, Prisma with local Postgres in Docker Compose, CI (lint, typecheck, test) and `.env.example`.
*Done when:* CI is green and `pnpm dev` starts everything.

**Phase 1: Auth + rooms.** Add NextAuth GitHub sign-in, the room APIs and the room page with a plain Monaco editor.
*Done when:* you can sign in, create a room and open it.

**Phase 2: Real-time collaboration.** Build the custom collab server, Yjs + y-monaco, awareness cursors, the member list and token-checked WebSockets.
*Done when:* a Playwright test opens two browsers, types in both and gets identical text, with each browser showing the other's cursor.

**Phase 3: Persistence + history + chat.** Add update logging, compaction into snapshots, room recovery after a server restart, the history drawer with restore, and the Y.Array chat.
*Done when:* a test kills the collab server, restarts it, and finds the document intact.

**Phase 4: Execution sandbox.** Build the runner service with all the limits in §4.3, signed requests, the security test suite and the output panel.
*Done when:* every security test passes.

**Phase 5: Deploy.** Deploy the web app to Vercel, and the collab server and runner to Fly.io (see the note in §4.3), with managed Postgres and a production GitHub OAuth app.
*Done when:* there's a live URL that two people on different networks can use together.

**Phase 6: Measure + README.** Run the load and latency tests (§7), then write the README with architecture, a GIF of two users editing, security notes, results and limitations.

---

## 7. Measure it (this gives the resume its numbers)

Add `load/` scripts that report:

| Metric | How | Result |
|---|---|---|
| Sync latency (edit in A → visible in B), p50 / p95 | Playwright or a Node client timing round trips | ? ms |
| Concurrent clients per room without errors | Simulated Yjs clients (50, 100, 200) | ? |
| Recovery time after a server restart | Kill and restart, then time to the first synced doc | ? s |
| Sandbox run time (container start → result), p50 / p95 | 100 runs of "hello world" per language | ? ms |
| Security tests blocked | Count from the §4.3 suite | ?/? |

Then the resume can say, for example: *"synced edits in X ms p95 with Y concurrent users per room"*.

---

## 8. Quality bar
- Use strict TypeScript, with ESLint + Prettier in CI.
- Unit-test the token signing, persistence/compaction logic and runner limits. Include the Playwright two-browser E2E test.
- Never commit secrets: GitHub OAuth secret, `NEXTAUTH_SECRET`, WS signing secret and runner HMAC key all come from env vars only.
- Include a README with setup in a few commands, an architecture diagram, a GIF, a security section, measured results and known limitations.
