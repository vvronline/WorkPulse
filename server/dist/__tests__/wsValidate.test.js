"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Pure tests for the zero-dep schema validator.
 * The module is side-effect free, so we feed handcrafted shapes + payloads
 * and assert on the return structure.
 */
const { schema, validate } = require("../utils/wsValidate");
describe("wsValidate", () => {
    describe("validate() input safety", () => {
        test("non-object data is rejected with _root error", () => {
            const r = validate({ a: schema.str() }, null);
            expect(r.ok).toBe(false);
            expect(r.errors._root).toBe("not-an-object");
        });
        test("returns { ok: true, value } stripped of unspecified keys", () => {
            const r = validate({ a: schema.str() }, { a: "x", ignored: "y" });
            expect(r.ok).toBe(true);
            expect(r.value).toEqual({ a: "x" });
        });
        test("aggregates field-level errors", () => {
            const r = validate({ a: schema.str(), b: schema.posInt() }, { a: "", b: "no" });
            expect(r.ok).toBe(false);
            expect(r.errors.a).toBe("required");
            expect(r.errors.b).toBe("not-a-positive-int");
        });
    });
    describe("schema.str", () => {
        test("required by default", () => {
            expect(schema.str().validate(undefined).ok).toBe(false);
            expect(schema.str().validate("").ok).toBe(false);
            expect(schema.str().validate("x").ok).toBe(true);
        });
        test("honours max length", () => {
            const r = schema.str({ max: 3 }).validate("hello");
            expect(r.ok).toBe(false);
            expect(r.error).toBe("too-long");
        });
        test("honours min length", () => {
            const r = schema.str({ min: 5 }).validate("hi");
            expect(r.ok).toBe(false);
            expect(r.error).toBe("too-short");
        });
        test("honours regex pattern", () => {
            const r = schema.str({ pattern: /^[a-z]+$/ }).validate("hi123");
            expect(r.ok).toBe(false);
            expect(r.error).toBe("pattern-mismatch");
        });
        test("optional + missing → ok with undefined value (stripped)", () => {
            const r = schema.str({ optional: true }).validate(undefined);
            expect(r.ok).toBe(true);
            expect(r.value).toBeUndefined();
        });
        test("non-string types rejected", () => {
            expect(schema.str().validate(42).ok).toBe(false);
            expect(schema.str().validate({}).ok).toBe(false);
            expect(schema.str().validate([]).ok).toBe(false);
        });
    });
    describe("schema.posInt", () => {
        test("rejects non-integers, negatives, zero, NaN", () => {
            const r = schema.posInt();
            expect(r.validate(1.5).ok).toBe(false);
            expect(r.validate(-3).ok).toBe(false);
            expect(r.validate(0).ok).toBe(false);
            expect(r.validate(NaN).ok).toBe(false);
            expect(r.validate("5").ok).toBe(false);
        });
        test("accepts positive integers", () => {
            expect(schema.posInt().validate(1).ok).toBe(true);
            expect(schema.posInt().validate(99999).ok).toBe(true);
        });
        test("optional + null → ok", () => {
            expect(schema.posInt({ optional: true }).validate(null).ok).toBe(true);
        });
    });
    describe("schema.num + schema.bool + schema.enumOf", () => {
        test("num respects bounds", () => {
            expect(schema.num({ min: 0, max: 1 }).validate(0.5).ok).toBe(true);
            expect(schema.num({ min: 0, max: 1 }).validate(-0.1).ok).toBe(false);
            expect(schema.num({ min: 0, max: 1 }).validate(1.1).ok).toBe(false);
        });
        test("bool coerces truthy/falsy via !!v", () => {
            expect(schema.bool().validate(true).value).toBe(true);
            expect(schema.bool().validate(0).value).toBe(false);
            expect(schema.bool().validate("x").value).toBe(true);
        });
        test("enumOf accepts only allowed values", () => {
            const e = schema.enumOf("a", "b", "c");
            expect(e.validate("a").ok).toBe(true);
            expect(e.validate("z").ok).toBe(false);
            expect(e.validate("z").error).toMatch(/must-be-one-of:/);
        });
    });
});
//# sourceMappingURL=wsValidate.test.js.map