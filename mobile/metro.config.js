// Learn more https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// lucide-react-native ships its icons as .mjs files; Metro doesn't resolve that
// extension by default, which breaks the barrel import. Add it explicitly.
config.resolver.sourceExts = Array.from(
    new Set([...config.resolver.sourceExts, "mjs", "cjs"]),
);

module.exports = config;
