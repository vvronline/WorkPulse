/** Role hierarchy — shared between route guards (App.jsx) and permission checks. */
export const ROLE_LEVEL = {
    employee: 1,
    team_lead: 2,
    manager: 3,
    hr_admin: 4,
    super_admin: 5,
    platform_admin: 6,
};

/** Timing constants (milliseconds) */
export const REFRESH_TOKEN_INTERVAL = 30 * 60 * 1000; // 30 min — auth token refresh
export const QUOTE_ROTATION_INTERVAL = 20_000;          // 20 sec — dashboard quote rotation
export const STATUS_POLL_INTERVAL = 120_000;         // 2 min  — dashboard status poll
export const NOTIFICATION_POLL_INTERVAL = 30_000;         // 30 sec — notification bell poll
