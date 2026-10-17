# Reconix egress proxy image.
#
# BUILD CONTEXT IS THE REPO ROOT (see docker-compose.yml: build.context: .),
# because the proxy imports the SINGLE source-of-truth scope compiler from
# src/main/scope.ts and the frozen types from src/shared/scope.ts. Keeping one
# compiler means the proxy and the per-tool checker can never drift apart.
#
# Base image is pinned by tag AND digest in VERSIONS.lock. Replace the digest
# below with the verified one before production.
FROM node:22.11.0-alpine3.20@sha256:REPLACE_WITH_VERIFIED_NODE_DIGEST AS runtime

WORKDIR /app

# Proxy runtime deps (tsx only).
COPY infra/proxy/package.json infra/proxy/package.json
RUN cd infra/proxy && npm install --omit=dev --no-audit --no-fund

# The one source of truth: shared types + the scope compiler/matcher.
COPY src/shared/scope.ts src/shared/scope.ts
COPY src/main/scope.ts src/main/scope.ts
COPY infra/proxy/server.ts infra/proxy/server.ts

# Non-root.
USER node

ENV SCOPE_CONFIG_PATH=/etc/reconix/scope.json \
    PROXY_LISTEN_HOST=0.0.0.0 \
    PROXY_LISTEN_PORT=8888 \
    SAFE_TO_POUND=false

EXPOSE 8888

CMD ["./infra/proxy/node_modules/.bin/tsx", "infra/proxy/server.ts"]
