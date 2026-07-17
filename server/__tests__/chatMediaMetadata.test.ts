import {
  buildUploadedMediaMetadata,
  copyForwardedMediaMetadata,
} from "../utils/chatMediaMetadata";

describe("chat media metadata", () => {
  describe("buildUploadedMediaMetadata", () => {
    test("persists rounded positive width and height as a pair", () => {
      expect(
        buildUploadedMediaMetadata({
          width: "1080.4",
          height: "1920.6",
        }),
      ).toEqual({ width: 1080, height: 1921 });
    });

    test("merges dimensions with view-once metadata", () => {
      expect(
        buildUploadedMediaMetadata({
          viewOnce: "true",
          width: "720",
          height: "1280",
        }),
      ).toEqual({
        viewOnce: true,
        viewedBy: [],
        width: 720,
        height: 1280,
      });
    });

    test.each([
      [{ width: "720" }],
      [{ height: "1280" }],
      [{ width: "0", height: "1280" }],
      [{ width: "-1", height: "1280" }],
      [{ width: "NaN", height: "1280" }],
      [{ width: "100001", height: "1280" }],
      [{ width: "720", height: "100001" }],
    ])("rejects incomplete or unsafe dimensions: %p", (input) => {
      expect(buildUploadedMediaMetadata(input)).toBeNull();
    });

    test("keeps view-once metadata when dimensions are invalid", () => {
      expect(
        buildUploadedMediaMetadata({
          viewOnce: "true",
          width: "invalid",
          height: "1280",
        }),
      ).toEqual({ viewOnce: true, viewedBy: [] });
    });
  });

  describe("copyForwardedMediaMetadata", () => {
    test("preserves dimensions and returns a detached object", () => {
      const original = {
        width: 1080,
        height: 1920,
        custom: "retained",
      };
      const forwarded = copyForwardedMediaMetadata(original);

      expect(forwarded).toEqual(original);
      expect(forwarded).not.toBe(original);
    });

    test.each([null, undefined, "invalid", [], 42])(
      "rejects non-object metadata: %p",
      (metadata) => {
        expect(copyForwardedMediaMetadata(metadata)).toBeNull();
      },
    );
  });
});