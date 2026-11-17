# CodeSync

Real-time collaborative code editor: Monaco + Yjs over a custom y-websocket server, Postgres
persistence, and a Docker sandbox that runs JavaScript and Python. See [codesync.md](codesync.md)
for the full spec. This README grows into the full write-up in Phase 6.

## Local setup

Requires Node 24+, pnpm 12 and Docker.

```bash
pnpm install
cp .env.example .env              # then fill in the secrets it lists
docker compose up -d postgres
pnpm db:migrate
pnpm dev                          # web :3000, collab :1234, runner :4000
```

## Layout

| Path              | What                                    |
| ----------------- | --------------------------------------- |
| `apps/web`        | Next.js app (Vercel)                    |
| `apps/collab`     | Custom y-websocket collaboration server |
| `apps/runner`     | Docker sandbox execution service        |
| `packages/db`     | Prisma schema, migrations and client    |
| `packages/shared` | Shared types, token signing             |

## Checks

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```
