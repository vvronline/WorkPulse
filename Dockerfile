# Stage 1: Build the React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Setup the Express backend & Serve
FROM node:20-alpine
WORKDIR /app/server

# Install dumb-init for proper PID 1 signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY server/ ./

# Copy built React files from the builder stage
COPY --from=frontend-builder /app/client/dist /app/client/dist

# Create uploads directory owned by appuser
RUN mkdir -p /app/server/uploads/avatars && chown -R appuser:appgroup /app/server/uploads

# Switch to non-root user
USER appuser

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
