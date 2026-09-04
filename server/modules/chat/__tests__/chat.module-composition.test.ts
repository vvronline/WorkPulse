import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const expectedRoutes = [
    "POST /messages/:id/reactions",
    "POST /messages/:id/pin",
    "GET /conversations/:id/pinned",
    "POST /messages/:id/star",
    "GET /starred",
    "GET /blocked",
    "POST /users/:userId/block",
    "DELETE /users/:userId/block",
    "POST /conversations",
    "POST /conversations/group",
    "GET /conversations/:id/members",
    "POST /conversations/:id/pin",
    "POST /conversations/:id/favourite",
    "POST /conversations/:id/mute",
    "POST /conversations/:id/archive",
    "GET /ice-config",
    "GET /search",
    "GET /presence",
    "PUT /conversations/:id/group",
    "POST /conversations/:id/leave",
    "PUT /conversations/:id/participants/:userId/role",
    "POST /conversations/:id/transfer-owner",
    "GET /conversations",
    "GET /conversations/:id/messages",
    "POST /conversations/:id/read",
    "GET /conversations/:id/read-status",
    "POST /conversations/:id/messages",
    "POST /conversations/:id/files",
    "POST /media-jobs/:id/cancel",
    "POST /media-jobs/:id/retry",
    "PUT /messages/:id",
    "DELETE /messages/:id",
    "GET /search-messages",
    "POST /messages/:id/forward",
    "POST /conversations/:id/polls",
    "POST /polls/:id/vote",
    "GET /polls/:id",
    "GET /conversations/:id/files",
    "POST /conversations/:id/unread",
    "DELETE /conversations/:id/messages",
    "DELETE /conversations/:id",
    "POST /messages/:id/delivered",
    "POST /messages/:id/view",
    "GET /calls",
    "POST /calls/delete",
    "GET /calls/active",
    "GET /conversations/:id/calls",
    "GET /calls/:callId/media-session",
    "POST /calls/:callId/reject",
    "POST /calls/:callId/accept",
    "POST /calls/:callId/end",
    "GET /link-preview",
];

function registeredRoutes(file: string): string[] {
    const source = fs.readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const routes: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.expression.getText(ast) === "router" &&
            ["get", "post", "put", "patch", "delete"].includes(node.expression.name.text) &&
            node.arguments[0] &&
            ts.isStringLiteralLike(node.arguments[0])
        ) {
            routes.push(`${node.expression.name.text.toUpperCase()} ${node.arguments[0].text}`);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    return routes;
}

describe("chat module route composition", () => {
    const serverRoot = path.resolve(__dirname, "../../..");
    const moduleRoot = path.join(serverRoot, "modules/chat");
    const moduleRouteFiles = [
        "chat.core.routes.ts",
        "chat.group.routes.ts",
        "chat.conversation-reads.routes.ts",
        "chat.message-send.routes.ts",
        "chat.media-jobs.routes.ts",
        "chat.message-actions.routes.ts",
        "chat.polls.routes.ts",
        "chat.conversation-actions.routes.ts",
        "chat.call-history.routes.ts",
        "chat.call-actions.routes.ts",
        "chat.link-preview.routes.ts",
    ];

    test("keeps every public chat endpoint in the module router", () => {
        expect(moduleRouteFiles.flatMap((file) => registeredRoutes(path.join(moduleRoot, file)))).toEqual(
            expectedRoutes,
        );
    });

    test("leaves the legacy chat router as middleware composition only", () => {
        expect(registeredRoutes(path.join(serverRoot, "routes/chat.ts"))).toEqual([]);
    });
});
