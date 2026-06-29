export {};

import fs from "node:fs";
import path from "node:path";

describe("ws call_initiate group guard", () => {
    test("keeps group conversations blocked on p2p call path", () => {
        const wsPath = path.resolve(__dirname, "../utils/ws.ts");
        const src = fs.readFileSync(wsPath, "utf8");

        expect(src).toContain('SELECT is_group FROM conversations WHERE id = $1');
        expect(src).toContain('reason: "group_unsupported"');
        expect(src).toContain("call_initiate: group conversation blocked; use meeting flow");
    });
});

