import express from "express";
import type { Request, Response } from "express";
const auth = require("../middleware/auth");
const { loadUserContext, ROLE_LEVEL } = require("../middleware/rbac");
const { findApprover } = require("../utils/approver");
const { logAction } = require("../utils/audit");
const { getLocalToday, getLocalDow, getTzModifier, getLocalDateFromTs, getOffsetMin } = require("../utils/timezone");
const { computeStatus, computeDaySummary, endOfLocalDayMs } = require("../utils/timeCalc");
const { logger } = require("../utils/logger");
const { notifyByEmail } = require("../utils/mailer");
const { sendToUser } = require("../utils/ws");
const redis = require("../redis");
const { requireTenant } = require("../middleware/tenant");
const { haversineMeters, isValidLat, isValidLng } = require("../utils/geo");
const { isValidDescriptor, isPlausibleDescriptor, isDescriptorReplay, parseDescriptor, compareDescriptors } = require("../utils/face");
const { parseWorkDays, isJsDowWorkDay } = require("../utils/workDays");

const router = express.Router();
router.use(requireTenant);

interface DbLike {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
    transaction: <T = unknown>(fn: (client: any) => Promise<T>) => Promise<T>;
}

interface TimeEntry {
    id: number;
    entry_type: string;
    timestamp: string;
    work_mode?: string | null;
    is_manual?: boolean;
    approval_status?: string | null;
    [key: string]: unknown;
}

interface OrgWorkConfig {
    work_hours_per_day: number;
    work_days: string;
    min_hours_present?: number | string | null;
}

const VALID_WORK_MODES = ["office", "remote", "hybrid"];

// Helper: fetch org config with Redis cache
async function getOrgWorkConfig(orgId: number | null | undefined, db: DbLike, tenantId: number | string | undefined): Promise<OrgWorkConfig> {
    if (!orgId) return { work_hours_per_day: 8, work_days: "1,2,3,4,5", min_hours_present: null };
    const cached = await redis.getOrgConfig(tenantId, orgId);
    if (cached) return cached;
    const result = await db.query("SELECT work_hours_per_day, work_days, min_hours_present FROM organizations WHERE id = $1", [orgId]);
    const config = result.rows[0] || { work_hours_per_day: 8, work_days: "1,2,3,4,5", min_hours_present: null };
    await redis.setOrgConfig(tenantId, orgId, config);
    return config;
}

// Helper: validate HH:MM time string (range-checked, not just format)
function isValidTime(str: string): boolean {
    if (!/^\d{2}:\d{2}$/.test(str)) return false;
    const [h, m] = str.split(":").map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

// ── Face verification abuse guards (Redis-backed, fail-open) ────────────
// Limit consecutive failed face-match attempts per user and detect exact
// descriptor replays (the same embedding re-submitted from a captured
// payload — a fresh camera frame never reproduces an identical vector).
const FACE_FAIL_LIMIT = 8;
const FACE_FAIL_WINDOW_SEC = 15 * 60;
const FACE_LAST_DESCRIPTOR_TTL_SEC = 24 * 60 * 60;

function faceKey(tenantId: number | string | undefined, kind: string, userId: number | undefined): string {
    return `t:${tenantId ?? "master"}:face:${kind}:${userId}`;
}

async function getFaceFailCount(tenantId: number | string | undefined, userId: number | undefined): Promise<number> {
    try {
        const v = await redis.get(faceKey(tenantId, "fails", userId));
        return Number(v) || 0;
    } catch { return 0; }
}

async function bumpFaceFailCount(tenantId: number | string | undefined, userId: number | undefined): Promise<void> {
    try {
        const key = faceKey(tenantId, "fails", userId);
        const cur = Number(await redis.get(key)) || 0;
        await redis.set(key, cur + 1, FACE_FAIL_WINDOW_SEC);
    } catch { /* fail open */ }
}

async function clearFaceFailCount(tenantId: number | string | undefined, userId: number | undefined): Promise<void> {
    try { await redis.del(faceKey(tenantId, "fails", userId)); } catch { /* ignore */ }
}

// Helper: convert timezone offset to a pg date expression.
function pgDateInTz(col: string, tzMod: unknown): string {
    const minutes = parseInt(String(tzMod), 10) || 0;
    const safe = Math.max(-840, Math.min(720, minutes));
    return `(${col} + INTERVAL '${safe} minutes')::date`;
}

// Get current status for today
router.get("/status", auth, async (req: Request, res: Response) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);
        const dow = getLocalDow(req);

        const orgRow = (await req.db!.query(
            `SELECT u.org_id FROM users u WHERE u.id = $1`, [req.userId],
        )).rows[0];
        const orgConfig = await getOrgWorkConfig(orgRow?.org_id, req.db as unknown as DbLike, req.tenantId);
        const targetMinutes = (orgConfig.work_hours_per_day || 8) * 60;
        const isWeekend = !isJsDowWorkDay(dow, orgConfig.work_days);

        const result = await req.db!.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
               AND (approval_status IS NULL OR approval_status != 'rejected')
             ORDER BY timestamp ASC, id ASC`,
            [req.userId, today],
        );
        let entries: TimeEntry[] = result.rows;

        const status = computeStatus(entries);

        let autoLoggedOut = false;
        const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
        const isLiveSession = lastEntry && !lastEntry.is_manual;
        if (isLiveSession && status.state !== "logged_out" && status.floorMinutes >= targetMinutes) {
            const didClockOut = await (req.db as unknown as DbLike).transaction(async (client) => {
                const latest = (await client.query(
                    `SELECT entry_type FROM time_entries WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date ORDER BY timestamp DESC, id DESC LIMIT 1 FOR UPDATE`,
                    [req.userId, today],
                )).rows[0];
                if (!latest || latest.entry_type === "clock_out") return false;
                await client.query(
                    "INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)",
                    [req.userId, "clock_out"],
                );
                return true;
            });
            if (didClockOut) {
                logAction(req, "auto_clock_out", "time_entry", null, {
                    floorMinutes: status.floorMinutes, targetMinutes,
                });
                const refreshed = await req.db!.query(
                    `SELECT * FROM time_entries
                     WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
                       AND (approval_status IS NULL OR approval_status != 'rejected')
                     ORDER BY timestamp ASC, id ASC`,
                    [req.userId, today],
                );
                entries = refreshed.rows;
                Object.assign(status, computeStatus(entries));
                autoLoggedOut = true;
            }
        }

        status.isWeekend = isWeekend;
        // Report the CURRENT/open session's work mode (the latest clock-in of
        // the day), not the first. A user may have an earlier office session
        // and then start a new remote one; using the first clock-in would
        // mislabel the open session as "office" and make clients wrongly
        // demand office (Wi-Fi/geofence) verification on clock-out. This
        // mirrors the clock-out enforcement, which keys off the latest clock-in.
        const clockInEntry = [...entries].reverse().find((e) => e.entry_type === "clock_in");
        status.workMode = clockInEntry?.work_mode || "office";
        status.targetMinutes = targetMinutes;
        status.dailyTargetMet = status.floorMinutes >= targetMinutes;
        status.autoLoggedOut = autoLoggedOut;
        res.json(status);
    } catch (err) {
        req.log.error({ err }, "Status error");
        res.status(500).json({ error: "Failed to get status" });
    }
});

// Clock-in
router.post("/clock-in", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);
        const dow = getLocalDow(req);

        let workDaysValue = null;
        if (req.userOrgId) {
            const orgConfig = await getOrgWorkConfig(req.userOrgId, req.db as unknown as DbLike, req.tenantId);
            workDaysValue = orgConfig.work_days;
        }
        if (!isJsDowWorkDay(dow, workDaysValue)) {
            return res.status(400).json({ error: "It's a day off! Enjoy your rest. 🎉" });
        }

        if (req.userOrgId) {
            const orgConfig = await getOrgWorkConfig(req.userOrgId, req.db as unknown as DbLike, req.tenantId);
            const targetMin = (orgConfig.work_hours_per_day || 8) * 60;
            const todayEntries: TimeEntry[] = (await req.db!.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
                   AND (approval_status IS NULL OR approval_status != 'rejected')
                 ORDER BY timestamp ASC, id ASC`,
                [req.userId, today],
            )).rows;
            const todayStatus = computeStatus(todayEntries);
            if (todayStatus.state === "logged_out" && todayStatus.floorMinutes >= targetMin) {
                const approvedOT = (await req.db!.query(
                    `SELECT id FROM approval_requests
                     WHERE requester_id = $1
                       AND type = 'overtime'
                       AND status = 'approved'
                       AND (metadata->>'date') = $2`,
                    [req.userId, today],
                )).rows[0];
                if (!approvedOT) {
                    return res.status(403).json({
                        error: "Daily target reached. Apply for overtime approval to continue working.",
                        code: "DAILY_TARGET_MET",
                    });
                }
            }
        }

        const validWorkModes = ["office", "remote", "hybrid"];
        let selectedWorkMode = validWorkModes.includes(req.body.work_mode) ? req.body.work_mode : "office";

        const tzOffset = getOffsetMin(req);
        if (tzOffset < -840 || tzOffset > 720) {
            return res.status(400).json({ error: "Invalid timezone offset" });
        }

        let verifyMeta: Record<string, unknown> = {
            clock_in_lat: null,
            clock_in_lng: null,
            clock_in_accuracy_m: null,
            clock_in_distance_m: null,
            face_verified: null,
            face_match_score: null,
            verified_via: null,
            clock_in_wifi_bssid: null,
        };
        if (req.userOrgId) {
            const orgVerify = (await req.db!.query(
                `SELECT attendance_verification_enabled, office_latitude, office_longitude, office_radius_m,
                        office_wifi_bssids, office_wifi_verification_enabled
                 FROM organizations WHERE id = $1`,
                [req.userOrgId],
            )).rows[0];

            if (orgVerify?.attendance_verification_enabled) {
                const { latitude, longitude, accuracy, face_descriptor, wifi_bssid } = req.body || {};
                const orgLat = orgVerify.office_latitude != null ? Number(orgVerify.office_latitude) : null;
                const orgLng = orgVerify.office_longitude != null ? Number(orgVerify.office_longitude) : null;
                const radiusM = Number(orgVerify.office_radius_m) || 150;
                // Sanitise accuracy: must be a finite, non-negative number of
                // metres — anything else (negative, NaN, absurd strings) is
                // treated as "not provided".
                const accuracyM = (accuracy != null && Number.isFinite(Number(accuracy)) && Number(accuracy) >= 0)
                    ? Number(accuracy)
                    : null;

                const officeBssids = Array.isArray(orgVerify.office_wifi_bssids)
                    ? orgVerify.office_wifi_bssids
                        .map((e: unknown) => (typeof e === "string" ? e : (e as { bssid?: string })?.bssid))
                        .filter(Boolean)
                        .map((b: string) => String(b).toUpperCase())
                    : [];
                const normalisedBssid = (typeof wifi_bssid === "string" && wifi_bssid.trim())
                    ? wifi_bssid.replace(/[^0-9a-fA-F]/g, "").toUpperCase()
                    : null;
                const formattedBssid = normalisedBssid && normalisedBssid.length === 12
                    ? normalisedBssid.match(/.{2}/g)!.join(":")
                    : null;
                const wifiMatch = !!(
                    orgVerify.office_wifi_verification_enabled &&
                    formattedBssid &&
                    officeBssids.includes(formattedBssid)
                );

                req.log.info({
                    wifi_verification_enabled: !!orgVerify.office_wifi_verification_enabled,
                    incoming_bssid_raw: wifi_bssid || null,
                    incoming_bssid_normalised: formattedBssid,
                    office_bssids: officeBssids,
                    wifi_match: wifiMatch,
                    work_mode: selectedWorkMode,
                }, "clock-in: wifi check");

                const needsLocation = (selectedWorkMode === "office" || selectedWorkMode === "hybrid") && !wifiMatch;
                if (wifiMatch) {
                    verifyMeta.verified_via = "wifi";
                    verifyMeta.clock_in_wifi_bssid = formattedBssid;
                    if (isValidLat(latitude) && isValidLng(longitude)) {
                        verifyMeta.clock_in_lat = Number(latitude);
                        verifyMeta.clock_in_lng = Number(longitude);
                        verifyMeta.clock_in_accuracy_m = accuracyM;
                        if (orgLat != null && orgLng != null) {
                            verifyMeta.clock_in_distance_m = Math.round(haversineMeters(Number(latitude), Number(longitude), orgLat, orgLng));
                        }
                    }
                    if (selectedWorkMode === "hybrid") selectedWorkMode = "office";
                }
                if (needsLocation) {
                    if (orgLat == null || orgLng == null) {
                        return res.status(400).json({
                            error: "Office location is not configured. Contact your admin or switch to remote.",
                            code: "OFFICE_LOCATION_NOT_CONFIGURED",
                        });
                    }
                    if (!isValidLat(latitude) || !isValidLng(longitude)) {
                        return res.status(400).json({
                            error: "Location is required to clock in from office. Please allow location access, or connect to the office Wi-Fi.",
                            code: "LOCATION_REQUIRED",
                        });
                    }
                    // Reject fixes that are too coarse to trust for a geofence
                    // decision — a 5 km-accurate IP/cell fix that happens to
                    // land inside the radius proves nothing, and spoofed
                    // payloads typically omit accuracy entirely.
                    const maxAccuracyM = Math.max(radiusM, 200);
                    if (selectedWorkMode === "office" && (accuracyM == null || accuracyM > maxAccuracyM)) {
                        return res.status(403).json({
                            error: accuracyM == null
                                ? "Your location fix has no accuracy reading. Enable precise location (GPS/Wi-Fi positioning) and try again, or connect to the office Wi-Fi."
                                : `Your location accuracy is ±${Math.round(accuracyM)} m — too coarse for the office geofence (max ±${maxAccuracyM} m). Enable precise location or connect to the office Wi-Fi.`,
                            code: "LOCATION_TOO_COARSE",
                            accuracy_m: accuracyM,
                            max_accuracy_m: maxAccuracyM,
                        });
                    }
                    const distance = Math.round(haversineMeters(Number(latitude), Number(longitude), orgLat, orgLng));
                    verifyMeta.clock_in_lat = Number(latitude);
                    verifyMeta.clock_in_lng = Number(longitude);
                    verifyMeta.clock_in_accuracy_m = accuracyM;
                    verifyMeta.clock_in_distance_m = distance;
                    if (formattedBssid) verifyMeta.clock_in_wifi_bssid = formattedBssid;

                    const inside = distance <= radiusM;
                    if (selectedWorkMode === "office" && !inside) {
                        let wifiHint = "";
                        if (!orgVerify.office_wifi_verification_enabled) {
                            wifiHint = " (Office Wi-Fi verification is disabled — ask an admin to enable it.)";
                        } else if (officeBssids.length === 0) {
                            wifiHint = " (No office Wi-Fi APs registered yet.)";
                        } else if (!formattedBssid) {
                            wifiHint = " Connect to the office Wi-Fi to skip the geofence check.";
                        } else if (!officeBssids.includes(formattedBssid)) {
                            wifiHint = ` Your network (${formattedBssid}) is not registered as an office AP — ask an admin to add it.`;
                        }
                        return res.status(403).json({
                            error: `You are ${distance} m from the office (allowed ${radiusM} m). Move closer or switch to remote.${wifiHint}`,
                            code: "OUTSIDE_GEOFENCE",
                            distance_m: distance,
                            radius_m: radiusM,
                            wifi: {
                                enabled: !!orgVerify.office_wifi_verification_enabled,
                                registered_count: officeBssids.length,
                                incoming_bssid: formattedBssid,
                                matched: false,
                            },
                        });
                    }
                    if (selectedWorkMode === "hybrid") {
                        selectedWorkMode = inside ? "office" : "remote";
                    }
                    if (inside) verifyMeta.verified_via = "geofence";
                }

                // Remote clock-in: no geofence enforcement, but capture the
                // location for the audit trail when the client provided one.
                if (!wifiMatch && !needsLocation && isValidLat(latitude) && isValidLng(longitude)) {
                    verifyMeta.clock_in_lat = Number(latitude);
                    verifyMeta.clock_in_lng = Number(longitude);
                    verifyMeta.clock_in_accuracy_m = accuracyM;
                    if (orgLat != null && orgLng != null) {
                        verifyMeta.clock_in_distance_m = Math.round(haversineMeters(Number(latitude), Number(longitude), orgLat, orgLng));
                    }
                }

                // Fingerprint fallback: when the client could not pass the face
                // scan it may fall back to the device biometric (fingerprint /
                // OS-level auth). We accept that ONLY when office presence has
                // already been proven above (wifi match or an inside-geofence
                // fix) - a fingerprint alone is NOT enough to clock in remotely.
                const fingerprintVerified = req.body?.fingerprint_verified === true;
                const officePresenceProven =
                    verifyMeta.verified_via === "wifi" || verifyMeta.verified_via === "geofence";
                if (fingerprintVerified) {
                    if (!officePresenceProven) {
                        return res.status(403).json({
                            error: "Fingerprint verification is only allowed from the office. Connect to the office Wi-Fi or move inside the office, then try again.",
                            code: "FINGERPRINT_LOCATION_REQUIRED",
                        });
                    }
                    verifyMeta.face_verified = false;
                    verifyMeta.verified_via = "fingerprint";
                    logAction(req, "clock_in_fingerprint_fallback", "time_entry", null, {});
                } else {
                // Lock out brute-force face attempts (per-user, sliding window).
                const failCount = await getFaceFailCount(req.tenantId, req.userId);
                if (failCount >= FACE_FAIL_LIMIT) {
                    logAction(req, "clock_in_face_locked", "time_entry", null, { fail_count: failCount });
                    return res.status(429).json({
                        error: "Too many failed face verification attempts. Please wait 15 minutes and try again, or contact your admin.",
                        code: "FACE_ATTEMPTS_LOCKED",
                    });
                }

                const enrolledRow = (await req.db!.query(
                    "SELECT face_descriptor FROM users WHERE id = $1",
                    [req.userId],
                )).rows[0];
                const enrolled = parseDescriptor(enrolledRow?.face_descriptor);
                if (!enrolled) {
                    return res.status(403).json({
                        error: "Please enroll your face from Profile → Face Enrollment before clocking in.",
                        code: "FACE_NOT_ENROLLED",
                    });
                }
                if (!isValidDescriptor(face_descriptor) || !isPlausibleDescriptor(face_descriptor)) {
                    return res.status(400).json({
                        error: "Face verification required. Please complete the face scan and try again.",
                        code: "FACE_REQUIRED",
                    });
                }
                // Replay guard: a fresh camera capture never reproduces the
                // exact embedding of a previous one. A (near-)identical
                // descriptor means a previously captured payload is being
                // re-submitted (e.g. via curl with a stolen token).
                try {
                    const lastDescriptor = await redis.get(faceKey(req.tenantId, "last", req.userId));
                    if (lastDescriptor && isDescriptorReplay(lastDescriptor, face_descriptor)) {
                        logAction(req, "clock_in_face_replay", "time_entry", null, {});
                        await bumpFaceFailCount(req.tenantId, req.userId);
                        return res.status(403).json({
                            error: "This face scan looks like a duplicate of a previous one. Please perform a fresh face scan.",
                            code: "FACE_REPLAY",
                        });
                    }
                } catch { /* redis unavailable — fail open */ }
                const cmp = compareDescriptors(enrolled, face_descriptor);
                verifyMeta.face_verified = cmp.match;
                verifyMeta.face_match_score = Number.isFinite(cmp.distance) ? Number(cmp.distance.toFixed(4)) : null;
                if (!cmp.match) {
                    await bumpFaceFailCount(req.tenantId, req.userId);
                    logAction(req, "clock_in_face_mismatch", "time_entry", null, {
                        distance: verifyMeta.face_match_score, threshold: cmp.threshold,
                    });
                    return res.status(403).json({
                        error: "Face didn't match your enrolled photo. Please ensure good lighting and try again.",
                        code: "FACE_MISMATCH",
                    });
                }
                // Success: reset the failure counter and remember this
                // descriptor so an exact replay of it is rejected next time.
                await clearFaceFailCount(req.tenantId, req.userId);
                try {
                    await redis.set(faceKey(req.tenantId, "last", req.userId), face_descriptor, FACE_LAST_DESCRIPTOR_TTL_SEC);
                } catch { /* best-effort */ }
                // Remote clock-ins have no wifi/geofence proof — record that
                // at least the face check passed.
                if (!verifyMeta.verified_via) verifyMeta.verified_via = "face";
                }
                }
        }

        const txResult = await (req.db as unknown as DbLike).transaction(async (client) => {
            const lastRes = await client.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
                   AND (is_manual IS NOT TRUE)
                 ORDER BY timestamp DESC, id DESC LIMIT 1`,
                [req.userId, today],
            );
            const lastEntry = lastRes.rows[0];
            if (lastEntry && lastEntry.entry_type !== "clock_out") {
                return { error: "Already logged in. Logout first." };
            }
            await client.query(
                `INSERT INTO time_entries
                    (user_id, entry_type, work_mode,
                     clock_in_lat, clock_in_lng, clock_in_accuracy_m, clock_in_distance_m,
                     face_verified, face_match_score,
                     verified_via, clock_in_wifi_bssid)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    req.userId, "clock_in", selectedWorkMode,
                    verifyMeta.clock_in_lat, verifyMeta.clock_in_lng,
                    verifyMeta.clock_in_accuracy_m, verifyMeta.clock_in_distance_m,
                    verifyMeta.face_verified, verifyMeta.face_match_score,
                    verifyMeta.verified_via, verifyMeta.clock_in_wifi_bssid,
                ],
            );
            return { ok: true };
        });

        if (txResult.error) return res.status(400).json({ error: txResult.error });

        await req.db!.query("UPDATE users SET timezone_offset = $1 WHERE id = $2", [tzOffset, req.userId]);
        logAction(req, "clock_in", "time_entry", null, {
            work_mode: selectedWorkMode,
            distance_m: verifyMeta.clock_in_distance_m,
            face_verified: verifyMeta.face_verified,
            verified_via: verifyMeta.verified_via,
            wifi_bssid: verifyMeta.clock_in_wifi_bssid,
        });
        res.json({
            message: "Logged in successfully",
            work_mode: selectedWorkMode,
            verified_via: verifyMeta.verified_via,
        });
    } catch (err) {
        req.log.error({ err }, "Clock-in error");
        res.status(500).json({ error: "Clock-in failed" });
    }
});

// Break start
router.post("/break-start", auth, async (req: Request, res: Response) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);

        const txResult = await (req.db as unknown as DbLike).transaction(async (client) => {
            const lastRes = await client.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
                   AND (approval_status IS NULL OR approval_status != 'rejected')
                 ORDER BY timestamp DESC, id DESC LIMIT 1`,
                [req.userId, today],
            );
            const lastEntry = lastRes.rows[0];
            if (!lastEntry || lastEntry.entry_type === "clock_out") return { error: "You must login first" };
            if (lastEntry.entry_type === "break_start") return { error: "Already on break" };
            await client.query(
                "INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)",
                [req.userId, "break_start"],
            );
            return { ok: true };
        });

        if (txResult.error) return res.status(400).json({ error: txResult.error });
        logAction(req, "break_start", "time_entry", null, {});
        res.json({ message: "Break started" });
    } catch (err) {
        req.log.error({ err }, "Break-start error");
        res.status(500).json({ error: "Failed to start break" });
    }
});

// Break end
router.post("/break-end", auth, async (req: Request, res: Response) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);

        const txResult = await (req.db as unknown as DbLike).transaction(async (client) => {
            const lastRes = await client.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
                   AND (approval_status IS NULL OR approval_status != 'rejected')
                 ORDER BY timestamp DESC, id DESC LIMIT 1`,
                [req.userId, today],
            );
            const lastEntry = lastRes.rows[0];
            if (!lastEntry || lastEntry.entry_type !== "break_start") return { error: "You are not on break" };
            await client.query(
                "INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)",
                [req.userId, "break_end"],
            );
            return { ok: true };
        });

        if (txResult.error) return res.status(400).json({ error: txResult.error });
        logAction(req, "break_end", "time_entry", null, {});
        res.json({ message: "Break ended, back to work!" });
    } catch (err) {
        req.log.error({ err }, "Break-end error");
        res.status(500).json({ error: "Failed to end break" });
    }
});

// Clock-out
router.post("/clock-out", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);

        // Office-presence gate: when the org enforces attendance verification,
        // a clock-out is only allowed from the office (matching office Wi-Fi
        // BSSID OR a GPS fix inside the geofence). This mirrors the clock-in
        // verification so employees cannot end their shift from home.
        if (req.userOrgId) {
            const orgVerify = (await req.db!.query(
                `SELECT attendance_verification_enabled, office_latitude, office_longitude, office_radius_m,
                        office_wifi_bssids, office_wifi_verification_enabled
                 FROM organizations WHERE id = $1`,
                [req.userOrgId],
            )).rows[0];

            if (orgVerify?.attendance_verification_enabled) {
                // Only enforce when the CURRENT open session was an office
                // clock-in. Remote sessions carry no office proof, so requiring
                // office presence to end them would trap the employee.
                const openClockIn = (await req.db!.query(
                    `SELECT work_mode FROM time_entries
                     WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
                       AND entry_type = 'clock_in'
                       AND (approval_status IS NULL OR approval_status != 'rejected')
                     ORDER BY timestamp DESC, id DESC LIMIT 1`,
                    [req.userId, today],
                )).rows[0];

                if (openClockIn?.work_mode === "office") {
                    const { latitude, longitude, accuracy, wifi_bssid } = req.body || {};
                    const orgLat = orgVerify.office_latitude != null ? Number(orgVerify.office_latitude) : null;
                    const orgLng = orgVerify.office_longitude != null ? Number(orgVerify.office_longitude) : null;
                    const radiusM = Number(orgVerify.office_radius_m) || 150;
                    const accuracyM = (accuracy != null && Number.isFinite(Number(accuracy)) && Number(accuracy) >= 0)
                        ? Number(accuracy)
                        : null;

                    const officeBssids = Array.isArray(orgVerify.office_wifi_bssids)
                        ? orgVerify.office_wifi_bssids
                            .map((e: unknown) => (typeof e === "string" ? e : (e as { bssid?: string })?.bssid))
                            .filter(Boolean)
                            .map((b: string) => String(b).toUpperCase())
                        : [];
                    const normalisedBssid = (typeof wifi_bssid === "string" && wifi_bssid.trim())
                        ? wifi_bssid.replace(/[^0-9a-fA-F]/g, "").toUpperCase()
                        : null;
                    const formattedBssid = normalisedBssid && normalisedBssid.length === 12
                        ? normalisedBssid.match(/.{2}/g)!.join(":")
                        : null;
                    const wifiMatch = !!(
                        orgVerify.office_wifi_verification_enabled &&
                        formattedBssid &&
                        officeBssids.includes(formattedBssid)
                    );

                    if (!wifiMatch) {
                        if (orgLat == null || orgLng == null) {
                            return res.status(400).json({
                                error: "Office location is not configured. Contact your admin.",
                                code: "OFFICE_LOCATION_NOT_CONFIGURED",
                            });
                        }
                        if (!isValidLat(latitude) || !isValidLng(longitude)) {
                            return res.status(400).json({
                                error: "Location is required to clock out from office. Please allow location access, or connect to the office Wi-Fi.",
                                code: "LOCATION_REQUIRED",
                            });
                        }
                        const maxAccuracyM = Math.max(radiusM, 200);
                        if (accuracyM == null || accuracyM > maxAccuracyM) {
                            return res.status(403).json({
                                error: accuracyM == null
                                    ? "Your location fix has no accuracy reading. Enable precise location (GPS/Wi-Fi positioning) and try again, or connect to the office Wi-Fi."
                                    : `Your location accuracy is ~${Math.round(accuracyM)} m - too coarse for the office geofence (max ~${maxAccuracyM} m). Enable precise location or connect to the office Wi-Fi.`,
                                code: "LOCATION_TOO_COARSE",
                            });
                        }
                        const distance = Math.round(haversineMeters(Number(latitude), Number(longitude), orgLat, orgLng));
                        if (distance > radiusM) {
                            return res.status(403).json({
                                error: `You are ${distance} m from the office (allowed ${radiusM} m). Clock-out is only allowed from the office. Move closer or connect to the office Wi-Fi.`,
                                code: "OUTSIDE_GEOFENCE",
                                distance_m: distance,
                                radius_m: radiusM,
                            });
                        }
                    }

                    // Identity gate: office presence is now proven (Wi-Fi match
                    // or an inside-geofence GPS fix). Mirror the clock-in flow
                    // and ALSO verify WHO is clocking out - via the enrolled
                    // face descriptor, or the device fingerprint fallback. This
                    // never runs for remote sessions (the outer work_mode check).
                    const { face_descriptor } = req.body || {};
                    const fingerprintVerified = req.body?.fingerprint_verified === true;

                    if (fingerprintVerified) {
                        // Fingerprint fallback is accepted only because office
                        // presence was already proven immediately above.
                        logAction(req, "clock_out_fingerprint_fallback", "time_entry", null, {});
                    } else {
                        // Lock out brute-force face attempts (per-user, sliding window).
                        const failCount = await getFaceFailCount(req.tenantId, req.userId);
                        if (failCount >= FACE_FAIL_LIMIT) {
                            logAction(req, "clock_out_face_locked", "time_entry", null, { fail_count: failCount });
                            return res.status(429).json({
                                error: "Too many failed face verification attempts. Please wait 15 minutes and try again, or contact your admin.",
                                code: "FACE_ATTEMPTS_LOCKED",
                            });
                        }

                        const enrolledRow = (await req.db!.query(
                            "SELECT face_descriptor FROM users WHERE id = $1",
                            [req.userId],
                        )).rows[0];
                        const enrolled = parseDescriptor(enrolledRow?.face_descriptor);
                        if (!enrolled) {
                            return res.status(403).json({
                                error: "Please enroll your face from Profile → Face Enrollment before clocking out.",
                                code: "FACE_NOT_ENROLLED",
                            });
                        }
                        if (!isValidDescriptor(face_descriptor) || !isPlausibleDescriptor(face_descriptor)) {
                            return res.status(400).json({
                                error: "Face verification required. Please complete the face scan and try again.",
                                code: "FACE_REQUIRED",
                            });
                        }
                        // Replay guard: a fresh capture never reproduces the exact
                        // embedding of a previous one; a (near-)identical descriptor
                        // means a captured payload is being re-submitted.
                        try {
                            const lastDescriptor = await redis.get(faceKey(req.tenantId, "last", req.userId));
                            if (lastDescriptor && isDescriptorReplay(lastDescriptor, face_descriptor)) {
                                logAction(req, "clock_out_face_replay", "time_entry", null, {});
                                await bumpFaceFailCount(req.tenantId, req.userId);
                                return res.status(403).json({
                                    error: "This face scan looks like a duplicate of a previous one. Please perform a fresh face scan.",
                                    code: "FACE_REPLAY",
                                });
                            }
                        } catch { /* redis unavailable — fail open */ }
                        const cmp = compareDescriptors(enrolled, face_descriptor);
                        if (!cmp.match) {
                            await bumpFaceFailCount(req.tenantId, req.userId);
                            logAction(req, "clock_out_face_mismatch", "time_entry", null, {
                                distance: Number.isFinite(cmp.distance) ? Number(cmp.distance.toFixed(4)) : null,
                                threshold: cmp.threshold,
                            });
                            return res.status(403).json({
                                error: "Face didn't match your enrolled photo. Please ensure good lighting and try again.",
                                code: "FACE_MISMATCH",
                            });
                        }
                        // Success: reset the failure counter and remember this
                        // descriptor so an exact replay of it is rejected next time.
                        await clearFaceFailCount(req.tenantId, req.userId);
                        try {
                            await redis.set(faceKey(req.tenantId, "last", req.userId), face_descriptor, FACE_LAST_DESCRIPTOR_TTL_SEC);
                        } catch { /* best-effort */ }
                    }

                }
            }
        }
        const txResult = await (req.db as unknown as DbLike).transaction(async (client) => {
            const lastRes = await client.query(
                `SELECT * FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
                   AND (approval_status IS NULL OR approval_status != 'rejected')
                 ORDER BY timestamp DESC, id DESC LIMIT 1`,
                [req.userId, today],
            );
            const lastEntry = lastRes.rows[0];
            if (!lastEntry || lastEntry.entry_type === "clock_out") return { error: "You are not logged in" };
            if (lastEntry.entry_type === "break_start") {
                await client.query(
                    "INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)",
                    [req.userId, "break_end"],
                );
            }
            await client.query(
                "INSERT INTO time_entries (user_id, entry_type) VALUES ($1, $2)",
                [req.userId, "clock_out"],
            );
            return { ok: true };
        });

        if (txResult.error) return res.status(400).json({ error: txResult.error });

        logAction(req, "clock_out", "time_entry", null, {});
        res.json({ message: "Logged out. See you tomorrow!" });
    } catch (err) {
        req.log.error({ err }, "Clock-out error");
        res.status(500).json({ error: "Clock-out failed" });
    }
});

// Get history for a date range
router.get("/history", auth, async (req: Request, res: Response) => {
    try {
        const { from, to } = req.query as { from?: string; to?: string };
        const offsetMin = getOffsetMin(req);
        const fromDate = from || new Date(Date.now() - offsetMin * 60000 - 30 * 86400000).toISOString().slice(0, 10);
        const toDate = to || getLocalToday(req);
        const tzMod = getTzModifier(req);

        const result = await req.db!.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1
               AND ${pgDateInTz("timestamp", tzMod)} BETWEEN $2::date AND $3::date
               AND (approval_status IS NULL OR approval_status != 'rejected')
             ORDER BY timestamp ASC`,
            [req.userId, fromDate, toDate],
        );

        const grouped: Record<string, TimeEntry[]> = {};
        result.rows.forEach((e: TimeEntry) => {
            const date = getLocalDateFromTs(e.timestamp, req);
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(e);
        });

        const today = getLocalToday(req);
        const dailySummaries = Object.keys(grouped).sort().map((date) => {
            // Cap an unterminated session at "now" for today, else end-of-local-day,
            // so a never-clocked-out / overnight session is credited (not shown as 0).
            const capMs = date >= today ? Date.now() : endOfLocalDayMs(date, offsetMin);
            const summary = computeDaySummary(grouped[date], true, capMs);
            return { date, ...summary };
        });

        res.json(dailySummaries);
    } catch (err) {
        req.log.error({ err }, "History error");
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

// Analytics (weekly chart)
router.get("/analytics", auth, async (req: Request, res: Response) => {
    try {
        const { days, from, to } = req.query as { days?: string; from?: string; to?: string };
        const offsetMin = getOffsetMin(req);
        let fromDate; let toDate; let numDays;

        if (from && to) {
            fromDate = from;
            toDate = to;
            numDays = Math.round((new Date(to + "T00:00:00Z").getTime() - new Date(from + "T00:00:00Z").getTime()) / 86400000) + 1;
            numDays = Math.min(Math.max(numDays, 1), 365);
        } else {
            numDays = Math.min(Math.max(parseInt(String(days)) || 7, 1), 365);
            fromDate = new Date(Date.now() - offsetMin * 60000 - numDays * 86400000).toISOString().slice(0, 10);
            toDate = getLocalToday(req);
        }

        const tzMod = getTzModifier(req);

        const result = await req.db!.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1
               AND ${pgDateInTz("timestamp", tzMod)} BETWEEN $2::date AND $3::date
               AND (approval_status IS NULL OR approval_status != 'rejected')
             ORDER BY timestamp ASC`,
            [req.userId, fromDate, toDate],
        );

        const grouped: Record<string, TimeEntry[]> = {};
        result.rows.forEach((e: TimeEntry) => {
            const date = getLocalDateFromTs(e.timestamp, req);
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(e);
        });

        const today = getLocalToday(req);
        const analytics = [];
        const startMs = new Date(fromDate + "T00:00:00Z").getTime();
        for (let i = 0; i < numDays; i++) {
            const d = new Date(startMs + i * 86400000);
            const dateStr = d.toISOString().slice(0, 10);
            const capMs = dateStr >= today ? Date.now() : endOfLocalDayMs(dateStr, offsetMin);
            const summary = computeDaySummary(grouped[dateStr] || [], true, capMs);
            analytics.push({ date: dateStr, ...summary });
        }

        res.json(analytics);
    } catch (err) {
        req.log.error({ err }, "Analytics error");
        res.status(500).json({ error: "Failed to fetch analytics" });
    }
});

// Get pending manual entries for current user
router.get("/manual-entries", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const result = await req.db!.query(
            `SELECT ar.id as request_id, ar.status as approval_status, ar.metadata, ar.created_at,
                    ar.reviewed_at, ar.reject_reason, u.full_name as approver_name
             FROM approval_requests ar
             LEFT JOIN users u ON u.id = ar.approver_id
             WHERE ar.requester_id = $1 AND ar.type = 'manual_entry'
             ORDER BY ar.created_at DESC
             LIMIT 50`,
            [req.userId],
        );
        res.json(result.rows.map((e: { metadata: string | null; [key: string]: unknown }) => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : null })));
    } catch (err) {
        req.log.error({ err }, "Manual entries error");
        res.status(500).json({ error: "Failed to fetch manual entries" });
    }
});

// Add a complete manual day entry
router.post("/manual-entry", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const { date, clock_in, clock_out, breaks, timezoneOffset, work_mode } = req.body;

        if (!date || !clock_in) return res.status(400).json({ error: "Date and login time are required" });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
        if (date > getLocalToday(req)) {
            return res.status(400).json({ error: "Cannot add a manual entry for a future date" });
        }

        if (!isValidTime(clock_in) || (clock_out && !isValidTime(clock_out))) {
            return res.status(400).json({ error: "Invalid time format. Use HH:MM (00:00–23:59)" });
        }
        if (clock_out && clock_out <= clock_in) {
            return res.status(400).json({ error: "Logout time must be after login time" });
        }

        if (typeof timezoneOffset === "number" && (timezoneOffset < -840 || timezoneOffset > 720)) {
            return res.status(400).json({ error: "Invalid timezone offset" });
        }
        const offsetMs = (typeof timezoneOffset === "number") ? timezoneOffset * 60000 : 0;
        function toUTC(dateStr: string, timeStr: string): string {
            const [year, month, day] = dateStr.split("-").map(Number);
            const [hours, minutes] = timeStr.split(":").map(Number);
            return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0) + offsetMs).toISOString();
        }

        if (breaks && Array.isArray(breaks)) {
            if (breaks.length > 20) return res.status(400).json({ error: "Maximum 20 breaks allowed per day" });
            const sorted = [...breaks].sort((a, b) => (a.start || "").localeCompare(b.start || ""));
            for (let i = 0; i < sorted.length; i++) {
                const brk = sorted[i];
                if (!brk.start || !brk.end || !isValidTime(brk.start) || !isValidTime(brk.end)) {
                    return res.status(400).json({ error: "Each break must have valid start and end times (HH:MM, 00:00–23:59)" });
                }
                if (brk.end <= brk.start) return res.status(400).json({ error: "Break end time must be after break start time" });
                if (brk.start < clock_in || (clock_out && brk.end > clock_out)) {
                    return res.status(400).json({ error: "Break times must be within clock-in and clock-out times" });
                }
                if (i < sorted.length - 1 && brk.end > sorted[i + 1].start) {
                    return res.status(400).json({ error: "Break times must not overlap" });
                }
            }
            if (clock_out) {
                let totalBreakMin = 0;
                for (const brk of sorted) {
                    const [sh, sm] = brk.start.split(":").map(Number);
                    const [eh, em] = brk.end.split(":").map(Number);
                    totalBreakMin += (eh * 60 + em) - (sh * 60 + sm);
                }
                const [cih, cim] = clock_in.split(":").map(Number);
                const [coh, com] = clock_out.split(":").map(Number);
                const workMin = (coh * 60 + com) - (cih * 60 + cim);
                if (totalBreakMin >= workMin) {
                    return res.status(400).json({ error: "Total break duration cannot exceed work duration" });
                }
            }
        }

        const tzMod = getTzModifier(req);
        const existingRes = await req.db!.query(
            `SELECT COUNT(*) AS count FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date`,
            [req.userId, date],
        );
        if (parseInt(existingRes.rows[0].count, 10) > 0) {
            return res.status(400).json({ error: "Entries already exist for this date. Delete them first to add manual entries." });
        }

        const leaveRes = await req.db!.query(
            "SELECT id, leave_type FROM leaves WHERE user_id = $1 AND date = $2",
            [req.userId, date],
        );
        if (leaveRes.rows[0]) {
            return res.status(400).json({ error: `You have a ${leaveRes.rows[0].leave_type} leave on this date. Remove the leave first to add a manual entry.` });
        }

        if (req.userOrgId) {
            const lockedPeriod = (await req.db!.query(
                `SELECT label FROM pay_periods WHERE org_id = $1 AND start_date <= $2 AND end_date >= $2`,
                [req.userOrgId, date],
            )).rows[0];
            if (lockedPeriod) {
                return res.status(400).json({ error: `This date is in a locked pay period (${lockedPeriod.label}). Time entries cannot be modified.` });
            }
        }

        const isSuperAdmin = req.userRole === "super_admin";
        let approvalStatus = isSuperAdmin ? "approved" : "pending";
        let needsApproval = !isSuperAdmin;

        const clockInTs = toUTC(date, clock_in);
        const clockOutTs = clock_out ? toUTC(date, clock_out) : null;
        let txApprover: any = null;

        await (req.db as unknown as DbLike).transaction(async (client) => {
            const ins = (uid: number | undefined, type: string, ts: string, wm: string | null) => client.query(
                "INSERT INTO time_entries (user_id, entry_type, timestamp, work_mode, is_manual, approval_status) VALUES ($1,$2,$3,$4,TRUE,$5)",
                [uid, type, ts, wm || null, approvalStatus],
            );
            await ins(req.userId, "clock_in", clockInTs, VALID_WORK_MODES.includes(work_mode) ? work_mode : "office");
            if (breaks && Array.isArray(breaks)) {
                const sorted = [...breaks].sort((a, b) => a.start.localeCompare(b.start));
                for (const brk of sorted) {
                    await ins(req.userId, "break_start", toUTC(date, brk.start), null);
                    await ins(req.userId, "break_end", toUTC(date, brk.end), null);
                }
            }
            if (clockOutTs) await ins(req.userId, "clock_out", clockOutTs, null);

            if (needsApproval) {
                const approver = await findApprover(req.db, req.userId, req.userOrgId);
                txApprover = approver;
                await client.query(
                    `INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
                     VALUES ($1,$2,$3,'manual_entry',NULL,$4,$5)`,
                    [req.userOrgId || null, req.userId, approver?.id || null, "Manual time entry",
                    JSON.stringify({ date, clock_in, clock_out: clock_out || null, work_mode: VALID_WORK_MODES.includes(work_mode) ? work_mode : "office" })],
                );
            }
        });

        // Respond immediately after the transaction commits. The
        // notification / WebSocket fan-out below runs in the background so a
        // slow notification insert (or a cold tenant DB pool on the first write
        // after an idle period) never delays the HTTP response. Mobile clients
        // enforce a request timeout and were surfacing false "failed to update"
        // errors even though the row was already committed — the web client has
        // no axios timeout so it never noticed.
        logAction(req, "create", "manual_entry", null, { date, clock_in, clock_out: clock_out || null, status: approvalStatus });
        res.json({
            message: needsApproval ? "Manual entry submitted for approval" : "Manual entry added successfully",
            status: approvalStatus,
            needsApproval,
        });

        if (needsApproval && txApprover?.id) {
            void (async () => {
                try {
                    const requesterName = (await req.db!.query("SELECT full_name FROM users WHERE id = $1", [req.userId])).rows[0]?.full_name || "A team member";
                    await req.db!.query(
                        "INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)",
                        [txApprover.id, "approval", "New Manual Entry Request", `${requesterName} submitted a manual time entry for ${date}.`],
                    );
                    sendToUser(req.tenantId, txApprover.id, "approval_update", { type: "manual_entry", status: "pending" });
                } catch (notifErr) {
                    req.log.error({ err: notifErr }, "Manager notification error (manual entry)");
                }
            })();
        }
    } catch (err) {
        req.log.error({ err }, "Manual entry error");
        res.status(500).json({ error: "Failed to add manual entry" });
    }
});

// Edit a manual day entry
router.put("/manual-entry/:date", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const date = String(req.params.date);
        const { clock_in, clock_out, breaks, timezoneOffset, work_mode } = req.body;

        if (!date || !clock_in) return res.status(400).json({ error: "Date and login time are required" });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
        if (date > getLocalToday(req)) {
            return res.status(400).json({ error: "Cannot set a manual entry for a future date" });
        }

        if (!isValidTime(clock_in) || (clock_out && !isValidTime(clock_out))) {
            return res.status(400).json({ error: "Invalid time format. Use HH:MM (00:00–23:59)" });
        }
        if (clock_out && clock_out <= clock_in) return res.status(400).json({ error: "Logout time must be after login time" });

        if (breaks && Array.isArray(breaks)) {
            if (breaks.length > 20) return res.status(400).json({ error: "Maximum 20 breaks allowed" });
            const sorted = [...breaks].sort((a, b) => (a.start || "").localeCompare(b.start || ""));
            for (let i = 0; i < sorted.length; i++) {
                const brk = sorted[i];
                if (!brk.start || !brk.end || !isValidTime(brk.start) || !isValidTime(brk.end)) {
                    return res.status(400).json({ error: "Each break must have valid start and end times (HH:MM, 00:00–23:59)" });
                }
                if (brk.end <= brk.start) return res.status(400).json({ error: "Break end must be after start" });
                if (brk.start < clock_in || (clock_out && brk.end > clock_out)) {
                    return res.status(400).json({ error: "Break times must be within clock-in/out" });
                }
                if (i < sorted.length - 1 && brk.end > sorted[i + 1].start) {
                    return res.status(400).json({ error: "Break times must not overlap" });
                }
            }
            if (clock_out) {
                let totalBreakMin = 0;
                for (const brk of sorted) {
                    const [sh, sm] = brk.start.split(":").map(Number);
                    const [eh, em] = brk.end.split(":").map(Number);
                    totalBreakMin += (eh * 60 + em) - (sh * 60 + sm);
                }
                const [cih, cim] = clock_in.split(":").map(Number);
                const [coh, com] = clock_out.split(":").map(Number);
                const workMin = (coh * 60 + com) - (cih * 60 + cim);
                if (totalBreakMin >= workMin) {
                    return res.status(400).json({ error: "Total break duration cannot exceed work duration" });
                }
            }
        }

        if (typeof timezoneOffset === "number" && (timezoneOffset < -840 || timezoneOffset > 720)) {
            return res.status(400).json({ error: "Invalid timezone offset" });
        }
        const offsetMs = (typeof timezoneOffset === "number") ? timezoneOffset * 60000 : 0;
        function toUTC(dateStr: string, timeStr: string): string {
            const [year, month, day] = dateStr.split("-").map(Number);
            const [hours, minutes] = timeStr.split(":").map(Number);
            return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0) + offsetMs).toISOString();
        }

        if (req.userOrgId) {
            const lockedPeriod = (await req.db!.query(
                `SELECT label FROM pay_periods WHERE org_id = $1 AND start_date <= $2 AND end_date >= $2`,
                [req.userOrgId, date],
            )).rows[0];
            if (lockedPeriod) {
                return res.status(400).json({ error: `This date is in a locked pay period (${lockedPeriod.label}). Time entries cannot be modified.` });
            }
        }

        // Same conflict rule as POST: a manual entry can't coexist with a leave.
        const leaveRes = await req.db!.query(
            "SELECT id, leave_type FROM leaves WHERE user_id = $1 AND date = $2",
            [req.userId, date],
        );
        if (leaveRes.rows[0]) {
            return res.status(400).json({ error: `You have a ${leaveRes.rows[0].leave_type} leave on this date. Remove the leave first to edit a manual entry.` });
        }

        const isSuperAdmin = req.userRole === "super_admin";
        let approvalStatus = isSuperAdmin ? "approved" : "pending";
        let needsApproval = !isSuperAdmin;

        const tzMod = getTzModifier(req);
        const resolvedWorkMode = VALID_WORK_MODES.includes(work_mode) ? work_mode : "office";

        // Normalise the proposed breaks so both the immediate-apply path and
        // the pending-approval metadata share an identical, sorted shape.
        const normalizedBreaks = (breaks && Array.isArray(breaks))
            ? [...breaks]
                .filter((b) => b && b.start && b.end)
                .sort((a, b) => a.start.localeCompare(b.start))
                .map((b) => ({ start: b.start, end: b.end }))
            : [];

        // Detect whether this date holds "protected" data - already-APPROVED
        // entries or live-tracked (non-manual) entries that carry face/location
        // verification. Such days are no longer hard-blocked from editing:
        // non-super-admins may edit them, but the change is held as a PENDING
        // approval request WITHOUT touching the original rows, so the verified
        // record stays the source of truth until a manager approves.
        // (super_admin still applies edits immediately.)
        let hasProtectedData = false;
        if (!isSuperAdmin) {
            const protectedRes = await req.db!.query(
                `SELECT 1 FROM time_entries
                 WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
                   AND (approval_status = 'approved' OR is_manual IS NOT TRUE)
                 LIMIT 1`,
                [req.userId, date],
            );
            hasProtectedData = protectedRes.rowCount > 0;
        }

        const clockInTs = toUTC(date, clock_in);
        const clockOutTs = clock_out ? toUTC(date, clock_out) : null;
        let txApproverEdit: any = null;

        // Full proposed day, stored on the approval request so the manager's
        // approve handler can apply it non-destructively. `edit: true` marks
        // this as an edit-request payload (vs a legacy in-place pending edit).
        const proposedDay = {
            date,
            clock_in,
            clock_out: clock_out || null,
            breaks: normalizedBreaks,
            work_mode: resolvedWorkMode,
            timezone_offset: (typeof timezoneOffset === "number") ? timezoneOffset : 0,
            edit: true,
        };

        if (hasProtectedData) {
            // NON-DESTRUCTIVE PATH: keep existing verified entries intact.
            // Supersede any prior pending edit request for this date, then
            // insert a fresh pending request carrying the full proposed day.
            await (req.db as unknown as DbLike).transaction(async (client) => {
                await client.query(
                    `UPDATE approval_requests
                     SET status = 'rejected', reject_reason = 'Superseded by edit'
                     WHERE requester_id = $1 AND type = 'manual_entry' AND status = 'pending'
                       AND metadata::jsonb->>'date' = $2`,
                    [req.userId, date],
                );
                const approver = await findApprover(req.db, req.userId, req.userOrgId);
                txApproverEdit = approver;
                await client.query(
                    `INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
                     VALUES ($1,$2,$3,'manual_entry',NULL,$4,$5)`,
                    [req.userOrgId || null, req.userId, approver?.id || null, "Manual time entry (edit request)",
                    JSON.stringify(proposedDay)],
                );
            });
        } else {
            // NO PROTECTED DATA: only pending manual rows (or none) exist, so
            // nothing verified is lost. Apply delete-and-reinsert directly
            // (immediately for super_admin; as pending rows otherwise).
            await (req.db as unknown as DbLike).transaction(async (client) => {
                await client.query(
                    `UPDATE approval_requests
                     SET status = 'rejected', reject_reason = 'Superseded by edit'
                     WHERE requester_id = $1 AND type = 'manual_entry' AND status = 'pending'
                       AND metadata::jsonb->>'date' = $2`,
                    [req.userId, date],
                );
                await client.query(
                    `DELETE FROM time_entries WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date`,
                    [req.userId, date],
                );
                const ins = (uid: number | undefined, type: string, ts: string, wm: string | null) => client.query(
                    "INSERT INTO time_entries (user_id, entry_type, timestamp, work_mode, is_manual, approval_status) VALUES ($1,$2,$3,$4,TRUE,$5)",
                    [uid, type, ts, wm || null, approvalStatus],
                );
                await ins(req.userId, "clock_in", clockInTs, resolvedWorkMode);
                for (const brk of normalizedBreaks) {
                    await ins(req.userId, "break_start", toUTC(date, brk.start), null);
                    await ins(req.userId, "break_end", toUTC(date, brk.end), null);
                }
                if (clockOutTs) await ins(req.userId, "clock_out", clockOutTs, null);
                if (needsApproval) {
                    const approver = await findApprover(req.db, req.userId, req.userOrgId);
                    txApproverEdit = approver;
                    await client.query(
                        `INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
                         VALUES ($1,$2,$3,'manual_entry',NULL,$4,$5)`,
                        [req.userOrgId || null, req.userId, approver?.id || null, "Manual time entry (edited)",
                        JSON.stringify({ date, clock_in, clock_out: clock_out || null, work_mode: resolvedWorkMode })],
                    );
                }
            });
        }

        // When protected data exists the change is always pending approval.
        const isPendingEdit = hasProtectedData || needsApproval;

        // Respond immediately after the transaction commits — see the POST
        // handler above for why the notification fan-out is deferred.
        logAction(req, "update", "manual_entry", null, { date, clock_in, clock_out: clock_out || null, status: isPendingEdit ? "pending" : approvalStatus, non_destructive: hasProtectedData });
        res.json({
            message: isPendingEdit ? "Your edit was submitted for manager approval. Your original entries stay in place until it is approved." : "Entry updated successfully",
            status: isPendingEdit ? "pending" : approvalStatus,
            needsApproval: isPendingEdit,
        });

        if (isPendingEdit && txApproverEdit?.id) {
            void (async () => {
                try {
                    const requesterName = (await req.db!.query("SELECT full_name FROM users WHERE id = $1", [req.userId])).rows[0]?.full_name || "A team member";
                    await req.db!.query(
                        "INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)",
                        [txApproverEdit.id, "approval", "Manual Entry Updated", `${requesterName} updated a manual time entry for ${date}.`],
                    );
                    sendToUser(req.tenantId, txApproverEdit.id, "approval_update", { type: "manual_entry", status: "pending" });
                } catch (notifErr) {
                    req.log.error({ err: notifErr }, "Manager notification error (manual entry edit)");
                }
            })();
        }
    } catch (err) {
        req.log.error({ err }, "Manual entry edit error");
        res.status(500).json({ error: "Failed to update entry" });
    }
});

// Delete all entries for a date
router.delete("/entries/:date", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const date = String(req.params.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format" });

        if (req.userOrgId) {
            const lockedPeriod = (await req.db!.query(
                `SELECT label FROM pay_periods WHERE org_id = $1 AND start_date <= $2 AND end_date >= $2`,
                [req.userOrgId, date],
            )).rows[0];
            if (lockedPeriod) {
                return res.status(400).json({ error: `This date is in a locked pay period (${lockedPeriod.label}). Time entries cannot be deleted.` });
            }
        }

        const tzMod = getTzModifier(req);
        const protectedRes = await req.db!.query(
            `SELECT 1 FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
               AND approval_status IN ('pending','approved')
             LIMIT 1`,
            [req.userId, date],
        );
        if (protectedRes.rowCount > 0) {
            return res.status(403).json({ error: "Cannot delete entries that are pending approval or already approved. Contact your manager." });
        }

        const result = await req.db!.query(
            `DELETE FROM time_entries WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date`,
            [req.userId, date],
        );
        res.json({ message: `Deleted ${result.rowCount} entries for ${date}` });
    } catch (err) {
        req.log.error({ err }, "Delete entries error");
        res.status(500).json({ error: "Failed to delete entries" });
    }
});

// Get entries for a specific date
router.get("/entries/:date", auth, async (req: Request, res: Response) => {
    try {
        const date = String(req.params.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format" });
        const tzMod = getTzModifier(req);
        const result = await req.db!.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} = $2::date
             ORDER BY timestamp ASC`,
            [req.userId, date],
        );
        res.json(result.rows);
    } catch (err) {
        req.log.error({ err }, "Get entries error");
        res.status(500).json({ error: "Failed to fetch entries" });
    }
});

// Dashboard widgets
router.get("/widgets", auth, async (req: Request, res: Response) => {
    try {
        const today = getLocalToday(req);
        const tzMod = getTzModifier(req);
        const offsetMin = getOffsetMin(req);

        const entriesRes = await req.db!.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} >= ($2::date - INTERVAL '30 days')
              AND (approval_status IS NULL OR approval_status != 'rejected')
             ORDER BY timestamp ASC`,
            [req.userId, today],
        );

        const grouped: Record<string, TimeEntry[]> = {};
        entriesRes.rows.forEach((e: TimeEntry) => {
            const date = getLocalDateFromTs(e.timestamp, req);
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(e);
        });

        const monthStart = today.slice(0, 7) + "-01";
        let leaveCount = 0;
        let leaveDatesSet = new Set<string>();
        try {
            const leaveRes = await req.db!.query(
                `SELECT date FROM leaves WHERE user_id = $1 AND status = 'approved' AND date::date >= $2::date - INTERVAL '60 days' AND date::date <= $3::date`,
                [req.userId, today, today],
            );
            leaveRes.rows.forEach((r: { date: string }) => leaveDatesSet.add(r.date));
            leaveRes.rows.forEach((r: { date: string }) => { if (r.date >= monthStart) leaveCount++; });
        } catch (_) { /* ignore */ }

        const orgRow = (await req.db!.query(
            `SELECT u.org_id FROM users u WHERE u.id = $1`,
            [req.userId],
        )).rows[0];
        const orgConfig = await getOrgWorkConfig(orgRow?.org_id, req.db as unknown as DbLike, req.tenantId);
        let totalFloorMin = 0; let workDays = 0; let targetMetDays = 0; let officeDays = 0; let remoteDays = 0;
        const orgWhpd = orgConfig.work_hours_per_day || 8;
        const minHoursPresent = (
            orgConfig.min_hours_present != null
            && Number(orgConfig.min_hours_present) >= 0
        )
            ? Number(orgConfig.min_hours_present)
            : orgWhpd / 2;
        const minPresentMinutes = minHoursPresent * 60;
        const TARGET = orgWhpd * 60;
        const floorByDate: Record<string, number> = {};

        Object.keys(grouped).forEach((date) => {
            const dayEntries = grouped[date];
            if (!dayEntries.some((e) => e.entry_type === "clock_in")) return;
            workDays++;
            const capMs = date >= today ? Date.now() : endOfLocalDayMs(date, offsetMin);
            const summary = computeDaySummary(dayEntries, true, capMs);
            floorByDate[date] = summary.floorMinutes;
            totalFloorMin += summary.floorMinutes;
            if (summary.floorMinutes >= TARGET) targetMetDays++;
            if (summary.workMode === "remote") remoteDays++;
            else officeDays++;
        });

        const avgFloorMinutes = workDays > 0 ? Math.round(totalFloorMin / workDays) : 0;

        let earlyDays = 0;
        Object.values(grouped).forEach((dayEntries) => {
            const ci = dayEntries.find((e) => e.entry_type === "clock_in");
            if (ci) {
                const utcMs = new Date(ci.timestamp).getTime();
                const localDate = new Date(utcMs - offsetMin * 60000);
                const h = localDate.getUTCHours();
                const m = localDate.getUTCMinutes();
                if (h < 10 || (h === 10 && m === 0)) earlyDays++;
            }
        });
        const punctualityPercent = workDays > 0 ? Math.round((earlyDays / workDays) * 100) : 0;

        const workDaySet = parseWorkDays(orgConfig.work_days || null);
        let monthPresentDays = 0;
        Object.keys(grouped).forEach((date) => {
            if (date < monthStart || date > today) return;
            const jsDow = new Date(date + "T00:00:00Z").getUTCDay();
            if (!isJsDowWorkDay(jsDow, workDaySet)) return;
            if ((floorByDate[date] || 0) >= minPresentMinutes) {
                monthPresentDays++;
            }
        });
        const monthStartDate = new Date(monthStart + "T00:00:00Z");
        const todayDate = new Date(today + "T00:00:00Z");
        let totalWeekdays = 0;
        for (let d = new Date(monthStartDate); d <= todayDate; d.setDate(d.getDate() + 1)) {
            if (isJsDowWorkDay(d.getUTCDay(), workDaySet)) totalWeekdays++;
        }
        const presentDays = monthPresentDays + leaveCount;
        const attendancePercent = totalWeekdays > 0 ? Math.min(100, Math.round((presentDays / totalWeekdays) * 100)) : 0;

        res.json({ avgFloorMinutes, punctualityPercent, attendancePercent, targetMetDays, workDays, totalWeekdays, leaveCount, officeDays, remoteDays });
    } catch (err) {
        req.log.error({ err }, "Widgets error");
        res.status(500).json({ error: "Failed to fetch widgets" });
    }
});

// Weekly chart data
router.get("/weekly", auth, async (req: Request, res: Response) => {
    try {
        const offsetMin = getOffsetMin(req);
        const now = new Date(Date.now() - offsetMin * 60000);
        const todayStr = getLocalToday(req);
        const dayOfWeek = now.getUTCDay();
        const monday = new Date(now);
        monday.setUTCDate(now.getUTCDate() - ((dayOfWeek + 6) % 7));

        const mondayStr = monday.toISOString().slice(0, 10);
        const sunday = new Date(monday);
        sunday.setUTCDate(monday.getUTCDate() + 6);
        const sundayStr = sunday.toISOString().slice(0, 10);

        const tzMod = getTzModifier(req);
        const result = await req.db!.query(
            `SELECT * FROM time_entries
             WHERE user_id = $1 AND ${pgDateInTz("timestamp", tzMod)} BETWEEN $2::date AND $3::date
             ORDER BY timestamp ASC`,
            [req.userId, mondayStr, sundayStr],
        );

        const grouped: Record<string, TimeEntry[]> = {};
        result.rows.forEach((e: TimeEntry) => {
            const date = getLocalDateFromTs(e.timestamp, req);
            if (!grouped[date]) grouped[date] = [];
            grouped[date].push(e);
        });

        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(monday);
            d.setUTCDate(monday.getUTCDate() + i);
            const dateStr = d.toISOString().slice(0, 10);
            const dayName = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

            let hours = 0;
            const dayEntries = grouped[dateStr];
            if (dayEntries && dayEntries.length > 0) {
                const capMs = dateStr >= todayStr ? Date.now() : endOfLocalDayMs(dateStr, offsetMin);
                const summary = computeDaySummary(dayEntries, true, capMs);
                hours = Math.round(summary.floorMinutes / 6) / 10;
            }
            days.push({ date: dateStr, day: dayName, hours, isToday: dateStr === todayStr });
        }

        res.json({ days });
    } catch (err) {
        req.log.error({ err }, "Weekly error");
        res.status(500).json({ error: "Failed to fetch weekly data" });
    }
});

// Today task summary
router.get("/task-summary", auth, async (req: Request, res: Response) => {
    try {
        const today = getLocalToday(req);
        const result = await req.db!.query(
            "SELECT * FROM tasks WHERE (user_id = $1 OR assigned_to = $1) AND date = $2 ORDER BY priority DESC, created_at ASC",
            [req.userId, today],
        );
        const tasks = result.rows;

        const total = tasks.length;
        const done = tasks.filter((t: { status: string }) => t.status === "done").length;
        const pending = tasks.filter((t: { status: string }) => t.status === "pending").length;
        const inProgress = tasks.filter((t: { status: string }) => t.status === "in_progress").length;
        const inReview = tasks.filter((t: { status: string }) => t.status === "in_review").length;

        const activeTasks = tasks
            .filter((t: { status: string }) => ["in_progress", "in_review", "pending"].includes(t.status))
            .map((t: { title: string; priority: string; status: string }) => ({ title: t.title, priority: t.priority, status: t.status }));

        res.json({ total, done, pending, inProgress, inReview, activeTasks });
    } catch (err) {
        req.log.error({ err }, "Task summary error");
        res.status(500).json({ error: "Failed to fetch task summary" });
    }
});

// Overtime request
router.post("/overtime-request", auth, loadUserContext, async (req: Request, res: Response) => {
    try {
        const { date, hours, reason } = req.body;
        if (!date || !hours || !reason) return res.status(400).json({ error: "Date, hours, and reason are required" });
        if (typeof reason !== "string" || reason.length > 500) return res.status(400).json({ error: "Reason must be 500 characters or less" });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format" });
        const numHours = parseFloat(hours);
        if (isNaN(numHours) || numHours <= 0 || numHours > 24) return res.status(400).json({ error: "Hours must be between 0 and 24" });

        const existingRes = await req.db!.query(
            `SELECT id FROM approval_requests
             WHERE requester_id = $1 AND type = 'overtime' AND status = 'pending'
               AND metadata::jsonb->>'date' = $2`,
            [req.userId, date],
        );
        if (existingRes.rowCount > 0) {
            return res.status(400).json({ error: "You already have a pending overtime request for this date" });
        }

        const approver = await findApprover(req.db, req.userId, req.userOrgId);
        await req.db!.query(
            `INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
             VALUES ($1,$2,$3,'overtime',NULL,$4,$5)`,
            [req.userOrgId || null, req.userId, approver?.id || null, reason,
            JSON.stringify({ date, hours: numHours })],
        );

        try {
            if (approver?.id) {
                const requesterName = (await req.db!.query("SELECT full_name FROM users WHERE id = $1", [req.userId])).rows[0]?.full_name || "A team member";
                await req.db!.query(
                    "INSERT INTO notifications (user_id, type, title, body) VALUES ($1, $2, $3, $4)",
                    [approver.id, "approval", "Overtime Request", `${requesterName} requested ${numHours}h overtime for ${date}.`],
                );
                sendToUser(req.tenantId, approver.id, "approval_update", { type: "overtime", status: "pending" });
            }
        } catch (notifErr) {
            req.log.error({ err: notifErr }, "Manager notification error (overtime)");
        }

        logAction(req, "create", "overtime_request", null, { date, hours: numHours });
        res.json({ message: "Overtime request submitted for approval" });
    } catch (err) {
        req.log.error({ err }, "Overtime request error");
        res.status(500).json({ error: "Failed to submit overtime request" });
    }
});

// Get overtime requests
router.get("/overtime-requests", auth, async (req: Request, res: Response) => {
    try {
        const result = await req.db!.query(
            `SELECT ar.id, ar.status, ar.reason, ar.metadata, ar.created_at, ar.reject_reason,
                    u.full_name as approver_name
             FROM approval_requests ar
             LEFT JOIN users u ON u.id = ar.approver_id
             WHERE ar.requester_id = $1 AND ar.type = 'overtime'
             ORDER BY ar.created_at DESC
             LIMIT 50`,
            [req.userId],
        );
        const requests = result.rows.map((r: { metadata: string; [key: string]: unknown }) => {
            let meta = {};
            try { meta = JSON.parse(r.metadata); } catch (_) { /* ignore */ }
            return { ...r, metadata: meta };
        });
        res.json(requests);
    } catch (err) {
        req.log.error({ err }, "Overtime requests error");
        res.status(500).json({ error: "Failed to fetch overtime requests" });
    }
});

// Theme
router.get("/theme", auth, async (req: Request, res: Response) => {
    try {
        const result = await req.db!.query("SELECT theme FROM users WHERE id = $1", [req.userId]);
        res.json({ theme: result.rows[0]?.theme || "dark" });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch theme" });
    }
});

router.put("/theme", auth, async (req: Request, res: Response) => {
    try {
        const { theme } = req.body;
        if (!["dark", "light"].includes(theme)) return res.status(400).json({ error: "Invalid theme" });
        await req.db!.query("UPDATE users SET theme = $1 WHERE id = $2", [theme, req.userId]);
        // Push the change to every other connected device/tab of this same
        // user so the theme updates instantly everywhere (multi-device sync).
        try {
            sendToUser(req.tenantId, req.userId, "theme_changed", { theme });
        } catch { /* ws not initialised (e.g. tests) — best-effort */ }
        res.json({ theme, message: "Theme updated" });
    } catch (err) {
        res.status(500).json({ error: "Failed to update theme" });
    }
});

export = router;
