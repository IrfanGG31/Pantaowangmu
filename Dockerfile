# One Railway service: Express API + Mini App static build + Telegram bot (polling).
# The legacy root package.json (api/, bot/) is intentionally never installed.

FROM node:22-bookworm-slim AS webapp
WORKDIR /app/webapp
COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci
COPY webapp/ ./
# The Mini App must call the same-origin "/api"; VITE_API_URL and VITE_DEV_USER_ID are never set here.
RUN npm run build

FROM node:22-bookworm-slim AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY --from=webapp /app/webapp/build /app/webapp/build
# Runs as root: Railway volumes (/data) are mounted root-owned.
CMD ["node", "src/index.js"]
