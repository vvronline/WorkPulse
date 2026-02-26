const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'attendance.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT NOT NULL,
    theme TEXT DEFAULT 'dark',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('clock_in', 'break_start', 'break_end', 'clock_out')),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS leaves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    leave_type TEXT NOT NULL CHECK(leave_type IN ('sick', 'holiday', 'planned', 'personal', 'other')),
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(user_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_leaves_user ON leaves(user_id, date);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_leaves_user_date ON leaves(user_id, date);

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date);
`);

// Add theme column if missing (migration for existing DBs)
try { db.exec('ALTER TABLE users ADD COLUMN theme TEXT DEFAULT \'dark\''); } catch (e) { /* column already exists */ }

// Add work_mode column to time_entries if missing
try { db.exec('ALTER TABLE time_entries ADD COLUMN work_mode TEXT DEFAULT \'office\''); } catch (e) { /* column already exists */ }

// Add timezone_offset column to users (for autoClockOut)
try { db.exec('ALTER TABLE users ADD COLUMN timezone_offset INTEGER DEFAULT 0'); } catch (e) { /* column already exists */ }

// Add avatar column to users
try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT NULL'); } catch (e) { /* column already exists */ }

// Add email column to users
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL'); } catch (e) { /* column already exists */ }

// Add token_version column to users (for invalidating tokens on password change)
try { db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0'); } catch (e) { /* column already exists */ }

// Migrate tasks table to support 'in_review' status (SQLite can't ALTER CHECK constraints)
try {
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  if (tableInfo && !tableInfo.sql.includes('in_review')) {
    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE tasks RENAME TO tasks_old`);
      db.exec(`
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          date TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'in_review', 'done')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
      db.exec(`INSERT INTO tasks SELECT * FROM tasks_old`);
      db.exec(`DROP TABLE tasks_old`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date)`);
    });
    migrate();
    console.log('✓ Tasks table migrated to support in_review status');
  }
} catch (e) { console.error('Tasks migration error:', e.message); }


// Password reset tokens table
db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

module.exports = db;
