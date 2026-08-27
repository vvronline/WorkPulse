import { forEachBounded } from "../platform/boundedParallel";

describe("forEachBounded", () => {
    it("never exceeds the configured concurrency", async () => {
        const items = Array.from({ length: 12 }, (_, i) => i);
        let active = 0;
        let peak = 0;
        const seen: number[] = [];

        await forEachBounded(items, 5, async (item) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            seen.push(item);
            active--;
        });

        expect(peak).toBe(5);
        expect(seen.sort((a, b) => a - b)).toEqual(items);
    });

    it("handles an empty list", async () => {
        const fn = jest.fn();
        await forEachBounded([], 5, fn);
        expect(fn).not.toHaveBeenCalled();
    });
});