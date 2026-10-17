# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Build stage: full deps (incl. tailwindcss devDep) to compile the CSS that
# is gitignored and therefore not shipped in the repo.
# Pinned to $BUILDPLATFORM (the runner's native arch) so multi-arch builds
# don't run `npm ci` under QEMU — the dev deps pull arch-specific native
# binaries (esbuild/oxc/lightningcss) that fail to install under arm emulation.
# The compiled CSS is plain text and arch-independent, so building it once on
# the host and copying it into each per-arch runtime is correct.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:css

# ---------------------------------------------------------------------------
# Runtime stage: production deps only. No openssl needed — the client
# certificate for pairing is generated in Node (selfsigned-cert.js).
# ---------------------------------------------------------------------------
FROM node:26-alpine AS runtime
# OCI metadata: GHCR shows the description and links the package to the repo.
LABEL org.opencontainers.image.title="Bosch SHC Web UI" \
      org.opencontainers.image.description="Local web UI and dashboard for the Bosch Smart Home Controller (SHC I/II): history charts, energy costs, device health. No cloud." \
      org.opencontainers.image.source="https://github.com/BenjenJones/bosch-shc-web-ui" \
      org.opencontainers.image.url="https://github.com/BenjenJones/bosch-shc-web-ui" \
      org.opencontainers.image.documentation="https://github.com/BenjenJones/bosch-shc-web-ui/blob/main/docs/INSTALL.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Ben Herfurth"
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
