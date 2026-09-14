FROM node:22-bookworm-slim AS base
WORKDIR /app
COPY package.json ./
COPY docker/pnpm-lock.yaml ./pnpm-lock.yaml
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate && pnpm install --frozen-lockfile --prod
COPY bin ./bin
COPY src ./src
COPY web ./web
FROM base AS test
COPY test ./test
RUN node --test test/*.test.mjs
FROM base AS runtime
RUN mkdir /state && chown node:node /state
USER node
CMD ["node", "/app/src/server.mjs"]
