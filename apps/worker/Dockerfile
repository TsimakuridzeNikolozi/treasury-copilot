# syntax=docker/dockerfile:1.7
# Multi-stage Docker build for the worker, using `pnpm deploy` to extract
# only the worker's production dependencies into the final image.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

# ---- builder: install all deps, build the worker bundle ----
FROM base AS builder
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/worker ./apps/worker
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tc/worker build

# ---- runtime: minimal node + the worker bundle ----
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /repo/apps/worker/dist ./dist
# @tc/* are bundled into dist/index.cjs via tsup noExternal — strip them from
# package.json so pnpm only installs the four external runtime deps.
COPY --from=builder /repo/apps/worker/package.json ./package.json
RUN node -e "\
  const fs = require('fs'); \
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
  p.dependencies = Object.fromEntries( \
    Object.entries(p.dependencies || {}).filter(([k]) => !k.startsWith('@tc/')) \
  ); \
  delete p.devDependencies; \
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2)); \
"
RUN pnpm install --prod
USER node
CMD ["node", "dist/index.cjs"]
