# Build from the repo root: docker build -f apps/runner/Dockerfile .
FROM node:24-alpine
RUN npm install -g pnpm@12.21.0
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/runner/package.json apps/runner/
RUN pnpm install --frozen-lockfile --filter @codesync/runner...

COPY packages/shared packages/shared
COPY apps/runner apps/runner

ENV NODE_ENV=production
# Runs as root for now: it needs the mounted Docker socket. Revisited in Phase 4.
EXPOSE 4000
CMD ["pnpm", "--filter", "@codesync/runner", "start"]
