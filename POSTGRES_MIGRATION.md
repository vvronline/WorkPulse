# PostgreSQL Migration Guide

## Why Migrate?
SQLite works great for single-server use, but PostgreSQL is better for:
- Multi-server / load-balanced deployments
- Concurrent writes from many users
- Cloud-hosted databases (e.g., Supabase, Neon, AWS RDS)

## Steps to Migrate

### 1. Install PostgreSQL
```bash
# Windows: Download from https://www.postgresql.org/download/windows/
# Or use Docker:
docker run -d --name floortime-db -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=floortime -p 5432:5432 postgres:16
```

### 2. Create the database
```sql
CREATE DATABASE floortime;
\c floortime

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  full_name TEXT,
  theme TEXT DEFAULT 'dark'
);

CREATE TABLE time_entries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  entry_type TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE leaves (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  leave_type TEXT NOT NULL DEFAULT 'planned',
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_time_entries_user ON time_entries(user_id, timestamp);
CREATE INDEX idx_leaves_user ON leaves(user_id, date);
```

### 3. Install Node.js driver
```bash
cd server
npm install pg
```

### 4. Update environment variables
Add to `.env`:
```
DB_TYPE=postgres
DATABASE_URL=postgresql://postgres:secret@localhost:5432/floortime
```

### 5. Replace `server/db.js`
Replace `better-sqlite3` calls with `pg` pool queries. Key differences:
- `db.prepare(sql).all(params)` → `pool.query(sql, [params])` then `.rows`
- `db.prepare(sql).run(params)` → `pool.query(sql, [params])`
- `db.prepare(sql).get(params)` → `pool.query(sql, [params])` then `.rows[0]`
- Use `$1, $2` instead of `?` for parameters
- Wrap multi-statement ops in transactions: `BEGIN` / `COMMIT`

### 6. Data migration
Export from SQLite and import to PostgreSQL:
```bash
# Export
sqlite3 attendance.db ".dump" > dump.sql

# Convert SQLite syntax to PostgreSQL (manual edits needed for AUTOINCREMENT → SERIAL etc.)
# Then import:
psql -d floortime -f dump.sql
```

## Alternative: Use an ORM
Consider migrating to **Knex.js** or **Drizzle** for database-agnostic queries:
```bash
npm install knex pg
```
Knex supports both SQLite and PostgreSQL with the same query API.
