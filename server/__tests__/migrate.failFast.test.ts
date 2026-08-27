import { assertNoMigrationFailures } from "../migrate";

describe("migration deployment gate", () => {
    it("allows zero failures", () => {
        expect(() => assertNoMigrationFailures("Tenant migrations", 0)).not.toThrow();
        expect(() => assertNoMigrationFailures("Master migrations", [])).not.toThrow();
    });

    it("throws for counted failures", () => {
        expect(() => assertNoMigrationFailures("Base schema", 2))
            .toThrow("Base schema failed: 2 failure(s)");
    });

    it("includes failed migration names", () => {
        expect(() => assertNoMigrationFailures("Master migrations", ["m1", "m2"]))
            .toThrow("Master migrations failed: m1, m2");
    });
});