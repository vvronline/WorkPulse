import { createHmac } from "crypto";
import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";
import { logger } from "../utils/logger";

export type CallMediaBackend = "p2p" | "livekit";

interface EnvLike {
  CALL_MEDIA_BACKEND?: string;
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
}

interface LiveKitConfig {
  serverUrl: string;
  apiKey: string;
  apiSecret: string;
}

interface QueryDb {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface CallMediaSession {
  backend: CallMediaBackend;
  callId: number;
  conversationId: number;
  livekit?: {
    serverUrl: string;
    token: string;
    roomName: string;
  };
}

export type CallMediaSessionResult =
  | { kind: "ok"; session: CallMediaSession }
  | { kind: "not_found" }
  | {
      kind: "not_joinable";
      status: string;
      phase: "initial" | "after_create";
    }
  | { kind: "gone"; phase: "after_create" };

export function getCallMediaBackend(
  env: EnvLike = process.env,
): CallMediaBackend {
  const value = (env.CALL_MEDIA_BACKEND || "p2p").trim().toLowerCase();
  if (value !== "p2p" && value !== "livekit") {
    throw new Error("CALL_MEDIA_BACKEND must be either p2p or livekit");
  }
  return value;
}

export function getLiveKitConfig(
  env: EnvLike = process.env,
): LiveKitConfig {
  const required = [
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
  ] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(
      `CALL_MEDIA_BACKEND=livekit requires ${missing.join(", ")}`,
    );
  }

  const serverUrl = env.LIVEKIT_URL!.trim();
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error("LIVEKIT_URL must be a public wss:// URL");
  }
  if (parsed.protocol !== "wss:") {
    throw new Error("LIVEKIT_URL must be a public wss:// URL");
  }

  const apiKey = env.LIVEKIT_API_KEY!.trim();
  const apiSecret = env.LIVEKIT_API_SECRET!.trim();
  if (apiSecret.length < 32) {
    throw new Error(
      "LIVEKIT_API_SECRET must be at least 32 characters when CALL_MEDIA_BACKEND=livekit",
    );
  }

  return {
    serverUrl,
    apiKey,
    apiSecret,
  };
}

export function validateCallMediaEnvironment(
  env: EnvLike = process.env,
): CallMediaBackend {
  const backend = getCallMediaBackend(env);
  if (backend === "livekit") getLiveKitConfig(env);
  return backend;
}

export function liveKitApiUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return parsed.toString().replace(/\/$/, "");
}

export function liveKitRoomName(
  tenantId: number | string | null | undefined,
  callId: number,
  apiSecret: string,
): string {
  const digest = createHmac("sha256", apiSecret)
    .update(`tenant:${tenantId ?? "default"}:call:${callId}`)
    .digest("base64url")
    .slice(0, 32);
  return `call_${digest}`;
}

function liveKitParticipantIdentity(
  tenantId: number | string | null | undefined,
  callId: number,
  userId: number,
  apiSecret: string,
): string {
  // Call acceptance is first-write-wins in the DB. Every device belonging to
  // that winning user intentionally shares one opaque room identity, so a
  // reconnect/second device replaces the old participant instead of consuming
  // both slots in this two-person room.
  return `participant_${createHmac("sha256", apiSecret)
    .update(`tenant:${tenantId ?? "default"}:call:${callId}:user:${userId}`)
    .digest("base64url")
    .slice(0, 32)}`;
}

function storedBackend(value: unknown): CallMediaBackend {
  if (value == null || value === "p2p") return "p2p";
  if (value === "livekit") return "livekit";
  throw new Error(`Unsupported persisted call media backend: ${String(value)}`);
}

export async function getCallMediaSession(
  db: QueryDb,
  input: {
    callId: number;
    conversationId: number;
    userId: number;
    tenantId: number | string | null | undefined;
  },
  roomService?: Pick<RoomServiceClient, "createRoom" | "deleteRoom">,
): Promise<CallMediaSessionResult> {
  const call = (
    await db.query(
      `SELECT cl.id, cl.conversation_id, cl.call_type, cl.status, cl.media_backend
         FROM call_logs cl
         JOIN conversation_participants cp
           ON cp.conversation_id = cl.conversation_id AND cp.user_id = $3
        WHERE cl.id = $1 AND cl.conversation_id = $2`,
      [input.callId, input.conversationId, input.userId],
    )
  ).rows[0];

  if (!call) return { kind: "not_found" };
  if (!["ringing", "answered"].includes(call.status)) {
    return { kind: "not_joinable", status: call.status, phase: "initial" };
  }

  const backend = storedBackend(call.media_backend);
  const session: CallMediaSession = {
    backend,
    callId: input.callId,
    conversationId: input.conversationId,
  };
  if (backend === "p2p") return { kind: "ok", session };

  const config = getLiveKitConfig();
  const roomName = liveKitRoomName(
    input.tenantId,
    input.callId,
    config.apiSecret,
  );
  const client =
    roomService ||
    new RoomServiceClient(
      liveKitApiUrl(config.serverUrl),
      config.apiKey,
      config.apiSecret,
    );
  await client.createRoom({ name: roomName, maxParticipants: 2 });

  // Creating a room is a network operation. Re-read the tenant DB afterwards
  // so an end/reject racing with CreateRoom cannot receive a usable join token.
  const current = (
    await db.query(
      `SELECT id, conversation_id, call_type, status, media_backend
         FROM call_logs
        WHERE id = $1 AND conversation_id = $2`,
      [input.callId, input.conversationId],
    )
  ).rows[0];
  if (!current) {
    await cleanupCallMediaRoom(
      {
        callId: input.callId,
        tenantId: input.tenantId,
        mediaBackend: "livekit",
      },
      client,
    );
    return { kind: "gone", phase: "after_create" };
  }
  if (
    current.media_backend !== "livekit" ||
    !["ringing", "answered"].includes(current.status)
  ) {
    await cleanupCallMediaRoom(
      {
        callId: input.callId,
        tenantId: input.tenantId,
        mediaBackend: "livekit",
      },
      client,
    );
    return {
      kind: "not_joinable",
      status: current.status,
      phase: "after_create",
    };
  }

  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: liveKitParticipantIdentity(
      input.tenantId,
      input.callId,
      input.userId,
      config.apiSecret,
    ),
    ttl: 5 * 60,
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublishSources:
      current.call_type === "video"
        ? [
            TrackSource.MICROPHONE,
            TrackSource.CAMERA,
            TrackSource.SCREEN_SHARE,
            TrackSource.SCREEN_SHARE_AUDIO,
          ]
        : [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: false,
  });
  session.livekit = {
    serverUrl: config.serverUrl,
    token: await token.toJwt(),
    roomName,
  };
  return { kind: "ok", session };
}

export async function cleanupCallMediaRoom(
  input: {
    callId: number;
    tenantId: number | string | null | undefined;
    mediaBackend: unknown;
  },
  roomService?: Pick<RoomServiceClient, "deleteRoom">,
): Promise<{ attempted: boolean; ok: boolean }> {
  if (storedBackend(input.mediaBackend) !== "livekit") {
    return { attempted: false, ok: true };
  }

  try {
    const config = getLiveKitConfig();
    const roomName = liveKitRoomName(
      input.tenantId,
      input.callId,
      config.apiSecret,
    );
    const client =
      roomService ||
      new RoomServiceClient(
        liveKitApiUrl(config.serverUrl),
        config.apiKey,
        config.apiSecret,
      );
    await client.deleteRoom(roomName);
    logger.info(
      { callId: input.callId, tenantId: input.tenantId, roomName },
      "LiveKit call room deleted",
    );
    return { attempted: true, ok: true };
  } catch (err) {
    const roomAlreadyGone =
      typeof err === "object" &&
      err !== null &&
      (("status" in err && err.status === 404) ||
        ("code" in err && err.code === "not_found"));
    if (roomAlreadyGone) {
      logger.info(
        { callId: input.callId, tenantId: input.tenantId },
        "LiveKit call room already absent",
      );
      return { attempted: true, ok: true };
    }
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        callId: input.callId,
        tenantId: input.tenantId,
      },
      "LiveKit call room cleanup failed",
    );
    return { attempted: true, ok: false };
  }
}
