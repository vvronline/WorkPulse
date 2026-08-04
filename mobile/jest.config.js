/**
 * Jest config for the mobile workspace.
 *
 * Uses the `jest-expo` preset so React Native / Expo modules resolve and the
 * Babel transform (babel-preset-expo + worklets) matches the app's real build.
 * `transformIgnorePatterns` is widened to transpile the RN/Expo/community
 * packages that ship untranspiled ESM/Flow (default node_modules is ignored).
 */
module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  // Only pick up the co-located __tests__ suites (exclude native build output).
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
  // Mirrors the `@/*` alias from tsconfig.json (and `experiments.tsconfigPaths`
  // in app.config.ts). Jest does not read tsconfig `paths`, so this mapping
  // must be kept in sync with those two by hand.
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testPathIgnorePatterns: [
    "/node_modules/",
    "/android/",
    "/ios/",
    "/.expo/",
  ],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|expo-.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@notifee/.*|@react-native-firebase/.*|react-native-mmkv|eventemitter3)/)",
  ],
};
