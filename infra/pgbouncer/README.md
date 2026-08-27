# PgBouncer on Railway

Phase E places PgBouncer between every AINO process and the managed Postgres
service. The application keeps using ordinary PostgreSQL URLs; only the host
changes to the PgBouncer private domain.

## Why transaction mode is safe here

Repository audit on 2026-08-21 found:

- no `LISTEN` / `NOTIFY`
- no temporary tables
- no SQL `PREPARE` / `DEALLOCATE`
- no session-level `SET`
- advisory locks use `pg_advisory_xact_lock` inside explicit transactions
- `pg` uses unnamed prepared statements by default

These are compatible with PgBouncer `pool_mode=transaction`.

## Railway service variables

Create a service from `infra/pgbouncer/Dockerfile` and set:

| Variable | Value |
|---|---|
| `DB_HOST` | `${{Postgres.PGHOST}}` |
| `DB_PORT` | `${{Postgres.PGPORT}}` |
| `DB_USER` | `${{Postgres.PGUSER}}` |
| `DB_PASSWORD` | `${{Postgres.PGPASSWORD}}` |
| `DB_NAME` | `${{Postgres.PGDATABASE}}` |
| `POOL_MODE` | `transaction` |
| `DEFAULT_POOL_SIZE` | `20` |
| `MIN_POOL_SIZE` | `0` |
| `RESERVE_POOL_SIZE` | `5` |
| `MAX_CLIENT_CONN` | `500` |
| `MAX_DB_CONNECTIONS` | `80` |
| `LISTEN_PORT` | `5432` |
| `SERVER_TLS_SSLMODE` | `prefer` |
| `IGNORE_STARTUP_PARAMETERS` | `extra_float_digits,options` |

Do not expose a public TCP proxy. Connect through Railway private networking.

## App variables after PgBouncer is healthy

Point `DATABASE_URL` at PgBouncer's private domain. Keep
`DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}` for the one-shot migration
service/pre-deploy command, so administrative DDL is independent from traffic
pooling and rollback remains simple.

```text
MASTER_POOL_SIZE=4
TENANT_POOL_SIZE=3
TENANT_MAX_POOLS=100
TENANT_FOREACH_CONCURRENCY=5
```

## Rollout

1. Deploy PgBouncer with the variables above.
2. Connect staging through it; test login, transactions, reporting, WS auth and
   `GET /readyz`.
3. Observe Postgres connections and `/api/internal/db-pool-stats`.
4. Change one production role at a time to PgBouncer.
5. Roll back by restoring `DATABASE_URL=${{Postgres.DATABASE_URL}}`.

Official config reference: https://www.pgbouncer.org/config.html