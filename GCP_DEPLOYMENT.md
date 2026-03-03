# WorkPulse GCP Deployment Guide (Docker)

This is the fastest and most reliable way to deploy WorkPulse to a fresh Google Cloud Platform (GCP) Ubuntu Virtual Machine.

## Prerequisites
- **GCP VM:** Ubuntu 22.04 LTS (or newer).
- **Firewall:** Ensure **"Allow HTTP Traffic"** is checked in your VM settings.

---

## ⚡ Quick Start (Docker Method)

### 1. Install Dependencies
SSH into your fresh VM and run:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install git docker.io docker-compose -y
```

### 2. Clone & Configure
```bash
git clone https://github.com/vvronline/WorkPulse.git
cd WorkPulse

# Create your environment file
nano .env
```
Paste this into `.env` (Replace with your actual IP):
```env
JWT_SECRET=your_super_secret_key
CORS_ORIGIN=http://YOUR_VM_IP
```

### 3. Deploy! 🚀
```bash
sudo docker-compose up -d --build
```
*Your app is now live at http://YOUR_VM_IP!*

---

## 🛠️ Post-Setup: Create Admin Account
Since it's a fresh database, your first registered user needs to be promoted to Super Admin:
```bash
# Run this from the WorkPulse folder on the VM
sqlite3 server/attendance.db "UPDATE users SET role = 'super_admin' WHERE username = 'YOUR_USERNAME';"
```

---

## Manual Deployment (PM2 + Nginx)
*Use this only if you cannot use Docker.*
SSH into your fresh GCP VM and run the following commands to update the system and install necessary packages (Node.js, NPM, Nginx, and Git).

```bash
# Update package lists
sudo apt update && sudo apt upgrade -y

# Install Git and Nginx
sudo apt install git nginx -y

# Install Node.js (v20.x recommended)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally (Process Manager for Node.js)
sudo npm install -g pm2
```

---

## Step 2: Clone the Repository
Clone the WorkPulse repository to your user's home directory.

```bash
cd ~
git clone https://github.com/vvronline/WorkPulse.git
cd WorkPulse
```

---

## Step 3: Backend Setup
Install the backend dependencies, configure the environment, and start the server.

```bash
# Navigate to the server directory
cd ~/WorkPulse/server

# Install dependencies
npm install

# Create the environment variables file
nano .env
```

Paste the following into your `.env` file. Replace `YOUR_VM_EXTERNAL_IP` with your actual GCP public IP address (e.g., `http://34.31.27.200`).

```env
PORT=5000
JWT_SECRET=your_super_secret_jwt_key_here
CORS_ORIGIN=http://YOUR_VM_EXTERNAL_IP
NODE_ENV=production
```
Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

Start the backend using PM2:
```bash
sudo pm2 start index.js --name workpulse

# Save the PM2 process list so it restarts on server reboots
sudo pm2 save
sudo pm2 startup
```

---

## Step 4: Frontend Build
Install the frontend dependencies and compile the React application using Vite.

```bash
# Navigate to the client directory
cd ~/WorkPulse/client

# Install frontend dependencies
npm install

# Build the production bundle
npm run build
```
*Note: This generates the optimized static files in `~/WorkPulse/client/dist`.*

---

## Step 5: Nginx Configuration (Reverse Proxy & Static File Serving)
Configure Nginx to safely serve the frontend directly and proxy API requests to your Node.js backend.

```bash
# Create and open the Nginx config file
sudo nano /etc/nginx/sites-available/workpulse
```

Replace the contents with the following optimized configuration. 
**Important:** Ensure the `server_name` matches your public IP (or domain), and `root` matches the exact path to your cloned repository.

```nginx
server {
    listen 80;
    server_name YOUR_VM_EXTERNAL_IP; # e.g., 34.31.27.200
    client_max_body_size 10M;

    # 1. Point Nginx directly to your built React files
    root /home/YOUR_USERNAME/WorkPulse/client/dist;
    index index.html;

    # 2. Try answering requests with actual CSS/JS files first.
    #    If the file isn't found, load index.html (React handles the rest)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 3. Only forward API calls to the Node.js backend
    location /api/ {
        proxy_pass http://localhost:5000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 4. Serve uploaded files securely and directly off the disk
    location /uploads/ {
        alias /home/YOUR_USERNAME/WorkPulse/server/uploads/;
        access_log off;
        expires 30d;
    }
}
```
Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

Enable the configuration and restart Nginx:
```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/workpulse /etc/nginx/sites-enabled/

# Remove the default Nginx page
sudo rm /etc/nginx/sites-enabled/default

# Test the config and restart
sudo nginx -t
sudo systemctl restart nginx
```

---

## Step 6: Initial Access & Admin Setup
1. Open your browser and navigate to `http://YOUR_VM_EXTERNAL_IP`. The WorkPulse application should load instantly.
2. Click **Register** and create your first account.
3. Because new accounts default to the `employee` role, you will be locked out of the Admin panel. You must promote your first user to Super Admin via the database.

Back in your VM terminal, run:
```bash
cd ~/WorkPulse/server
sqlite3 attendance.db "UPDATE users SET role = 'super_admin' WHERE username = 'YOUR_USERNAME';"
```
*(Replace `YOUR_USERNAME` with the username you just registered).*

4. Go back to your browser, Log Out, and Log back in.
5. You will now see the **Admin** tab. From here, you can set up Organizations, Departments, Teams, and manage registrations for your team!

## Troubleshooting
- **500 Internal Server Error on Login:** Double check that `CORS_ORIGIN` in your `.env` file exactly matches the URL you are visiting in your browser. If you changed it, run `sudo pm2 restart workpulse --update-env`.
- **Blank white screen / MIME type errors:** Ensure Nginx is pointing to the correct absolute path in the `root` directive, and that you successfully ran `npm run build` in the `/client` directory.
