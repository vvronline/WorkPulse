const {
  normalizeMediaDimension,
  updateMediaDimensionIndex,
} = require("../../mobile/src/storage/mediaDimensionsPolicy");

describe("mobile media-dimension cache policy", () => {
  test.each([
    [1080.4, 1080],
    ["1920.6", 1921],
    [1, 1],
  ])("normalizes valid dimensions %p", (input, expected) => {
    expect(normalizeMediaDimension(input)).toBe(expected);
  });

  test.each([0, -1, "invalid", Number.NaN, Number.POSITIVE_INFINITY, null])(
    "rejects invalid dimensions %p",
    (input) => {
      expect(normalizeMediaDimension(input)).toBeNull();
    },
  );

  test("touching an existing key moves it to most-recent position", () => {
    expect(updateMediaDimensionIndex(["a", "b", "c"], "b", 3)).toEqual({
      entries: ["a", "c", "b"],
      evicted: [],
    });
  });

  test("evicts the oldest entries when the persistent cap is exceeded", () => {
    expect(updateMediaDimensionIndex(["a", "b", "c"], "d", 3)).toEqual({
      entries: ["b", "c", "d"],
      evicted: ["a"],
    });
  });

  test("deduplicates a touched key and handles a zero-sized cache", () => {
    expect(updateMediaDimensionIndex(["a", "a"], "a", 0)).toEqual({
      entries: [],
      evicted: ["a"],
    });
  });
});