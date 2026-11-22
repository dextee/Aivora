# AIVORA MAIN-FIX — production container for Google Cloud Run (or any Docker host).
# Multi-stage: build the Vite client, then ship a slim Node 22 runtime.
# No secrets are baked in; supply them as environment variables at deploy time.

# ---------- Stage 1: build the client (dist/) ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    AIVORA_MEMORY_MODE=1
WORKDIR /app

# Runtime dependencies only (ws, @supabase/supabase-js, exceljs, qrcode). Pure JS — no native builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Server + built client + read-only reference data.
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
COPY --from=build /app/odai/config ./odai/config
COPY --from=build /app/odai/data ./odai/data
COPY --from=build /app/odai/contracts ./odai/contracts
COPY --from=build /app/odai/fixtures ./odai/fixtures

# Writable runtime stores (EPHEMERAL on Cloud Run — see runbook for durable Supabase path).
RUN mkdir -p odai/appointments odai/inbox odai/campaigns odai/uploads odai/data/business logs \
    && chown -R node:node /app
USER node

EXPOSE 8080
# Cloud Run injects PORT; HOST is fixed to 0.0.0.0 above. server.mjs reads both.
CMD ["node", "server.mjs"]