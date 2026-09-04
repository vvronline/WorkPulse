import { api } from "../../api";

export type P2PMediaSession = {
  backend: "p2p";
  callId: number;
  conversationId: number;
};

export type LiveKitMediaSession = {
  backend: "livekit";
  callId: number;
  conversationId: number;
  livekit: {
    serverUrl: string;
    token: string;
    roomName: string;
  };
};

export type CallMediaSession = P2PMediaSession | LiveKitMediaSession;

function parseMediaSession(
  value: unknown,
  callId: number,
  conversationId: number,
): CallMediaSession {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid media-session response");
  }
  const raw = value as Record<string, unknown>;
  if (
    Number(raw.callId) !== callId ||
    Number(raw.conversationId) !== conversationId
  ) {
    throw new Error("Media-session response does not match this call");
  }
  if (raw.backend === "p2p") {
    return { backend: "p2p", callId, conversationId };
  }
  const livekit = raw.livekit as Record<string, unknown> | undefined;
  if (
    raw.backend !== "livekit" ||
    !livekit ||
    typeof livekit.serverUrl !== "string" ||
    typeof livekit.token !== "string" ||
    typeof livekit.roomName !== "string" ||
    !livekit.serverUrl ||
    !livekit.token ||
    !livekit.roomName
  ) {
    throw new Error("Invalid LiveKit media-session response");
  }
  return {
    backend: "livekit",
    callId,
    conversationId,
    livekit: {
      serverUrl: livekit.serverUrl,
      token: livekit.token,
      roomName: livekit.roomName,
    },
  };
}

export async function getCallMediaSession(
  callId: number,
  conversationId: number,
): Promise<CallMediaSession> {
  const response = await api.get<unknown>(`/chat/calls/${callId}/media-session`, {
    params: { conversationId },
  });
  return parseMediaSession(response.data, callId, conversationId);
}

/**
 * A call chooses its media backend once. A rejected prewarm may be retried,
 * while a fulfilled choice is immutable for the call lifetime.
 */
export class MediaSessionSelection {
  private selected?: CallMediaSession;

  private inFlight?: Promise<CallMediaSession>;

  resolve(load: () => Promise<CallMediaSession>): Promise<CallMediaSession> {
    if (this.selected) return Promise.resolve(this.selected);
    if (this.inFlight) return this.inFlight;

    this.inFlight = load().then(
      (session) => {
        this.selected = session;
        this.inFlight = undefined;
        return session;
      },
      (error: unknown) => {
        this.inFlight = undefined;
        throw error;
      },
    );
    return this.inFlight;
  }

  peek(): CallMediaSession | undefined {
    return this.selected;
  }
}

export class MediaSessionSelectionCancelledError extends Error {
  constructor() {
    super("Media session selection completed after the call ended");
    this.name = "MediaSessionSelectionCancelledError";
  }
}

export function isMediaSessionSelectionCancelled(
  error: unknown,
): error is MediaSessionSelectionCancelledError {
  return error instanceof MediaSessionSelectionCancelledError;
}
