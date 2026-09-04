/*
 * The two LOCAL terminal call actions and the media-session negotiation are the
 * only HTTP the call media track performs. Their paths are a contract with
 * `server/modules/chat/chat.call-actions.routes.ts`, which mounts them under the
 * chat module (`/api/chat/...`). A missing `/chat` prefix would 404 silently —
 * the durable helper treats 404 as "already gone" — so the peer would be left
 * ringing whenever the websocket frame was the one that got dropped. Pin them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requests, instance } = vi.hoisted(() => {
  const requests: { method: string; url: string; body?: unknown; config?: unknown }[] = [];
  const instance = {
    get: vi.fn((url: string, config?: unknown) => {
      requests.push({ method: "get", url, config });
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn((url: string, body?: unknown) => {
      requests.push({ method: "post", url, body });
      return Promise.resolve({ data: {} });
    }),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    defaults: { headers: { common: {} } },
  };
  return { requests, instance };
});

vi.mock("axios", () => ({
  default: { create: () => instance, get: vi.fn(), post: vi.fn(), isAxiosError: () => false },
}));
vi.mock("nprogress", () => ({
  default: { configure: vi.fn(), start: vi.fn(), done: vi.fn() },
}));
vi.mock("nprogress/nprogress.css", () => ({}));

import { baseURL, getCallMediaSession, rejectCallHttp, endCallHttp } from "../api";

describe("call HTTP contract", () => {
  beforeEach(() => {
    requests.length = 0;
  });

  it("resolves to the chat module under the /api base", () => {
    expect(baseURL.endsWith("/api")).toBe(true);
  });

  it("negotiates media on GET /chat/calls/:callId/media-session", async () => {
    await getCallMediaSession(7, 3);
    expect(requests[0].method).toBe("get");
    expect(requests[0].url).toBe("/chat/calls/7/media-session");
    expect((requests[0].config as { params: unknown }).params).toEqual({ conversationId: 3 });
  });

  it("confirms a decline on POST /chat/calls/:callId/reject", async () => {
    await rejectCallHttp(7, 3);
    expect(requests[0]).toMatchObject({
      method: "post",
      url: "/chat/calls/7/reject",
      body: { conversationId: 3 },
    });
  });

  it("confirms a hang-up on POST /chat/calls/:callId/end", async () => {
    await endCallHttp(7, 3);
    expect(requests[0]).toMatchObject({
      method: "post",
      url: "/chat/calls/7/end",
      body: { conversationId: 3 },
    });
  });
});
