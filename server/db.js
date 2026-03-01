const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'attendance.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Enable foreign key enforcement (SQLite has them OFF by default)
db.pragma('foreign_keys = ON');

// ============= CORE TABLES =============
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

// ============= COLUMN MIGRATIONS (existing tables) =============
try { db.exec('ALTER TABLE users ADD COLUMN theme TEXT DEFAULT \'dark\''); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE time_entries ADD COLUMN work_mode TEXT DEFAULT \'office\''); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN timezone_offset INTEGER DEFAULT 0'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT NULL'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0'); } catch (e) { /* exists */ }

// RBAC: role column on users (employee, team_lead, manager, hr_admin, super_admin)
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'employee'"); } catch (e) { /* exists */ }
// Soft-delete / deactivation
try { db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1'); } catch (e) { /* exists */ }
// Org & Team FK
try { db.exec('ALTER TABLE users ADD COLUMN org_id INTEGER REFERENCES organizations(id)'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN team_id INTEGER REFERENCES teams(id)'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN department_id INTEGER REFERENCES departments(id)'); } catch (e) { /* exists */ }

// Leave approval status + half-day support
try { db.exec("ALTER TABLE leaves ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE leaves ADD COLUMN duration TEXT NOT NULL DEFAULT 'full'"); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE leaves ADD COLUMN approved_by INTEGER REFERENCES users(id)'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE leaves ADD COLUMN reviewed_at DATETIME'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE leaves ADD COLUMN reject_reason TEXT'); } catch (e) { /* exists */ }

// Manual entry approval
try { db.exec("ALTER TABLE time_entries ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE time_entries ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'"); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE time_entries ADD COLUMN approved_by INTEGER REFERENCES users(id)'); } catch (e) { /* exists */ }

// Migrate tasks table to support 'in_review' status
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

// ============= ENTERPRISE TABLES =============

// Organizations (multi-tenant)
db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    logo TEXT,
    work_hours_per_day REAL NOT NULL DEFAULT 8,
    work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    fiscal_year_start INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Departments
db.exec(`
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    head_id INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, name)
  );
`);

// Teams
db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    lead_id INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, name)
  );
`);

// Leave policies (per org, per leave type)
db.exec(`
  CREATE TABLE IF NOT EXISTS leave_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    leave_type TEXT NOT NULL,
    annual_quota REAL NOT NULL DEFAULT 0,
    accrual_type TEXT NOT NULL DEFAULT 'annual' CHECK(accrual_type IN ('annual', 'monthly', 'quarterly')),
    carry_forward_limit REAL NOT NULL DEFAULT 0,
    half_day_allowed INTEGER NOT NULL DEFAULT 1,
    quarter_day_allowed INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, leave_type)
  );
`);

// Leave balances (per user, per leave type, per year)
db.exec(`
  CREATE TABLE IF NOT EXISTS leave_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    leave_type TEXT NOT NULL,
    year INTEGER NOT NULL,
    quota REAL NOT NULL DEFAULT 0,
    used REAL NOT NULL DEFAULT 0,
    carried_forward REAL NOT NULL DEFAULT 0,
    UNIQUE(user_id, leave_type, year)
  );
`);

// Company holidays calendar
db.exec(`
  CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    is_optional INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, date)
  );
`);

// Approval requests (unified: leaves, manual entries, overtime)
db.exec(`
  CREATE TABLE IF NOT EXISTS approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    requester_id INTEGER NOT NULL REFERENCES users(id),
    approver_id INTEGER REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('leave', 'manual_entry', 'overtime')),
    reference_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    reason TEXT,
    reject_reason TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_approval_requester ON approval_requests(requester_id, status);
  CREATE INDEX IF NOT EXISTS idx_approval_approver ON approval_requests(approver_id, status);
`);

// Audit logs (immutable)
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER REFERENCES organizations(id),
    actor_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(org_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
`);

// ============= SEED: First user as super_admin =============
try {
  const firstUser = db.prepare('SELECT id, role FROM users ORDER BY id ASC LIMIT 1').get();
  if (firstUser && firstUser.role === 'employee') {
    db.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(firstUser.id);
    console.log(`✓ Promoted user #${firstUser.id} to super_admin (first user)`);
  }
} catch (e) { /* no users yet */ }

module.exports = db;
