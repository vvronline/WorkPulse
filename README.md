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
- ** Responsive Design**: Optimized for both desktop and mobile viewing.

## Tech Stack

- **Frontend:** React, Vite, React Router, Chart.js, React-Quill (Rich Text)
- **Backend:** Node.js, Express, SQLite (Better-SQLite3), Multer (File Uploads)

## Getting Started

### 1. Start the Backend

```bash
cd server
npm install
npm start
```
*Note: Make sure to configure your `.env` file in the server directory with appropriate secrets before running.*

Server runs on http://localhost:5000

### 2. Start the Frontend

```bash
cd client
npm install
npm run dev
```

App runs on http://localhost:3000

## Usage Guide
1. **Register**: Create a new account or sign in.
2. **Dashboard**: View your day's quick stats and start your clock.
3. **Tasks**: Navigate to the Tasks tab. Add a new task, open it to add subtasks and attachments, and drag it to "In Progress" when you begin.
4. **Leaves & Manual Entry**: Keep your attendance accurate if you miss a punch.
5. **Profile**: Upload your avatar to personalize your workspace.
