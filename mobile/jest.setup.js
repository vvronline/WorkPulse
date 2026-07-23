/**
 * Global Jest setup — mocks native-only modules that have no JS implementation
 * under the jest-expo (node) environment. Any test that transitively imports the
 * real app modules (e.g. src/realtime/socket → tokenStore → expo-secure-store,
 * and the MMKV-backed stores) would otherwise crash requiring a native binary.
 */

// react-native-mmkv: back it with a plain in-memory Map so persisted stores work
// in tests without the JSI/native module.
jest.mock("react-native-mmkv", () => {
  const stores = new Map();
  class MMKV {
    constructor() {
      this._m = new Map();
    }
    getString(k) {
      return this._m.has(k) ? this._m.get(k) : undefined;
    }
    set(k, v) {
      this._m.set(k, v);
    }
    remove(k) {
      this._m.delete(k);
    }
    delete(k) {
      this._m.delete(k);
    }
    clearAll() {
      this._m.clear();
    }
  }
  return {
    MMKV,
    createMMKV: (opts) => {
      const id = opts?.id || "default";
      if (!stores.has(id)) stores.set(id, new MMKV());
      return stores.get(id);
    },
  };
});

// jest-expo installs Expo's "winter" runtime, which lazily wires a `global.fetch`
// getter that, on first access, tries to require the native ExpoFetchModule and
// logs a warning AFTER the test finishes ("Cannot log after tests are done"),
// making jest exit non-zero even when every test passes. Pre-install a stable
// no-op fetch so that lazy getter never runs. Individual tests that need fetch
// can still override this mock.
if (!global.fetch || typeof global.fetch !== "function" || global.__wpFetchStub) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  }));
  global.__wpFetchStub = true;
}

// expo-secure-store: in-memory keychain stand-in.
jest.mock("expo-secure-store", () => {
  const store = new Map();
  return {
    getItemAsync: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    setItemAsync: jest.fn(async (k, v) => {
      store.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k) => {
      store.delete(k);
    }),
  };
});
