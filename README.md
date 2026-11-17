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

### Signing in

- **GitHub:** create an OAuth app at <https://github.com/settings/developers> with the callback
  URL `http://localhost:3000/api/auth/callback/github`, then set `AUTH_GITHUB_ID` and
  `AUTH_GITHUB_SECRET` in `.env`.
- **Test users (local only):** set `AUTH_TEST_MODE=1` to get a "Sign in as test user" form that
  signs in by name. It is ignored when `NODE_ENV=production`, and the E2E tests rely on it.

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
pnpm e2e    # Playwright: two browsers edit one room (starts collab + web, or reuses running ones)
```

First time only: `pnpm --filter @codesync/e2e exec playwright install chromium`.
