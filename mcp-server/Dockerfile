# syntax=docker/dockerfile:1

# Gantry MCP server (docs/adr/0043) — a separate, independently-deployed service. Verified the same
# way the main gantry ContainerFile is: a test stage runs on every build, and the runtime image is
# only ever built from source that has already passed it.

FROM node:24-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS source
COPY src/ src/
COPY test/ test/

FROM source AS test
RUN npm test

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=test /app/src/ src/
EXPOSE 3100
CMD ["node", "src/index.js"]
