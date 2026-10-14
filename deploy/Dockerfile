# Keep these immutable multi-platform index digests aligned with docs/versioning.md.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile \
    && bun scripts/third-party-notices.ts /app/THIRD_PARTY_NOTICES.txt \
    && bun run --cwd apps/web build

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS api
ARG WOOBLE_VERSION=0.0.0-dev
ARG WOOBLE_REVISION=unknown
LABEL org.opencontainers.image.title="Wooble API" \
      org.opencontainers.image.version="$WOOBLE_VERSION" \
      org.opencontainers.image.revision="$WOOBLE_REVISION" \
      org.opencontainers.image.licenses="Unlicense"
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
COPY --from=build --chown=bun:bun /app/THIRD_PARTY_NOTICES.txt /usr/share/doc/wooble/THIRD_PARTY_NOTICES.txt
USER bun
EXPOSE 3001
CMD ["bun", "apps/api/src/index.ts"]

FROM caddy:2.11.6-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS web
ARG WOOBLE_VERSION=0.0.0-dev
ARG WOOBLE_REVISION=unknown
LABEL org.opencontainers.image.title="Wooble web" \
      org.opencontainers.image.version="$WOOBLE_VERSION" \
      org.opencontainers.image.revision="$WOOBLE_REVISION" \
      org.opencontainers.image.licenses="Unlicense"
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
COPY --from=build /app/THIRD_PARTY_NOTICES.txt /usr/share/doc/wooble/THIRD_PARTY_NOTICES.txt
EXPOSE 80 443 443/udp
