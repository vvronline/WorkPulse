// Learn more https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// lucide-react-native ships its icons as .mjs files; Metro doesn't resolve that
// extension by default, which breaks the barrel import. Add it explicitly.
config.resolver.sourceExts = Array.from(
    new Set([...config.resolver.sourceExts, "mjs", "cjs"]),
);

// COLD-START PERF: enable `inlineRequires`. Metro's default eagerly evaluates
// every top-level `import` when the JS bundle loads — so on a killed-state cold
// start the WHOLE dependency graph reachable from `index.js` (the FCM/call/
// features/api/notifee layer) is evaluated BEFORE React can mount and paint the
// first frame. `inlineRequires` rewrites those imports into lazy `require()`
// calls that run on FIRST USE instead of at bundle-eval time, so modules only
// used later (e.g. the call stack, chat sync, axios) no longer gate the first
// paint. This is the single highest-leverage cold-start win and is the same
// technique Expo/React Native recommend for production startup.
config.transformer = config.transformer || {};
const baseGetTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (
    entryPoints,
    options,
    getDependenciesOf,
) => {
    const base = baseGetTransformOptions
        ? await baseGetTransformOptions(entryPoints, options, getDependenciesOf)
        : {};
    return {
        ...base,
        transform: {
            ...(base.transform || {}),
            experimentalImportSupport: false,
            inlineRequires: true,
        },
    };
};

module.exports = config;
