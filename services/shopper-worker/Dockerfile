# The shopper worker (WS09). Build from the repo root, so the workspace packages it runs from
# source (@mp/agent, @mp/core, @mp/llm, @mp/retailers) are in the context:
#
#   docker build -f services/shopper-worker/Dockerfile -t shopper-worker .
#
# Dockerfile.dockerignore next to this file keeps the context to what the worker needs. No secret
# is baked in: WORKER_DATABASE_URL, ANTHROPIC_API_KEY, KROGER_CLIENT_ID, KROGER_CLIENT_SECRET and
# EXPO_PUSH_ACCESS_TOKEN come from the host's secret store at run time.
FROM node:22.23.4-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile --filter "@mp/shopper-worker..."

FROM deps AS run
ENV NODE_ENV=production
# The release Sentry tags every event with (WS15): the git SHA the image was built from.
#   docker build --build-arg GIT_SHA="$(git rev-parse HEAD)" ...
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
WORKDIR /app/services/shopper-worker
USER node
# tsx runs the TypeScript sources as the dev script does; SIGTERM reaches node directly, and the
# worker hands in-flight runs back and exits within 10 seconds.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
