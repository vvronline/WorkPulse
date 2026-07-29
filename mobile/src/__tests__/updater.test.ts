const mockDownloadAsync = jest.fn();
const mockStartActivityAsync = jest.fn();
let progressCallback: ((value: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void) | undefined;

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { version: "2.0.74", extra: { APP_VERSION: "2.0.74" } } },
}));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  deleteAsync: jest.fn(),
  getContentUriAsync: jest.fn(async () => "content://aino.apk"),
  createDownloadResumable: jest.fn((_url, _path, _options, progress) => {
    progressCallback = progress;
    return { downloadAsync: mockDownloadAsync };
  }),
}));
jest.mock("expo-intent-launcher", () => ({
  startActivityAsync: (...args: unknown[]) => mockStartActivityAsync(...args),
}));

import { Platform } from "react-native";
import { compareSemver, downloadAndInstallApk, evaluateManifest, getCurrentVersion } from "../updater";

describe("R2 mobile updater", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    progressCallback = undefined;
    Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
    mockDownloadAsync.mockResolvedValue({ uri: "file:///cache/AINO-2.0.75.apk" });
    mockStartActivityAsync.mockResolvedValue(undefined);
  });

  it("uses the packaged app version", () => expect(getCurrentVersion()).toBe("2.0.74"));

  it("compares numeric semver without lexicographic errors", () => {
    expect(compareSemver("2.0.100", "2.0.74")).toBe(1);
    expect(compareSemver("v2.0.74", "2.0.74")).toBe(0);
    expect(compareSemver("2.0.73", "2.0.74")).toBe(-1);
  });

  it("returns an installable update from an R2 manifest", () => {
    expect(evaluateManifest({ version: "2.0.75", apkUrl: "https://cdn.aino.org.in/a.apk", notes: "## Fixes\n- Calls" }, "2.0.74"))
      .toMatchObject({ available: true, version: "2.0.75", notes: "Fixes\n- Calls" });
  });

  it("reports equal and older manifests as up to date", () => {
    expect(evaluateManifest({ version: "2.0.74" }, "2.0.74").reason).toBe("up-to-date");
    expect(evaluateManifest({ version: "2.0.73" }, "2.0.74").reason).toBe("up-to-date");
  });

  it("rejects malformed and APK-less newer manifests safely", () => {
    expect(evaluateManifest({ version: "latest" }, "2.0.74")).toMatchObject({ available: false, reason: "no-release" });
    expect(evaluateManifest({ version: "2.0.75" }, "2.0.74")).toMatchObject({ available: false, reason: "no-release" });
  });

  it("downloads with progress and opens Android's package installer", async () => {
    const onProgress = jest.fn();
    await downloadAndInstallApk("https://cdn.aino.org.in/a.apk", "2.0.75", onProgress);
    progressCallback?.({ totalBytesWritten: 50, totalBytesExpectedToWrite: 100 });
    expect(onProgress).toHaveBeenCalledWith(0.5);
    expect(mockStartActivityAsync).toHaveBeenCalledWith("android.intent.action.INSTALL_PACKAGE", expect.objectContaining({ data: "content://aino.apk", type: "application/vnd.android.package-archive", flags: 1 }));
  });

  it("never attempts APK installation outside Android", async () => {
    Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
    await expect(downloadAndInstallApk("https://example.test/a.apk", "2.0.75")).rejects.toThrow("only supported on Android");
    expect(mockDownloadAsync).not.toHaveBeenCalled();
  });

  it("explains installer permission failures", async () => {
    mockStartActivityAsync.mockRejectedValueOnce(new Error("denied"));
    await expect(downloadAndInstallApk("https://example.test/a.apk", "2.0.75")).rejects.toThrow("Install unknown apps");
  });
});