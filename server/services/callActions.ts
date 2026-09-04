import { getCallMediaBackend } from "./callMedia";

interface QueryDb {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export type CallAction = "accept" | "reject" | "end";

export interface CallLogRow {
  id: number;
  conversation_id: number;
  caller_id: number;
  call_type: string;
  status: string;
  started_at?: string | Date | null;
  media_backend?: string | null;
  [key: string]: unknown;
}

export type CallActionResult =
  | {
      outcome: "applied";
      call: CallLogRow;
      status: string;
      duration: number | null;
    }
  | {
      outcome: "unchanged";
      call: CallLogRow;
      status: string;
      duration: number | null;
    }
  | { outcome: "forbidden" }
  | { outcome: "not_found" };

export async function createRingingCall(
  db: QueryDb,
  input: {
    conversationId: number;
    callerId: number;
    callType: "voice" | "video";
  },
): Promise<CallLogRow> {
  const backend = getCallMediaBackend();
  return (
    await db.query(
      `INSERT INTO call_logs
         (conversation_id, caller_id, call_type, status, media_backend)
       VALUES ($1, $2, $3, 'ringing', $4)
       RETURNING id, created_at, media_backend`,
      [input.conversationId, input.callerId, input.callType, backend],
    )
  ).rows[0];
}

export async function applyCallAction(
  db: QueryDb,
  input: {
    callId: number;
    conversationId: number;
    userId: number;
    action: CallAction;
  },
): Promise<CallActionResult> {
  const [participantResult, callResult] = await Promise.all([
    db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [input.conversationId, input.userId],
    ),
    db.query(
      "SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2",
      [input.callId, input.conversationId],
    ),
  ]);
  if (!participantResult.rows[0]) return { outcome: "forbidden" };

  const call = callResult.rows[0] as CallLogRow | undefined;
  if (!call) return { outcome: "not_found" };

  let duration: number | null = null;
  if (input.action === "end" && call.started_at) {
    duration = Math.max(
      0,
      Math.round(
        (Date.now() - new Date(call.started_at).getTime()) / 1000,
      ),
    );
  }

  const canApply =
    input.action === "end"
      ? !["ended", "missed", "declined"].includes(call.status)
      : call.status === "ringing";
  if (!canApply) {
    return { outcome: "unchanged", call, status: call.status, duration };
  }

  const update =
    input.action === "accept"
      ? {
          sql: `UPDATE call_logs
                   SET status = 'answered', started_at = NOW()
                 WHERE id = $1 AND conversation_id = $2 AND status = 'ringing'
                 RETURNING status`,
          params: [input.callId, input.conversationId],
        }
      : input.action === "reject"
        ? {
            sql: `UPDATE call_logs
                     SET status = 'declined', ended_at = NOW()
                   WHERE id = $1 AND conversation_id = $2 AND status = 'ringing'
                   RETURNING status`,
            params: [input.callId, input.conversationId],
          }
        : {
            sql: `UPDATE call_logs
                     SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END,
                         ended_at = NOW(),
                         duration = $3
                   WHERE id = $1 AND conversation_id = $2
                     AND status NOT IN ('ended', 'missed', 'declined')
                   RETURNING status`,
            params: [input.callId, input.conversationId, duration],
          };

  const updated = (await db.query(update.sql, update.params)).rows[0];
  if (updated) {
    return {
      outcome: "applied",
      call,
      status: updated.status,
      duration,
    };
  }

  const current = (
    await db.query(
      "SELECT * FROM call_logs WHERE id = $1 AND conversation_id = $2",
      [input.callId, input.conversationId],
    )
  ).rows[0] as CallLogRow | undefined;
  if (!current) return { outcome: "not_found" };
  return {
    outcome: "unchanged",
    call: current,
    status: current.status,
    duration,
  };
}
