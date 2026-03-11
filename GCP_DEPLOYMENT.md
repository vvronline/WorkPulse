# WorkPulse — Enterprise GCP Deployment Guide

Production-grade deployment on Google Cloud Platform with security hardening, data persistence, automated backups, and HTTPS.

---

## Architecture Overview

```
Internet
   │
   ▼ (HTTPS :443 / HTTP :80)
┌────────────────────────────┐
│   GCP VM (Ubuntu 24.04)    │
│                            │
│  ┌──────────────────────┐  │
│  │  Docker Network      │  │
│  │  (internal bridge)   │  │
│  │                      │  │
│  │  ┌────────────────┐  │  │
│  │  │ workpulse-app  │  │  │ ← Express + React SPA
│  │  │   :5000 → :80  │  │  │
│  │  └───────┬────────┘  │  │
│  │          │            │  │
│  │  ┌───────▼────────┐  │  │
│  │  │   PostgreSQL   │  │  │ ← No external port
│  │  │     :5432      │  │  │
│  │  └───────┬────────┘  │  │
│  └──────────┼────────────┘  │
│             │               │
│    ./data/postgres/         │ ← Persistent disk mount
│    ./server/uploads/        │ ← Avatar storage
└────────────────────────────┘
         │
         ▼ (daily cron)
   GCS Backup Bucket
```

**Security features:**
- PostgreSQL is **not exposed** to the internet (no port mapping)
- App container runs as **non-root user**
- Proper PID 1 signal handling (dumb-init)
- Strong passwords via `.env` (not hardcoded)
- `JWT_SECRET` is required (no fallback default)
- Health checks with dependency ordering
- GCP firewall with minimal open ports
- Static IP to prevent address drift
- Automated daily database backups

---

## Prerequisites

- A GCP account with billing enabled
- `gcloud` CLI installed locally (or use GCP Cloud Shell)

---

## Step 1: Reserve a Static IP

Reserve an IP **before** creating the VM so it never changes:

```bash
gcloud compute addresses create workpulse-ip \
  --region=us-central1

# Note the IP address
gcloud compute addresses describe workpulse-ip \
  --region=us-central1 --format="get(address)"
```

Save this IP (e.g., `34.132.137.32`) — you'll use it throughout.

---

## Step 2: Create Firewall Rules

Create dedicated rules instead of relying on defaults:

```bash
# Allow HTTP (port 80)
gcloud compute firewall-rules create workpulse-allow-http \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:80 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=workpulse-server \
  --description="Allow HTTP traffic to WorkPulse"

# Allow HTTPS (port 443) — for future TLS setup
gcloud compute firewall-rules create workpulse-allow-https \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:443 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=workpulse-server \
  --description="Allow HTTPS traffic to WorkPulse"

# Allow SSH (port 22) — restrict to your IP for security
gcloud compute firewall-rules create workpulse-allow-ssh \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:22 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=workpulse-server \
  --description="Allow SSH to WorkPulse VM"
```

> **Tip:** Replace `0.0.0.0/0` in the SSH rule with your office IP (e.g., `203.0.113.50/32`) for better security.

---

## Step 3: Create the VM

```bash
gcloud compute instances create workpulse \
  --zone=us-central1-a \
  --machine-type=e2-medium \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB \
  --boot-disk-type=pd-balanced \
  --tags=workpulse-server \
  --address=workpulse-ip \
  --scopes=storage-rw \
  --metadata=startup-script='#!/bin/bash
    apt-get update -y
    apt-get install -y docker.io
    systemctl enable docker
    systemctl start docker
    usermod -aG docker $(ls /home/ | head -1)'
```

> **Note:** `e2-medium` (2 vCPU, 4GB RAM) is the most cost-effective option for running both the app and database. `--scopes=storage-rw` enables GCS access for automated backups. The startup script pre-installs Docker.

Wait ~2 minutes for the VM to boot, then SSH in:

```bash
gcloud compute ssh workpulse --zone=us-central1-a
```

---

## Step 4: Install Docker Compose, Verify & Clone

```bash
# Add your user to the docker group
sudo usermod -aG docker $USER

# Log out and back in to apply the group change
exit
gcloud compute ssh workpulse --zone=us-central1-a

# Verify Docker works without sudo
docker --version
docker ps

# Install docker-compose (Ubuntu 24.04 ships docker.io but not the compose plugin)
sudo apt install -y docker-compose
docker-compose --version

# Clone the repository
git clone https://github.com/vvronline/WorkPulse.git
cd WorkPulse
```

> **Note:** On Ubuntu 24.04 with `docker.io`, use `docker-compose` (hyphenated) instead of `docker compose` (space). If `docker ps` gives a permission error, you haven't re-logged after the `usermod` — run `exit` and SSH back in.

---

## Step 5: Configure Environment

Generate strong secrets and create the `.env` file:

```bash
cd ~/WorkPulse

# Generate random secrets
JWT_SECRET=$(openssl rand -base64 48)
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

cat > .env << EOF
JWT_SECRET=${JWT_SECRET}
DB_PASSWORD=${DB_PASSWORD}
EOF

# Lock down permissions (owner read-only)
chmod 600 .env

# Verify
cat .env
```

> **Important:** Save these values somewhere secure (password manager). If you lose `JWT_SECRET`, all user sessions will be invalidated. If you lose `DB_PASSWORD`, you'll need to reset the PostgreSQL password manually.

### Prepare directories

Create the uploads directory and `.dockerignore` before building:

```bash
# Create uploads directory (needed because Docker volume mount overrides container permissions)
mkdir -p ~/WorkPulse/server/uploads/avatars

# Exclude postgres data from Docker build context
echo "data/" >> .dockerignore
```

---

## Step 6: Build & Deploy

```bash
cd ~/WorkPulse

# Build (first build takes ~2-5 minutes)
docker-compose build

# Start
docker-compose up -d

# Verify both containers are healthy
docker-compose ps
```

Expected output:
```
       Name                     Command                 State                      Ports
--------------------------------------------------------------------------------------------------------
workpulse-app        dumb-init -- node index.js      Up             0.0.0.0:80->5000/tcp,:::80->5000/tcp
workpulse-postgres   docker-entrypoint.sh postgres   Up (healthy)   5432/tcp
```

Note: PostgreSQL shows `5432/tcp` but **no** `0.0.0.0:5432->` — it's only accessible inside the Docker network.

Test:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:80
# Should print: 200
```

Your app is live at `http://34.132.137.32`

---

## Step 7: Create Your First Account

1. Open `http://34.132.137.32` in your browser
2. Click **Register** and create your account
3. Promote yourself to Super Admin:

```bash
cd ~/WorkPulse
docker-compose exec postgres psql -U workpulse -d workpulse \
  -c "UPDATE users SET role = 'super_admin' WHERE username = 'YOUR_USERNAME';"
```

4. Log out and log back in — you'll now have the **Admin** tab

---

## Step 8: Set Up Automated Backups

### Create a GCS Bucket

```bash
# Create bucket (name must be globally unique)
gcloud storage buckets create gs://workpulse-backups-$(gcloud config get-value project) \
  --location=us-central1 \
  --default-storage-class=NEARLINE \
  --uniform-bucket-level-access

# Set lifecycle: auto-delete backups older than 90 days
cat > /tmp/lifecycle.json << 'EOF'
{
  "rule": [{
    "action": {"type": "Delete"},
    "condition": {"age": 90}
  }]
}
EOF
gcloud storage buckets update gs://workpulse-backups-$(gcloud config get-value project) \
  --lifecycle-file=/tmp/lifecycle.json
```

### Create Backup Script

```bash
cat > ~/WorkPulse/backup.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail

TIMESTAMP=$(date +%F_%H%M)
BACKUP_FILE="/tmp/workpulse-backup-${TIMESTAMP}.sql.gz"
BUCKET="gs://workpulse-backups-$(gcloud config get-value project 2>/dev/null)"

echo "[$(date)] Starting backup..."

# Dump database and compress
docker-compose -f ~/WorkPulse/docker-compose.yml exec -T postgres \
  pg_dump -U workpulse --clean --if-exists workpulse | gzip > "${BACKUP_FILE}"

# Upload to GCS
gcloud storage cp "${BACKUP_FILE}" "${BUCKET}/daily/${TIMESTAMP}.sql.gz"

# Clean up local file
rm -f "${BACKUP_FILE}"

echo "[$(date)] Backup uploaded to ${BUCKET}/daily/${TIMESTAMP}.sql.gz"
SCRIPT

chmod +x ~/WorkPulse/backup.sh

# Test it
~/WorkPulse/backup.sh
```

### Schedule Daily Backup (2 AM UTC)

```bash
(crontab -l 2>/dev/null; echo "0 2 * * * ~/WorkPulse/backup.sh >> ~/WorkPulse/backup.log 2>&1") | crontab -

# Verify
crontab -l
```

### Restore from Backup

```bash
# List available backups
gcloud storage ls gs://workpulse-backups-$(gcloud config get-value project)/daily/

# Download and restore a specific backup
gcloud storage cp gs://BUCKET/daily/2026-03-11_0200.sql.gz /tmp/restore.sql.gz
gunzip /tmp/restore.sql.gz
cat /tmp/restore.sql | docker-compose exec -T postgres psql -U workpulse -d workpulse
```

---

## Updating the App

```bash
cd ~/WorkPulse

# Back up before updating
./backup.sh

# Pull latest code
git pull

# Rebuild and restart (zero-downtime for the database)
docker-compose build --no-cache
docker-compose down
docker-compose up -d
```

> **Note:** Use `docker-compose down` then `up -d` instead of `restart` when environment variables in `.env` have changed — `restart` does not reload env vars.

---

## Useful Commands

```bash
# View live logs
docker-compose logs -f --tail=50

# View only app logs
docker-compose logs -f workpulse --tail=30

# Restart containers
docker-compose restart

# Stop and recreate containers (needed when .env changes)
docker-compose down
docker-compose up -d

# Check database size
docker-compose exec postgres psql -U workpulse -d workpulse \
  -c "SELECT pg_size_pretty(pg_database_size('workpulse'));"

# Interactive database shell
docker-compose exec postgres psql -U workpulse -d workpulse
```

> **⚠️ Data Safety:** Your PostgreSQL data is in `~/WorkPulse/data/postgres/`. Never delete this directory. Automated backups go to GCS daily with 90-day retention.

---

## Optional: HTTPS with Let's Encrypt

If you have a domain name pointing to your static IP:

```bash
# Install Certbot
sudo apt install -y certbot

# Get certificate (stop the app briefly)
docker-compose down
sudo certbot certonly --standalone -d yourdomain.com

# Copy certs to project
mkdir -p ~/WorkPulse/certs
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem ~/WorkPulse/certs/
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem ~/WorkPulse/certs/
sudo chown $USER:$USER ~/WorkPulse/certs/*

# Start the app again
docker-compose up -d
```

Then add an Nginx reverse proxy or update the Docker compose to mount certs and terminate TLS. Without a domain, use plain HTTP — browsers will show the COOP warning on raw IPs but it's non-breaking.

---

## Troubleshooting

### `docker compose` — unknown command
Ubuntu 24.04's `docker.io` package doesn't include the compose plugin. Use the hyphenated version:
```bash
sudo apt install -y docker-compose
docker-compose up -d    # ← hyphenated
```

### Docker Permission Denied
Your user isn't in the `docker` group:
```bash
sudo usermod -aG docker $USER
exit
# SSH back in
gcloud compute ssh workpulse --zone=us-central1-a
```

### `EACCES: permission denied, mkdir '/app/server/uploads/avatars'`
The Docker volume mount overrides directory ownership. Fix on host:
```bash
sudo mkdir -p ~/WorkPulse/server/uploads/avatars
sudo chmod -R 777 ~/WorkPulse/server/uploads
docker-compose restart workpulse
```

### Build fails: `can't stat 'data/postgres'`
The PostgreSQL data directory has root-owned files. Exclude it from the build context:
```bash
echo "data/" >> .dockerignore
docker-compose build --no-cache
```

### `ERR_CONNECTION_TIMED_OUT`
The GCP firewall is blocking port 80.
```bash
# Verify firewall rules exist
gcloud compute firewall-rules list --filter="targetTags:workpulse-server"

# Verify VM has the correct tag
gcloud compute instances describe workpulse --zone=us-central1-a \
  --format="get(tags.items)"
```

### Container Crash Loop
```bash
docker-compose logs --tail=30
```
Common causes:
- **`JWT_SECRET is not set`** — Check `.env` file exists with `JWT_SECRET=...`
- **Database connection refused** — PostgreSQL isn't ready yet. The healthcheck should handle this, but check: `docker-compose ps` (postgres should show `healthy`)

### 401 Unauthorized After Login
The JWT cookie's `Secure` flag may be set but you're using HTTP.
- Don't set `USE_HTTPS=true` in `.env` unless you have HTTPS configured

### Registration Shows "Closed"
```bash
docker-compose exec postgres psql -U workpulse -d workpulse \
  -c "UPDATE app_settings SET value = 'open' WHERE key = 'registration_mode';"
```

### IP Address Changed
If you forgot to reserve a static IP and the VM restarted:
```bash
# Find current external IP
gcloud compute instances describe workpulse --zone=us-central1-a \
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)"

# Promote it to static (prevents future changes)
gcloud compute addresses create workpulse-ip \
  --addresses=CURRENT_IP --region=us-central1
```

### COOP Header Warning in Browser
The `Cross-Origin-Opener-Policy header has been ignored` warning is expected when using plain HTTP on a raw IP. It is non-breaking — the app works fine. To eliminate it, set up HTTPS with a domain name.

### HTTPS Setup (Optional)
To enable HTTPS, set up a reverse proxy (e.g., Nginx or Caddy) with SSL certificates, then add to your `.env`:
```env
USE_HTTPS=true
```
This enables the `Secure` flag on authentication cookies.
