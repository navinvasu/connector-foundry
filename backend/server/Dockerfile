# Multi-stage build for the Connector Foundry backend API.
# Produces a small production image that runs `node dist/index.js` on port 4000.
# The schema (schema/schema.sql) is applied on boot, so it ships in the image.
# Health check: GET /health. The lite host (IN-10) is arm64:
#   docker buildx build --platform linux/arm64 -t <ecr-repo>:<tag> --push .

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY schema ./schema

EXPOSE 4000
USER node
CMD ["node", "dist/index.js"]
