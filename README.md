# WorkPulse

A web application for tracking employee in-floor hours, breaks, and daily attendance.

## Features

- **Clock In/Out** — Mark when you start and end your workday
- **Break Tracking** — Log breaks when leaving the floor
- **Live Timer** — Real-time floor time counter
- **8-Hour Target** — Get notified when you've completed 8 hours
- **Analytics Dashboard** — Charts showing daily floor vs break time trends
- **History Log** — View detailed daily logs with target achievement

## Tech Stack

- **Frontend:** React + Vite + Chart.js
- **Backend:** Node.js + Express + SQLite

## Getting Started

### 1. Start the Backend

```bash
cd server
npm install
npm start
```

Server runs on http://localhost:5000

### 2. Start the Frontend

```bash
cd client
npm install
npm run dev
```

App runs on http://localhost:3000

### 3. Usage

1. Register a new account or sign in
2. Click **Clock In** when you arrive at your workstation
3. Click **Take Break** when leaving the floor
4. Click **Back to Floor** when returning
5. Click **Clock Out** when leaving for the day
6. Visit **Analytics** to view charts and history
