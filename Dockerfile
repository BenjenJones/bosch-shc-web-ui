# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Build stage: full deps (incl. tailwindcss devDep) to compile the CSS that
# is gitignored and therefore not shipped in the repo.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:css

# ---------------------------------------------------------------------------
# Runtime stage: production deps only + openssl (needed by setup.js to
# generate the client certificate during pairing).
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
# All runtime-writable state (config.json, auth.json, certs/, message archive)
# lives here so it survives container restarts / image updates on a volume.
ENV BOSCH_SHC_DATA_DIR=/data

COPY package*.json ./
RUN npm ci --omit=dev
# App source + the CSS compiled in the build stage.
COPY . .
COPY --from=build /app/public/tailwind.css ./public/tailwind.css

RUN mkdir -p /data
VOLUME /data
EXPOSE 3000

# node directly, not `npm start` — avoids the prestart build:css hook (no
# tailwindcss in the production image; the CSS is already built and copied in).
CMD ["node", "server.js"]
