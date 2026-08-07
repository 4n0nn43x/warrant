# Warrant Gateway — the 402 front door.
#
# Two stages, because the build needs a package manager, a TypeScript compiler
# and the whole workspace, and the runtime needs none of the three. What ships is
# Node, the compiled JavaScript, and the production dependency closure.
#
# The base is pinned by **digest**, not by tag: `node:22-bookworm-slim` is a
# moving target, and an image that cannot be rebuilt identically cannot be
# audited. Refresh it deliberately, as a commit one can read.

# ─── Build ───────────────────────────────────────────────────────────────────
FROM node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

WORKDIR /app
ENV CI=true

# corepack ships with Node and pins pnpm to the version `packageManager`
# declares — the same resolution the developer machine performs, rather than
# "whatever npm serves as latest today".
RUN corepack enable

# Manifests first, sources second: the dependency layer is then cached across
# every source edit, which is most of them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY deployments deployments
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
# `@warrant/sdk` is a *dev* dependency of the server, but a real one: the
# `open-via-gateway` operations binary imports it, and `tsc` compiles the whole
# package or none of it. It is built here and left behind in the runtime stage.
COPY packages/sdk-ts/package.json packages/sdk-ts/

# `--frozen-lockfile` is the supply-chain control here: it refuses to resolve
# anything the lockfile does not already pin, so a build cannot silently pull a
# version nobody reviewed.
RUN pnpm install --frozen-lockfile --filter @warrant/server... --filter @warrant/sdk... --filter .

COPY packages/core packages/core
COPY packages/sdk-ts packages/sdk-ts
COPY packages/server packages/server

RUN pnpm --filter @warrant/core build \
 && pnpm --filter @warrant/sdk build \
 && pnpm --filter @warrant/server build

# Second pass, production only: drops TypeScript, vitest and the rest of the
# build-time tree from what gets copied forward.
RUN pnpm install --frozen-lockfile --prod --filter @warrant/server... --filter . \
 && pnpm store prune

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

WORKDIR /app
ENV NODE_ENV=production

# The stock `node` user (uid 1000) rather than root, and rather than one we
# invent: it already exists in the base image, owns nothing, and has no shell
# worth having. A process that never needs to write outside its own tmp has no
# business being able to rewrite its own code.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/registry ./packages/core/registry
COPY --from=build --chown=node:node /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=build --chown=node:node /app/packages/server/package.json ./packages/server/package.json

# The classification registry of the target deployment, and not an optional
# extra. `registryRef = keccak256(JCS(registry))` is inscribed in the
# `actionSpec` of every warrant ever opened, so a Gateway loading a *different*
# registry rejects each quote with `registry_mismatch` — which is the correct
# refusal, since the commitment would not be replayable. The image therefore
# carries the file, and `WARRANT_REGISTRY_FILE` must point at it.
COPY --from=build --chown=node:node /app/deployments ./deployments

USER node

EXPOSE 8402

# The Gateway refuses to start half-configured, so an unhealthy container here
# means a missing variable, not a crash — and the message is on the first line
# of `docker logs`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8402)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No shell in front of it: PID 1 is Node itself, so SIGTERM from `docker stop`
# reaches the process instead of a shell that would swallow it.
CMD ["node", "packages/server/dist/bin/gateway.js"]
