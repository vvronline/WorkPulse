import { defineRailway, github, image, postgres, preserve, project, redis, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "europe-west4-drams3a" });
  const Redis = redis("Redis", { region: "europe-west4-drams3a" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 500 });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 500 });
  const WorkPulse = service("WorkPulse", {
    source: github("vvronline/WorkPulse", { branch: "master" }),
    // D4.2/D4.5: readiness (not liveness) gates promotion — checks DB + Redis PING
    // (+ Pub/Sub for realtime, jobs for worker) before Railway routes traffic here.
    healthcheck: "/readyz",
    healthcheckTimeout: 300,
    // E3.2: run DB migrations once, before the new deployment takes traffic —
    // never at runtime from N replicas. migrate.ts prefers DIRECT_DATABASE_URL.
    preDeployCommand: ["node", "migrate.js"],
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      // Zero-downtime rollout: new replica overlaps the old one instead of a
      // hard cutover, and the old replica gets a grace window to drain in-flight
      // requests/WS connections before it is killed.
      overlapSeconds: 30,
      drainingSeconds: 15,
      limitOverride: { containers: { cpu: 8, memoryBytes: 8000000000 } },
    },
    replicas: { "asia-southeast1-eqsg3a": 1 },
    domains: [{ domain: "aino.org.in", port: 5000 }, { domain: "www.aino.org.in", port: 5000 }],
    networking: { privateNetworkEndpoint: "workpulse" },
    env: { CLOUDFLARE_TURN_API_TOKEN: preserve(), CLOUDFLARE_TURN_TOKEN_ID: preserve(), CORS_ORIGIN: preserve(), DATABASE_PUBLIC_URL: preserve(), DATABASE_URL: preserve(), DESKTOP_UPLOAD_SECRET: preserve(), DIRECT_DATABASE_URL: preserve(), DISABLE_PUBLIC_TURN: preserve(), ENCRYPTION_KEY: preserve(), FIREBASE_SERVICE_ACCOUNT_KEY: preserve(), GIPHY_API_KEY: preserve(), GMAIL_CLIENT_ID: preserve(), GMAIL_CLIENT_SECRET: preserve(), GMAIL_REFRESH_TOKEN: preserve(), GOOGLE_API_KEY: preserve(), JWT_SECRET: preserve(), MASTER_POOL_SIZE: preserve(), PORT: preserve(), R2_ACCESS_KEY_ID: preserve(), R2_ACCOUNT_ID: preserve(), R2_SECRET_ACCESS_KEY: preserve(), R2_UPLOADS_BUCKET: preserve(), REDIS_URL: preserve(), ROLE: preserve(), SERVE_SPA: preserve(), SMTP_FROM: preserve(), SMTP_USER: preserve(), STORAGE_DRIVER: preserve(), TENANT_FOREACH_CONCURRENCY: preserve(), TENANT_MAX_POOLS: preserve(), TENANT_POOL_SIZE: preserve() },
  });

  // E1.1: PgBouncer in transaction-pool mode sits in front of Postgres so that
  // scaling web/realtime/worker replicas does not multiply real server-side DB
  // connections — see infra/pgbouncer/README.md and E1.2/E1.3 compatibility audit.
  const PgBouncer = service("PgBouncer", {
    source: image("edoburu/pgbouncer:v1.24.1-p1"),
    env: {
      DB_HOST: Postgres.env.PGHOST,
      DB_PORT: Postgres.env.PGPORT,
      DB_USER: Postgres.env.PGUSER,
      DB_PASSWORD: Postgres.env.PGPASSWORD,
      DB_NAME: Postgres.env.PGDATABASE,
      POOL_MODE: "transaction",
      DEFAULT_POOL_SIZE: "20",
      MIN_POOL_SIZE: "0",
      RESERVE_POOL_SIZE: "5",
      MAX_CLIENT_CONN: "500",
      MAX_DB_CONNECTIONS: "80",
      LISTEN_PORT: "5432",
      SERVER_TLS_SSLMODE: "prefer",
      IGNORE_STARTUP_PARAMETERS: "extra_float_digits,options",
    },
    networking: { privateNetworkEndpoint: "pgbouncer" },
  });

  // D2/F1: role-split services from the same image, differing only by ROLE.
  // These run alongside WorkPulse (ROLE=all, kept as the rollback service) until
  // the D5 two-replica gate passes; none of these are scaled past 1 replica here.
  const roleServiceNames = { web: "aino-web", realtime: "aino-realtime", worker: "aino-worker" };
  const roleServices = Object.entries(roleServiceNames).map(([role, name]) =>
    service(name, {
      source: github("vvronline/WorkPulse", { branch: "master" }),
      healthcheck: "/readyz",
      healthcheckTimeout: 300,
      preDeployCommand: role === "web" ? ["node", "migrate.js"] : undefined,
      deploy: {
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 10,
        overlapSeconds: 30,
        drainingSeconds: 15,
      },
      networking: { privateNetworkEndpoint: name },
      // Shared secrets are referenced from WorkPulse rather than preserve()d —
      // these are brand-new services with nothing of their own to preserve.
      // A cross-service reference keeps one source of truth for rotation (A1).
      env: {
        ROLE: role,
        SERVE_SPA: "false",
        NODE_ENV: "production",
        CLOUDFLARE_TURN_API_TOKEN: WorkPulse.env.CLOUDFLARE_TURN_API_TOKEN, CLOUDFLARE_TURN_TOKEN_ID: WorkPulse.env.CLOUDFLARE_TURN_TOKEN_ID, CORS_ORIGIN: WorkPulse.env.CORS_ORIGIN, DATABASE_PUBLIC_URL: WorkPulse.env.DATABASE_PUBLIC_URL, DATABASE_URL: WorkPulse.env.DATABASE_URL, DESKTOP_UPLOAD_SECRET: WorkPulse.env.DESKTOP_UPLOAD_SECRET, DIRECT_DATABASE_URL: WorkPulse.env.DIRECT_DATABASE_URL, DISABLE_PUBLIC_TURN: WorkPulse.env.DISABLE_PUBLIC_TURN, ENCRYPTION_KEY: WorkPulse.env.ENCRYPTION_KEY, FIREBASE_SERVICE_ACCOUNT_KEY: WorkPulse.env.FIREBASE_SERVICE_ACCOUNT_KEY, GIPHY_API_KEY: WorkPulse.env.GIPHY_API_KEY, GMAIL_CLIENT_ID: WorkPulse.env.GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET: WorkPulse.env.GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN: WorkPulse.env.GMAIL_REFRESH_TOKEN, GOOGLE_API_KEY: WorkPulse.env.GOOGLE_API_KEY, JWT_SECRET: WorkPulse.env.JWT_SECRET, MASTER_POOL_SIZE: WorkPulse.env.MASTER_POOL_SIZE, PORT: WorkPulse.env.PORT, R2_ACCESS_KEY_ID: WorkPulse.env.R2_ACCESS_KEY_ID, R2_ACCOUNT_ID: WorkPulse.env.R2_ACCOUNT_ID, R2_SECRET_ACCESS_KEY: WorkPulse.env.R2_SECRET_ACCESS_KEY, R2_UPLOADS_BUCKET: WorkPulse.env.R2_UPLOADS_BUCKET, REDIS_URL: WorkPulse.env.REDIS_URL, SMTP_FROM: WorkPulse.env.SMTP_FROM, SMTP_USER: WorkPulse.env.SMTP_USER, STORAGE_DRIVER: WorkPulse.env.STORAGE_DRIVER, TENANT_FOREACH_CONCURRENCY: WorkPulse.env.TENANT_FOREACH_CONCURRENCY, TENANT_MAX_POOLS: WorkPulse.env.TENANT_MAX_POOLS, TENANT_POOL_SIZE: WorkPulse.env.TENANT_POOL_SIZE,
      },
    })
  );

  return project("renewed-fascination", {
    resources: [WorkPulse, Postgres, Redis, redisVolume, postgresVolume, PgBouncer, ...roleServices],
  });
});
