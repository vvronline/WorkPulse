jest.mock("../middleware/auth", () =>
    (req: any, _res: any, next: any) => {
        req.userId = 7;
        next();
    });

const mockGetSignedUrl = jest.fn();
const mockGet = jest.fn();
const mockStat = jest.fn();

jest.mock("../platform/storage", () => ({
    getStorage: () => ({
        getSignedUrl: mockGetSignedUrl,
        get: mockGet,
        stat: mockStat,
    }),
    urlToKey: (value: string) => value.replace(/^\/+/, ""),
}));

const express = require("express");
const request = require("supertest");
const { installUploadServing } = require("../http/middleware/uploads");

function makeApp() {
    const app = express();
    app.use((req: any, _res: any, next: any) => {
        req.tenantId = 1;
        req.db = {
            query: jest.fn().mockResolvedValue({ rows: [{ org_id: 2 }] }),
        };
        next();
    });
    installUploadServing(app, process.cwd());
    return app;
}

describe("desktop upload delivery", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSignedUrl.mockResolvedValue("https://account.r2.cloudflarestorage.com/signed");
        mockGet.mockResolvedValue(Buffer.from("image"));
        mockStat.mockResolvedValue({ contentType: "image/png" });
    });

    it("streams R2 objects for the desktop custom protocol", async () => {
        const res = await request(makeApp())
            .get("/uploads/tenant_1/org_2/avatars/avatar.png")
            .set("Origin", "workpulse://app");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/^image\/png/);
        expect(mockGetSignedUrl).not.toHaveBeenCalled();
        expect(mockGet).toHaveBeenCalledWith("tenant_1/org_2/avatars/avatar.png");
    });

    it("keeps presigned R2 redirects for web and mobile clients", async () => {
        const res = await request(makeApp())
            .get("/uploads/tenant_1/org_2/avatars/avatar.png")
            .set("Origin", "https://www.aino.org.in");

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe("https://account.r2.cloudflarestorage.com/signed");
        expect(mockGetSignedUrl).toHaveBeenCalledWith(
            "tenant_1/org_2/avatars/avatar.png",
            60,
        );
        expect(mockGet).not.toHaveBeenCalled();
    });
});
