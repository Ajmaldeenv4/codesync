# Build from the repo root: docker build -f apps/collab/Dockerfile .
FROM node:24-alpine
RUN npm install -g pnpm@12.21.0
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/collab/package.json apps/collab/
RUN pnpm install --frozen-lockfile --filter @codesync/collab...

COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/collab apps/collab
# The Prisma client is generated code (git-ignored), so build it into the image.
RUN pnpm --filter @codesync/db generate

ENV NODE_ENV=production
USER node
EXPOSE 1234
CMD ["pnpm", "--filter", "@codesync/collab", "start"]
