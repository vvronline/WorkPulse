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

## Getting Started (Local Development)

### 1. Start the Backend
```bash
cd server
npm install
npm run dev
```
*Note: Make sure to configure your `.env` file in the server directory with a `JWT_SECRET` and `CORS_ORIGIN=http://localhost:3000` before running.*

### 2. Start the Frontend
```bash
cd client
npm install
npm run dev
```
*App runs on http://localhost:3000*

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
