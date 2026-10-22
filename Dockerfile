FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS base
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
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
