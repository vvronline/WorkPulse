# WorkPulse Deployment Guide

Complete guide to deploy WorkPulse on a Google Cloud Platform (GCP) VM or any Ubuntu server.

---

## Prerequisites

- **GCP VM:** Ubuntu 22.04 LTS (or newer)
- **Firewall:** Ensure **"Allow HTTP Traffic"** is checked in your VM settings
  - GCP Console → Compute Engine → VM Instances → Click your VM → Edit → Firewalls → Check **"Allow HTTP traffic"** → Save
- **SSH Access:** You must be able to SSH into the VM

---

## Method 1: Docker Deployment (Recommended)

### Step 1: Install Docker

SSH into your VM and install Docker:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install git docker.io -y
```

> **Note:** Modern Ubuntu ships with Docker Compose v2 built into Docker (`docker compose` with a space). The legacy `docker-compose` (hyphenated) command is no longer needed.

Add your user to the `docker` group so you don't need `sudo` for every Docker command:

```bash
sudo usermod -aG docker $USER
```

**Log out and SSH back in** for the group change to take effect:

```bash
exit
# SSH back in
```

Verify Docker works without sudo:

```bash
docker --version
docker compose version
```

### Step 2: Clone & Configure

```bash
git clone https://github.com/vvronline/WorkPulse.git
cd WorkPulse
```

Create your environment file:

```bash
nano .env
```

Paste this (replace `YOUR_SUPER_SECRET_KEY` with a strong random string):

```env
JWT_SECRET=YOUR_SUPER_SECRET_KEY
```

> **Note:** `CORS_ORIGIN` does not need to be set for Docker deployments. The app automatically allows same-origin requests in production since the SPA and API are served from the same Express server.

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

### Step 3: Build & Deploy

```bash
# Build the Docker image (first build takes ~5-10 minutes)
docker compose build

# Start the container in detached mode
docker compose up -d
```

### Step 4: Verify Deployment

```bash
# Check the container is running
docker compose ps

# Test the app responds
curl -s -o /dev/null -w "%{http_code}" http://localhost:80
# Should print: 200

# Check logs if something is wrong
docker compose logs --tail=30
```

Your app is now live at `http://YOUR_VM_IP`!

### Step 5: Create Your First Account

1. Open `http://YOUR_VM_IP` in your browser
2. Click **Register** and create your account
3. Back in the VM terminal, promote yourself to Super Admin:

```bash
docker compose exec workpulse sh -c "apk add --no-cache sqlite && sqlite3 /app/server/data/attendance.db \"UPDATE users SET role = 'super_admin' WHERE username = 'YOUR_USERNAME';\""
```

*(Replace `YOUR_USERNAME` with the username you just registered.)*

4. Log out and log back in — you'll now have the **Admin** tab

### Updating the App

```bash
cd ~/WorkPulse
git pull

# If only server code changed (fast — uses cached layers):
docker compose build
docker compose up -d

# If dependencies or Dockerfile changed (full rebuild):
docker compose build --no-cache
docker compose up -d
```

### Useful Docker Commands

```bash
# View live logs
docker compose logs -f --tail=50

# Restart the container
docker compose restart

# Stop the container
docker compose down

# Stop and remove everything (including images)
docker compose down --rmi all
```

---

## Method 2: Manual Deployment (PM2 + Nginx)

*Use this only if you cannot use Docker.*

### Step 1: Install Dependencies

SSH into your VM and install Node.js, Nginx, Git, and PM2:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install git nginx -y

# Install Node.js v20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally
sudo npm install -g pm2
```

### Step 2: Clone the Repository

```bash
cd ~
git clone https://github.com/vvronline/WorkPulse.git
cd WorkPulse
```

### Step 3: Backend Setup

```bash
cd ~/WorkPulse/server
npm install
nano .env
```

Paste the following (replace `YOUR_VM_EXTERNAL_IP` with your actual IP, e.g., `34.31.27.200`):

```env
PORT=5000
JWT_SECRET=your_super_secret_jwt_key_here
CORS_ORIGIN=http://YOUR_VM_EXTERNAL_IP
NODE_ENV=production
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

Start the backend:

```bash
sudo pm2 start index.js --name workpulse
sudo pm2 save
sudo pm2 startup
```

### Step 4: Frontend Build

```bash
cd ~/WorkPulse/client
npm install
npm run build
```

*This generates optimized static files in `~/WorkPulse/client/dist`.*

### Step 5: Nginx Configuration

```bash
sudo nano /etc/nginx/sites-available/workpulse
```

Paste this configuration (replace `YOUR_VM_EXTERNAL_IP` and `YOUR_USERNAME`):

```nginx
server {
    listen 80;
    server_name YOUR_VM_EXTERNAL_IP;
    client_max_body_size 10M;

    root /home/YOUR_USERNAME/WorkPulse/client/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://localhost:5000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /uploads/ {
        alias /home/YOUR_USERNAME/WorkPulse/server/uploads/;
        access_log off;
        expires 30d;
    }
}
```

Enable the config and restart Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/workpulse /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

### Step 6: Initial Access & Admin Setup

1. Open `http://YOUR_VM_EXTERNAL_IP` in your browser
2. Click **Register** and create your first account
3. Promote yourself to Super Admin:

```bash
cd ~/WorkPulse/server
sqlite3 attendance.db "UPDATE users SET role = 'super_admin' WHERE username = 'YOUR_USERNAME';"
```

4. Log out and log back in — the **Admin** tab is now visible

---

## Troubleshooting

### GCP Firewall / `ERR_CONNECTION_TIMED_OUT`
If the browser can't reach your VM at all, the GCP firewall is blocking port 80.
- Go to **GCP Console** → **Compute Engine** → **VM Instances**
- Click your VM → **Edit** → scroll to **Firewalls** → check **"Allow HTTP traffic"** → **Save**

Verify from the VM:
```bash
# Docker method
docker compose ps
curl -s -o /dev/null -w "%{http_code}" http://localhost:80

# Check if port 80 is listening
ss -tlnp | grep :80
```

### Container Crash Loop (Docker)
If `docker compose ps` shows `Restarting`, check logs:
```bash
docker compose logs --tail=30
```
Common causes:
- **`ReferenceError: Database is not defined`** — Missing `better-sqlite3` require in `db.js`
- **`JWT_SECRET is not set`** — Create a `.env` file with `JWT_SECRET=your_key`

### 401 Unauthorized After Login
If login appears to succeed but all API calls return 401, the JWT cookie isn't being stored.
- **Cause:** The `Secure` cookie flag is set but the site uses HTTP (not HTTPS).
- **Fix:** The app uses `USE_HTTPS=true` env var to enable secure cookies. Don't set this unless you have HTTPS configured.

### Registration Shows "Closed"
If you see "Registration Closed" on a fresh deployment with an existing database:
```bash
# Docker method
docker compose exec workpulse sh -c "apk add --no-cache sqlite && sqlite3 /app/server/data/attendance.db \"UPDATE app_settings SET value = 'open' WHERE key = 'registration_mode';\""

# PM2 method
sqlite3 ~/WorkPulse/server/attendance.db "UPDATE app_settings SET value = 'open' WHERE key = 'registration_mode';"
```

### 500 Internal Server Error on Login (PM2 method)
Double check that `CORS_ORIGIN` in your `.env` file exactly matches the URL in the browser (e.g., `http://34.31.27.200`). Then restart:
```bash
sudo pm2 restart workpulse --update-env
```

### Blank White Screen / MIME Type Errors
- **Docker:** Check container logs — the Vite build may have failed
- **PM2 + Nginx:** Ensure the `root` directive in Nginx points to the correct absolute path, and that `npm run build` completed successfully in the `client/` directory

### `sudo` Not Working / "I'm sorry... I'm afraid I can't do that"
If `sudo-rs` blocks your commands, check if you're in the `docker` group:
```bash
groups
```
If you see `docker` in the output, you can run Docker commands **without sudo**:
```bash
docker compose build
docker compose up -d
```

### HTTPS Setup (Optional)
To enable HTTPS, set up a reverse proxy (e.g., Nginx or Caddy) with SSL certificates, then add to your `.env`:
```env
USE_HTTPS=true
```
This enables the `Secure` flag on authentication cookies.
