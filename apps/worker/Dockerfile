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
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @tc/worker build
RUN pnpm deploy --filter=@tc/worker --prod /prod/worker

# ---- runtime: minimal node + the deployed worker ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /prod/worker/dist ./dist
COPY --from=builder /prod/worker/package.json ./package.json
COPY --from=builder /prod/worker/node_modules ./node_modules
USER node
CMD ["node", "dist/index.js"]
