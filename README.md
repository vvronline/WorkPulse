# WorkPulse

An enterprise-grade web application for tracking employee attendance, managing daily tasks, and calculating floor hours.

## Features

### Attendance & Time Tracking
- **Clock In/Out**: Mark when you start and end your workday. Work mode selection (Office/Remote).
- **Break Tracking**: Accurately log breaks when leaving the floor to maintain exact working hours.
- **Live Timer**: Real-time floor time counter and progress towards your daily 8-Hour Target.
- **Analytics Dashboard**: Weekly trends, punctuality percentage, and average floor times.
- **Manual Time Entry**: Add missed days or correct time logs manually.
- **Leave Management**: Apply for leaves (Sick, Holiday, Personal) and view monthly leave quotas.

### Task Management (Kanban)
- **Daily Tasks**: Create, edit, and organize to-do items on a drag-and-drop Kanban board.
- **Carry Forward**: Automatically or manually carry forward incomplete tasks from yesterday.
- **Priority & Rich Text**: Set High/Medium/Low priorities and write detailed formatted descriptions.
- **Subtasks & Checklists**: Break down complex tasks into checkable sub-items.
- **File Attachments**: Upload and manage files directly on task cards.
- **Activity Log & Comments**: Track task status changes chronologically and discuss progress with comments.

### User Experience
- **Enterprise Theme**: Sleek Navy Blue & Slate color scheme tailored for professional environments.
- **Custom Profiles**: Upload profile avatars and manage account credentials.
- **Security**: HttpOnly HTTP cookies for JWT authentication, preventing XSS attacks.

---

## Getting Started (Local Development via Docker)

The recommended way to run WorkPulse locally is through Docker Compose, which handles PostgreSQL automatically.

> **Note:** The files below are gitignored and must be created manually. They are never committed to keep your production configuration safe.

### 1. Create Dev Config Files

**`.env.dev`** (in the project root):
```env
DB_PASSWORD=devpassword123
JWT_SECRET=local-dev-jwt-secret-change-me
CORS_ORIGIN=http://localhost
```

**`Caddyfile.dev`** (in the project root):
```
localhost {
    @ws { path /ws }
    reverse_proxy @ws workpulse-dev:5000
    reverse_proxy workpulse-dev:5000
    tls internal
}
```

**`docker-compose.dev.yml`** (in the project root):
```yaml
services:
  postgres-dev:
    image: postgres:16
    container_name: workpulse-postgres-dev
    restart: unless-stopped
    environment:
      POSTGRES_DB: workpulse_dev
      POSTGRES_USER: workpulse
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - ./data/postgres-dev:/var/lib/postgresql/data
    networks: [workpulse-dev]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U workpulse -d workpulse_dev"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s

  workpulse-dev:
    build: .
    container_name: workpulse-app-dev
    restart: unless-stopped
    depends_on:
      postgres-dev:
        condition: service_healthy
    expose: ["5000"]
    environment:
      - PORT=5000
      - NODE_ENV=development
      - USE_HTTPS=false
      - DATABASE_URL=postgresql://workpulse:${DB_PASSWORD}@postgres-dev:5432/workpulse_dev
      - JWT_SECRET=${JWT_SECRET}
      - CORS_ORIGIN=${CORS_ORIGIN:-http://localhost}
    volumes:
      - ./server/uploads:/app/server/uploads
    networks: [workpulse-dev]

  caddy-dev:
    image: caddy:2-alpine
    container_name: workpulse-caddy-dev
    restart: unless-stopped
    depends_on: [workpulse-dev]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile.dev:/etc/caddy/Caddyfile:ro
      - caddy_dev_data:/data
      - caddy_dev_config:/config
    networks: [workpulse-dev]

volumes:
  caddy_dev_data:
  caddy_dev_config:

networks:
  workpulse-dev:
    driver: bridge
```

### 2. Start the Application

```bash
docker-compose -f docker-compose.dev.yml --env-file .env.dev up -d --build
```

The app will be available at **https://localhost** (self-signed cert via Caddy).

### 3. Stop the Application

```bash
docker-compose -f docker-compose.dev.yml down
```

---

## Production Deployment (Railway)

WorkPulse is deployed on [Railway](https://railway.com) — a managed platform that handles PostgreSQL, HTTPS, persistent storage, and auto-deploys on every push to `master`.

See the full step-by-step guide in [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md).

**Quick summary:**
1. Create a Railway project → add PostgreSQL plugin → add app service from GitHub repo
2. Set env vars: `JWT_SECRET`, `NODE_ENV=production`, `PORT=5000`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`
3. Set health check path to `/api/health` and port to `5000`
4. Add a persistent volume at `/app/server/uploads` (Hobby plan+)
5. Generate a domain — Railway handles HTTPS automatically
6. Push to `master` to deploy
