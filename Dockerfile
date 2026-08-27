# Stage 1: Build the React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --cache /tmp/npm-cache-frontend
COPY client/ ./
RUN npm run build

# Stage 2: Compile the TypeScript backend
FROM node:20-alpine AS backend-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --cache /tmp/npm-cache-backend
COPY server/ ./
RUN npm run build

# Stage 3: Setup the Express backend & Serve
FROM node:20-alpine
WORKDIR /app/server

# dumb-init handles PID 1 signal forwarding (so SIGTERM reaches Node and the
# graceful shutdown runs). su-exec is no longer needed: A3 removed the volume,
# so there is no root-owned mount to chown before dropping privileges.
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY server/package*.json ./
RUN npm ci --omit=dev --cache /tmp/npm-cache-runtime

# Copy compiled JS output from the backend builder stage.
# The dist/ *contents* are flattened into /app/server so that index.js sits at
# /app/server/index.js. This matches the __dirname-relative paths in the code
# (client static files at /app/client/dist, uploads at /app/server/uploads).
COPY --from=backend-builder /app/server/dist ./

# Copy built React files from the builder stage
COPY --from=frontend-builder /app/client/dist /app/client/dist

# Copy entrypoint script (runs as root, fixes volume permissions, drops to appuser)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# A3: uploads live in Cloudflare R2, so no volume is mounted here.
# This directory only backs STORAGE_DRIVER=local (development); in production
# it stays empty. Owned by appuser at build time, so no runtime chown is needed.
RUN mkdir -p /app/server/uploads && chown -R appuser:appgroup /app/server/uploads

# The container is now stateless — there is no root-owned volume to fix up, so
# we can drop privileges at build time instead of doing it in the entrypoint.
USER appuser

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.js"]
