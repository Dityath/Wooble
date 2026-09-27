FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/web build

FROM oven/bun:1.3.14 AS api
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3001
CMD ["bun", "apps/api/src/index.ts"]

FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
EXPOSE 80
