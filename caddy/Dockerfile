# syntax=docker/dockerfile:1

# https://hub.docker.com/_/caddy/tags
# https://github.com/mholt/caddy-ratelimit/tags

FROM caddy:2.11.4-builder AS builder

RUN --mount=type=cache,target=/go/pkg/mod \
  --mount=type=cache,target=/root/.cache/go-build \
  xcaddy build \
  --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2.11.4-alpine AS runner
COPY --from=builder /usr/bin/caddy /usr/bin/caddy