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

# Install Python & build tools for building SQLite3 bindings on Alpine
RUN apk update && apk add --no-cache python3 make g++ 

COPY server/package*.json ./
RUN npm ci --omit=dev

# Rebuild better-sqlite3 specifically for the Alpine architecture
RUN npm rebuild better-sqlite3 --build-from-source

COPY server/ ./
# Copy built React files from the builder stage
COPY --from=frontend-builder /app/client/dist /app/client/dist

# Expose the API port
EXPOSE 5000

# Set environment variables for production execution
ENV NODE_ENV=production
ENV PORT=5000

# We use node directly instead of pm2 for Docker
CMD ["node", "index.js"]
