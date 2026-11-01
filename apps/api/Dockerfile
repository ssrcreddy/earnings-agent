# One image, two modes (§11): MODE=http runs Fastify, MODE=worker runs pg-boss consumers.
FROM node:24-slim
WORKDIR /app
RUN npm install -g pnpm@10.34.9

# Manifests first so the dependency layer caches across source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@eia/api..." --filter "@eia/db..."

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api

ENV NODE_ENV=production
EXPOSE 8080
CMD ["pnpm", "--filter", "@eia/api", "start"]
