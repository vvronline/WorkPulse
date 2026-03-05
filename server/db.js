const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Allow overriding database path via environment variable (useful for Docker)
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'attendance.db');

// Ensure the directory for the database exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Enable foreign key enforcement (SQLite has them OFF by default)
db.pragma('foreign_keys = ON');

// ============= MIGRATION FRAMEWORK =============
db.exec(`
  CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function runMigration(name, fn) {
  const exists = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name);
  if (exists) return;
  try {
    fn();
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
  } catch (e) {
    // Column already exists or migration already applied — just record it
    if (e.message.includes('duplicate column') || e.message.includes('already exists')) {
      db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run(name);
    } else {
      console.error(`Migration ${name} failed:`, e.message);
    }
  }
}

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
runMigration('users_theme', () => db.exec("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'dark'"));
runMigration('time_entries_work_mode', () => db.exec("ALTER TABLE time_entries ADD COLUMN work_mode TEXT DEFAULT 'office'"));
runMigration('users_timezone_offset', () => db.exec('ALTER TABLE users ADD COLUMN timezone_offset INTEGER DEFAULT 0'));
runMigration('users_avatar', () => db.exec('ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT NULL'));
runMigration('users_email', () => db.exec('ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL'));
runMigration('users_token_version', () => db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0'));

// RBAC: role column on users (employee, team_lead, manager, hr_admin, super_admin)
runMigration('users_role', () => db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'employee'"));
// Soft-delete / deactivation
runMigration('users_is_active', () => db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1'));
// Org & Team FK
runMigration('users_org_id', () => db.exec('ALTER TABLE users ADD COLUMN org_id INTEGER REFERENCES organizations(id)'));
runMigration('users_team_id', () => db.exec('ALTER TABLE users ADD COLUMN team_id INTEGER REFERENCES teams(id)'));
runMigration('users_department_id', () => db.exec('ALTER TABLE users ADD COLUMN department_id INTEGER REFERENCES departments(id)'));
// Direct manager assignment (works with or without org)
runMigration('users_manager_id', () => db.exec('ALTER TABLE users ADD COLUMN manager_id INTEGER REFERENCES users(id)'));
// Force password change on first login (admin-created accounts)
runMigration('users_must_change_password', () => db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0'));

// Migration: make approval_requests.org_id nullable (was NOT NULL)
runMigration('approval_requests_org_nullable', () => {
  const colInfo = db.pragma("table_info(approval_requests)").find(c => c.name === 'org_id');
  if (colInfo && colInfo.notnull === 1) {
    db.exec(`
      CREATE TABLE approval_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER REFERENCES organizations(id),
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
      INSERT INTO approval_requests_new SELECT * FROM approval_requests;
      DROP TABLE approval_requests;
      ALTER TABLE approval_requests_new RENAME TO approval_requests;
      CREATE INDEX IF NOT EXISTS idx_approval_requester ON approval_requests(requester_id, status);
      CREATE INDEX IF NOT EXISTS idx_approval_approver ON approval_requests(approver_id, status);
    `);
    console.log('✓ Migrated approval_requests.org_id to nullable');
  }
});

// Leave approval status + half-day support
runMigration('leaves_status', () => db.exec("ALTER TABLE leaves ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'"));
runMigration('leaves_duration', () => db.exec("ALTER TABLE leaves ADD COLUMN duration TEXT NOT NULL DEFAULT 'full'"));
runMigration('leaves_approved_by', () => db.exec('ALTER TABLE leaves ADD COLUMN approved_by INTEGER REFERENCES users(id)'));
runMigration('leaves_reviewed_at', () => db.exec('ALTER TABLE leaves ADD COLUMN reviewed_at DATETIME'));
runMigration('leaves_reject_reason', () => db.exec('ALTER TABLE leaves ADD COLUMN reject_reason TEXT'));

// Manual entry approval
runMigration('time_entries_is_manual', () => db.exec("ALTER TABLE time_entries ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0"));
runMigration('time_entries_approval_status', () => db.exec("ALTER TABLE time_entries ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'"));
runMigration('time_entries_approved_by', () => db.exec('ALTER TABLE time_entries ADD COLUMN approved_by INTEGER REFERENCES users(id)'));

// Migrate tasks table to support 'in_review' status
runMigration('tasks_in_review_status', () => {
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
});

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

// Sprints (for team-based agile workflow)
db.exec(`
  CREATE TABLE IF NOT EXISTS sprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned', 'active', 'completed')),
    goal TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(team_id, name)
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
    org_id INTEGER REFERENCES organizations(id),
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

// ============= SETTINGS & INVITE CODES =============

// App-wide settings (key-value)
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Invite codes for controlled registration
db.exec(`
  CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    org_id INTEGER REFERENCES organizations(id),
    role TEXT NOT NULL DEFAULT 'employee',
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at DATETIME,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: add 'leave_withdraw' to approval_requests type CHECK constraint
runMigration('approval_requests_leave_withdraw_type', () => {
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='approval_requests'").get();
  if (tableInfo && !tableInfo.sql.includes('leave_withdraw')) {
    db.exec(`
      CREATE TABLE approval_requests_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER REFERENCES organizations(id),
        requester_id INTEGER NOT NULL REFERENCES users(id),
        approver_id INTEGER REFERENCES users(id),
        type TEXT NOT NULL CHECK(type IN ('leave', 'manual_entry', 'overtime', 'leave_withdraw')),
        reference_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
        reason TEXT,
        reject_reason TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reviewed_at DATETIME
      );
      INSERT INTO approval_requests_v2 SELECT * FROM approval_requests;
      DROP TABLE approval_requests;
      ALTER TABLE approval_requests_v2 RENAME TO approval_requests;
      CREATE INDEX IF NOT EXISTS idx_approval_requester ON approval_requests(requester_id, status);
      CREATE INDEX IF NOT EXISTS idx_approval_approver ON approval_requests(approver_id, status);
    `);
    console.log('✓ Migrated approval_requests to support leave_withdraw type');
  }
});

// Additional indexes for common query patterns
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_time_entries_manual ON time_entries(user_id, is_manual, approval_status);
  CREATE INDEX IF NOT EXISTS idx_approval_type_status ON approval_requests(type, status);
  CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves(user_id, status, date);
  CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(user_id, timestamp);
`);

// Default: registration is closed (admin creates users)
db.exec("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('registration_mode', 'closed')");
// Migrate existing open/invite_only to closed
runMigration('registration_mode_closed_default', () => {
  db.exec("UPDATE app_settings SET value = 'closed' WHERE key = 'registration_mode' AND value = 'open'");
});

// ============= TASK ENHANCEMENT MIGRATIONS =============

// Task assignment: allow assigning tasks to other users
runMigration('tasks_assigned_to', () => db.exec('ALTER TABLE tasks ADD COLUMN assigned_to INTEGER REFERENCES users(id)'));

// Task due dates
runMigration('tasks_due_date', () => db.exec('ALTER TABLE tasks ADD COLUMN due_date TEXT'));

// Task sprint assignment
runMigration('tasks_sprint_id', () => db.exec('ALTER TABLE tasks ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL'));

// Team sprint configuration
runMigration('teams_sprint_duration', () => db.exec('ALTER TABLE teams ADD COLUMN sprint_duration_weeks INTEGER NOT NULL DEFAULT 2'));
runMigration('teams_sprint_start_date', () => db.exec('ALTER TABLE teams ADD COLUMN sprint_start_date TEXT'));

// Task labels (org-scoped, admin-defined)
db.exec(`
  CREATE TABLE IF NOT EXISTS task_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6366f1',
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, name)
  );
`);

// Many-to-many: tasks <-> labels
db.exec(`
  CREATE TABLE IF NOT EXISTS task_label_map (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_label_map_task ON task_label_map(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_label_map_label ON task_label_map(label_id);
`);

// Task comments
db.exec(`
  CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);
`);

// Index for assigned-to queries
runMigration('tasks_assigned_to_index', () => {
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to, date)');
});

// Allow tasks without a date (backlog items)
runMigration('tasks_nullable_date', () => {
  // SQLite doesn't support ALTER COLUMN, so we recreate
  const hasBacklog = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE date IS NULL").get();
  // Just test an insert with NULL date to see if it works
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'in_review', 'done')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        assigned_to INTEGER REFERENCES users(id),
        due_date TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO tasks_new SELECT id, user_id, date, title, description, priority, status, created_at, completed_at, assigned_to, due_date FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to, date);
    `);
    console.log('✓ Tasks table migrated to allow nullable date (backlog)');
  } catch (e) {
    // Already migrated or table structure differs
  }
});

// ============= SEED: First user as super_admin =============

// Task history table (activity log per task)
runMigration('task_history_table', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id, created_at);
  `);
  console.log('✓ task_history table created');
});

// Notes/Notebooks table (one JSON doc per user)
runMigration('notebooks_table', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✓ notebooks table created');
});

// Notebook page version history
runMigration('notebook_history_table', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebook_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      page_id    TEXT    NOT NULL,
      page_title TEXT,
      content    TEXT,
      saved_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nb_history_page
      ON notebook_history(user_id, page_id, saved_at DESC);
  `);
  console.log('✓ notebook_history table created');
});

// In-app notifications
runMigration('notifications_table', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type       TEXT    NOT NULL,
      title      TEXT    NOT NULL,
      body       TEXT,
      link_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      is_read    INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user
      ON notifications(user_id, is_read, created_at DESC);
  `);
  console.log('✓ notifications table created');
});

try {
  const firstUser = db.prepare('SELECT id, role FROM users ORDER BY id ASC LIMIT 1').get();
  if (firstUser && firstUser.role === 'employee') {
    db.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(firstUser.id);
    console.log(`✓ Promoted user #${firstUser.id} to super_admin (first user)`);
  }
} catch (e) { /* no users yet */ }

module.exports = db;
