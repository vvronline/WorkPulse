/**
 * A3.8 — upload-volume → R2 copier.
 *
 * The key derivation is the part that matters: the R2 key MUST equal the path
 * relative to the uploads root, with forward slashes. If that drifts, every
 * `avatar`, `logo_url` and `file_url` already stored in a tenant database stops
 * resolving — and it fails as a 404 per image, not as a loud error.
 */
export {};

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    walk,
    contentTypeFor,
    human,
} = require("../scripts/migrate-uploads-to-r2");

let root: string;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aino-uploads-"));
    const write = (rel: string, bytes: number) => {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.alloc(bytes, "x"));
    };
    write(path.join("tenant_1", "org_1", "avatar", "me.png"), 100);
    write(path.join("tenant_1", "org_1", "chat", "pic.jpg"), 250);
    write(path.join("tenant_2", "org_5", "logo", "brand.svg"), 50);
    // Noise that must NOT be copied.
    write(".DS_Store", 10);
    write(path.join("tenant_1", ".gitkeep"), 0);
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe("upload volume walk", () => {
    it("derives keys identical to the on-disk layout", () => {
        const keys = walk(root, root).map((f: any) => f.key).sort();
        expect(keys).toEqual([
            "tenant_1/org_1/avatar/me.png",
            "tenant_1/org_1/chat/pic.jpg",
            "tenant_2/org_5/logo/brand.svg",
        ]);
    });

    it("always emits forward slashes, even on Windows", () => {
        // path.sep is "\" on Windows; an R2 key with a backslash is a different
        // object and would silently 404 for every client.
        const keys = walk(root, root).map((f: any) => f.key);
        expect(keys.every((k: string) => !k.includes("\\"))).toBe(true);
    });

    it("skips dotfiles so .DS_Store/.gitkeep never reach the bucket", () => {
        const keys = walk(root, root).map((f: any) => f.key);
        expect(keys.some((k: string) => k.includes("DS_Store"))).toBe(false);
        expect(keys.some((k: string) => k.includes("gitkeep"))).toBe(false);
    });

    it("reports the real byte size, which is how resume decides to skip", () => {
        const files = walk(root, root);
        const avatar = files.find((f: any) => f.key.endsWith("me.png"));
        expect(avatar.size).toBe(100);
        expect(files.reduce((n: number, f: any) => n + f.size, 0)).toBe(400);
    });

    it("returns an empty list rather than throwing for a missing directory", () => {
        expect(walk(path.join(root, "nope"), root)).toEqual([]);
    });
});

describe("content types", () => {
    it("maps the formats users actually upload", () => {
        expect(contentTypeFor("a/b/x.png")).toBe("image/png");
        expect(contentTypeFor("x.JPG")).toBe("image/jpeg");
        expect(contentTypeFor("x.pdf")).toBe("application/pdf");
        expect(contentTypeFor("x.svg")).toBe("image/svg+xml");
    });

    it("falls back to octet-stream for unknown extensions", () => {
        expect(contentTypeFor("x.weird")).toBe("application/octet-stream");
        expect(contentTypeFor("noext")).toBe("application/octet-stream");
    });
});

describe("human byte formatting", () => {
    it("formats the sizes shown in the runbook", () => {
        expect(human(512)).toBe("512 B");
        expect(human(2048)).toBe("2.0 KB");
        expect(human(330 * 1024 * 1024)).toBe("330.0 MB");
        expect(human(2 * 1024 ** 3)).toBe("2.00 GB");
    });
});
