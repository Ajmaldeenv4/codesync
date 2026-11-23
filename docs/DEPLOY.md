# Deploying CodeSync

Three pieces plus a database: the web app on Vercel, the collab server and the runner on Fly.io,
and Postgres on Neon. Run every command from the repo root.

You need accounts on GitHub, Vercel, Fly.io (with a payment method) and Neon. Vercel and Neon have
free plans. On Fly, both machines sleep when idle, so a demo should use well under the $5 a month
its Free plan includes with a card on file. That is an allowance, not a cap: if a month goes over
$5, Fly bills the whole month from the first cent.

App names on Fly are global. If `codesync-collab` or `codesync-runner` is taken, change `app` in
`apps/collab/fly.toml` / `apps/runner/fly.toml` and use your names below.

## 1. Database (Neon)

Create a project in the region closest to Fly's `iad` (US East). Copy two connection strings:

- **Direct** (host without `-pooler`): for the collab server, which also runs migrations.
- **Pooled** (host with `-pooler`): for Vercel, whose functions open many short connections.

## 2. Shared secrets

Generate four values with `openssl rand -base64 32`. Each must be identical wherever it appears:

| Secret                   | collab | runner | Vercel |
| ------------------------ | :----: | :----: | :----: |
| `WS_TOKEN_SECRET`        |  yes   |        |  yes   |
| `COLLAB_INTERNAL_SECRET` |  yes   |        |  yes   |
| `RUNNER_HMAC_KEY`        |        |  yes   |  yes   |
| `AUTH_SECRET`            |        |        |  yes   |

## 3. Collab server (Fly)

```bash
flyctl auth login
flyctl apps create codesync-collab
flyctl secrets set --app codesync-collab DATABASE_URL="<neon direct url>" WS_TOKEN_SECRET="..." COLLAB_INTERNAL_SECRET="..."
flyctl deploy . --config apps/collab/fly.toml --dockerfile apps/collab/Dockerfile --ha=false
curl https://codesync-collab.fly.dev/health
```

`--ha=false` matters: rooms live in one process's memory, so there must be exactly one machine.
Migrations run before each release.

## 4. Runner (Fly)

```bash
flyctl apps create codesync-runner
flyctl volumes create runner_docker --app codesync-runner --region iad --size 1
flyctl secrets set --app codesync-runner RUNNER_HMAC_KEY="..."
flyctl deploy . --config apps/runner/fly.toml --dockerfile apps/runner/Dockerfile.fly --ha=false
curl https://codesync-runner.fly.dev/health
```

The last command must eventually show `"ready":true`. The runner starts its own Docker daemon and
then proves, from inside a container, that the memory, process, CPU, network and filesystem limits
are enforced. If they are not, it logs `sandbox is not isolated on this host`, exits, and never
runs any code. This has been tested in a privileged container, not yet on a Fly Machine, and Fly's
documentation does not cover it.

**If it never becomes ready:** run only the runner on a small VPS with Docker installed, and put a
TLS reverse proxy in front of port 4000:

```bash
docker build -f apps/runner/Dockerfile -t codesync-runner .
docker run -d --restart unless-stopped -p 127.0.0.1:4000:4000 -v /var/run/docker.sock:/var/run/docker.sock -e RUNNER_HMAC_KEY="..." codesync-runner
```

Give that VPS nothing else to do: the runner controls its Docker daemon, which is equivalent to
root on that machine. Then update the README and resume to say where the runner actually runs.

## 5. GitHub OAuth app

Create a **production** OAuth app at <https://github.com/settings/developers> (separate from the
local one). Callback URL: `https://<your-app>.vercel.app/api/auth/callback/github`.

## 6. Web app (Vercel)

Import the GitHub repository in Vercel and set:

- **Root Directory:** `apps/web`, with "Include files outside the root directory" left on.
- **Node.js version:** 24.x. Build and install commands come from `apps/web/vercel.json`.
- **Environment variables** (Production):

| Variable                               | Value                              |
| -------------------------------------- | ---------------------------------- |
| `DATABASE_URL`                         | Neon pooled URL                    |
| `AUTH_SECRET`                          | from step 2                        |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | from step 5                        |
| `NEXT_PUBLIC_COLLAB_URL`               | `wss://codesync-collab.fly.dev`    |
| `WS_TOKEN_SECRET`                      | from step 2                        |
| `COLLAB_INTERNAL_SECRET`               | from step 2                        |
| `RUNNER_URL`                           | `https://codesync-runner.fly.dev`  |
| `RUNNER_HMAC_KEY`                      | from step 2                        |
| `ENABLE_EXPERIMENTAL_COREPACK`         | `1` (uses the pinned pnpm version) |

Do not set `AUTH_TEST_MODE`. Vercel is trusted by Auth.js automatically, so `AUTH_TRUST_HOST` is
only needed if you host the web app elsewhere.

## 7. Lock the collab server to your site

```bash
flyctl secrets set --app codesync-collab COLLAB_ALLOWED_ORIGINS="https://<your-app>.vercel.app"
```

## 8. Check it

1. Sign in with GitHub on two devices on different networks (for example a laptop on Wi-Fi and a
   phone on mobile data) and open the same room.
2. Type on both; each sees the other's text and cursor.
3. Run some code.
4. Run `flyctl deploy` for collab again while a room is open. The room reconnects with nothing lost.
