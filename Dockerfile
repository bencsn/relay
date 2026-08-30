# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json bunfig.toml ./
COPY apps apps
COPY packages packages
RUN bun install --frozen-lockfile
RUN bun build apps/api/src/index.ts --target=bun --outfile=dist/relay-api.js

FROM oven/bun:1.4.0-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=bun:bun /app/dist/relay-api.js ./relay-api.js
COPY --chown=bun:bun migrations ./migrations
USER bun
EXPOSE 8787
ENTRYPOINT ["bun", "run", "./relay-api.js"]
