# Stage 1: Build the React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Compile the TypeScript backend
FROM node:20-alpine AS backend-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# Stage 3: Setup the Express backend & Serve
FROM node:20-alpine
WORKDIR /app/server

# Install dumb-init for PID 1 signal handling and su-exec for privilege drop
RUN apk add --no-cache dumb-init su-exec

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY server/package*.json ./
RUN npm ci --omit=dev

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

# Create uploads directory so it exists even without a volume mount
RUN mkdir -p /app/server/uploads/avatars && chown -R appuser:appgroup /app/server/uploads

# Do NOT switch to appuser here — entrypoint.sh handles the privilege drop
# so it can fix volume mount ownership at runtime before starting the app

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["sh", "-c", "node migrate.js && node index.js"]
