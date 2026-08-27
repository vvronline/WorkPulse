/** Phase F: collaboration authenticates via HttpOnly cookie and validates Origin. */
export {};

const {
    resolveCollaborationToken,
    isCollaborationOriginAllowed,
} = require("../realtime/collaborationAuth");

describe("collaboration authentication helpers", () => {
    const old = process.env;
    beforeEach(() => { process.env = { ...old, NODE_ENV: "production", CORS_ORIGIN: "" }; });
    afterAll(() => { process.env = old; });

    it("reads the browser JWT from the HttpOnly upgrade cookie", () => {
        expect(resolveCollaborationToken("", "theme=dark; token=jwt-value; x=1")).toBe("jwt-value");
    });

    it("prefers an explicit native/provider token", () => {
        expect(resolveCollaborationToken("native-token", "token=cookie-token")).toBe("native-token");
    });

    it("allows same-origin and explicitly configured origins", () => {
        expect(isCollaborationOriginAllowed("https://aino.org.in", "aino.org.in")).toBe(true);
        process.env.CORS_ORIGIN = "https://www.aino.org.in";
        expect(isCollaborationOriginAllowed("https://www.aino.org.in", "other.example")).toBe(true);
    });

    it("rejects arbitrary cross-site browser origins", () => {
        expect(isCollaborationOriginAllowed("https://evil.example", "aino.org.in")).toBe(false);
    });
});