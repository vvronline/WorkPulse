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

## Production Deployment (GCP / Ubuntu VM)

To deploy WorkPulse to a production environment (like Google Cloud), you need to serve the frontend via Nginx and run the backend via PM2 to ensure they share the same origin port.

### 1. Build the Frontend
```bash
cd client
npm install
npm run build
```

### 2. Configure Backend `.env`
Ensure your server `.env` aligns with the domain/IP to appease `SameSite` browser cookie policies:
```env
PORT=5000
JWT_SECRET=your_super_secret_key
CORS_ORIGIN=http://YOUR_SERVER_IP
```

### 3. Start Backend with PM2
```bash
cd server
npm install
npm install -g pm2
pm2 start index.js --name "workpulse-api"
pm2 save
pm2 startup
```

### 4. Nginx Reverse Proxy Configuration
Install Nginx (`sudo apt install nginx`) and set up the default site (`/etc/nginx/sites-available/default`) to map everything to Port 80:

```nginx
server {
    listen 80;
    server_name YOUR_SERVER_IP_OR_DOMAIN;
    client_max_body_size 10M;

    # 1. API Pass-through to Express Server
    location /api/ {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;           
        proxy_cache_bypass $http_upgrade;
    }

    # 2. Serve static User Uploads (Avatars, Tasks)
    location /uploads/ {
        alias /path/to/your/WorkPulse/server/uploads/;
        access_log off;
        expires 30d;
    }

    # 3. Serve Frontend React App (Fallback routing)
    location / {
        root /path/to/your/WorkPulse/client/dist;
        index index.html index.htm index.nginx-debian.html;
        try_files $uri $uri/ /index.html;
    }
}
```

Make sure the Nginx `www-data` user has permission to read the uploaded files:
```bash
sudo chmod -R 755 /path/to/your/WorkPulse/server/uploads
sudo chmod +x /path/to/your/WorkPulse   # Ensure parent path access
sudo systemctl restart nginx
```

---

## Docker Deployment (Recommended)

WorkPulse includes a multi-stage `Dockerfile` and a `docker-compose.yml` file for simple, containerized deployment without needing to manually install Node.js, PM2, or Nginx on your host machine.

### Prerequisites
- Docker and Docker Compose installed on your server or local machine.

### 1. Configure Environment
Create an `.env` file in the root directory (next to `docker-compose.yml`) to define your configuration:
```env
JWT_SECRET=your_super_secret_jwt_key_here
CORS_ORIGIN=http://your-server-ip-or-domain
```

### 2. Start the Application
Run the following command to build the React frontend, set up the backend container, and start the application in the background:
```bash
docker-compose up -d --build
```

The application will now be running on port `5000`. 
*Note: The SQLite database (`server/attendance.db`) and user uploads are automatically volume-mounted so data is preserved if the container restarts or updates.*
