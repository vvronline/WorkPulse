import { AxiosError, AxiosHeaders } from "axios";
import {
  getErrorMessage,
  isOffline,
  shouldRetryRequest,
  toApiError,
} from "../apiError";

/** Build an AxiosError carrying a server response. */
function httpError(status: number, data: unknown): AxiosError {
  const err = new AxiosError(
    `Request failed with status code ${status}`,
    String(status),
    { headers: new AxiosHeaders() } as never,
    {},
    {
      status,
      statusText: "",
      data,
      headers: {},
      config: { headers: new AxiosHeaders() } as never,
    },
  );
  return err;
}

/** Build an AxiosError with NO response (offline / timeout). */
function transportError(code: string, message: string): AxiosError {
  return new AxiosError(message, code, {
    headers: new AxiosHeaders(),
  } as never);
}

describe("toApiError", () => {
  describe("payload shape handling", () => {
    it("reads the standard { error } envelope", () => {
      expect(toApiError(httpError(400, { error: "Name is required" })).message)
        .toBe("Name is required");
    });

    it("reads the { message } shape used by newer routes", () => {
      expect(toApiError(httpError(409, { message: "Already exists" })).message)
        .toBe("Already exists");
    });

    it("reads a plain-text body", () => {
      expect(toApiError(httpError(500, "Upstream exploded")).message).toBe(
        "Upstream exploded",
      );
    });

    it("never surfaces an HTML error page to the user", () => {
      // Proxies/load balancers return HTML on 502 — showing that raw would
      // dump markup into a toast.
      const result = toApiError(httpError(502, "<!DOCTYPE html><html>..."));
      expect(result.message).not.toContain("<");
      expect(result.kind).toBe("server");
    });

    it("falls back to friendly copy when the body has no message", () => {
      const result = toApiError(httpError(403, {}));
      expect(result.message).toBe("You don't have permission to do that.");
    });

    it("extracts field errors from a validation response", () => {
      const result = toApiError(
        httpError(422, {
          error: "Validation failed",
          errors: { email: ["is taken"], name: "is required" },
        }),
      );
      expect(result.kind).toBe("validation");
      expect(result.fieldErrors).toEqual({
        email: ["is taken"],
        name: ["is required"],
      });
    });
  });

  describe("status → kind mapping", () => {
    it.each([
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "notFound"],
      [409, "conflict"],
      [422, "validation"],
      [429, "rateLimited"],
      [500, "server"],
      [503, "server"],
      [418, "client"],
    ])("maps %i to %s", (status, kind) => {
      expect(toApiError(httpError(status, {})).kind).toBe(kind);
    });
  });

  describe("transport failures", () => {
    it("classifies a connection failure as network", () => {
      const result = toApiError(
        transportError("ERR_NETWORK", "Network Error"),
      );
      expect(result.kind).toBe("network");
      expect(result.retryable).toBe(true);
      expect(result.status).toBeUndefined();
    });

    it("classifies an aborted request as timeout", () => {
      const result = toApiError(
        transportError("ECONNABORTED", "timeout of 60000ms exceeded"),
      );
      expect(result.kind).toBe("timeout");
      expect(result.retryable).toBe(true);
    });
  });

  describe("non-axios values", () => {
    it("uses the message of a plain Error", () => {
      expect(toApiError(new Error("boom")).message).toBe("boom");
    });

    it("handles a thrown string / null / undefined without crashing", () => {
      for (const value of ["oops", null, undefined, 42]) {
        const result = toApiError(value);
        expect(typeof result.message).toBe("string");
        expect(result.message.length).toBeGreaterThan(0);
      }
    });
  });

  it("always returns a non-empty message", () => {
    // The whole point: no call site can ever render "undefined".
    const inputs = [
      httpError(400, {}),
      httpError(500, ""),
      httpError(404, { error: "   " }),
      transportError("ERR_NETWORK", ""),
      new Error(""),
      {},
      null,
    ];
    for (const input of inputs) {
      expect(getErrorMessage(input).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("shouldRetryRequest", () => {
  it("does NOT retry client errors that can never succeed", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(shouldRetryRequest(0, httpError(status, {}))).toBe(false);
    }
  });

  it("retries transient server and connectivity failures", () => {
    expect(shouldRetryRequest(0, httpError(500, {}))).toBe(true);
    expect(shouldRetryRequest(0, httpError(429, {}))).toBe(true);
    expect(shouldRetryRequest(0, transportError("ERR_NETWORK", "x"))).toBe(true);
  });

  it("gives up after 3 attempts", () => {
    expect(shouldRetryRequest(2, httpError(500, {}))).toBe(true);
    expect(shouldRetryRequest(3, httpError(500, {}))).toBe(false);
  });
});

describe("isOffline", () => {
  it("is true only for connectivity failures", () => {
    expect(isOffline(transportError("ERR_NETWORK", "Network Error"))).toBe(true);
    expect(isOffline(httpError(500, {}))).toBe(false);
    expect(isOffline(new Error("boom"))).toBe(false);
  });
});
