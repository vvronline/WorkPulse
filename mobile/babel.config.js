module.exports = function (api) {
    api.cache(true);
    return {
        presets: ["babel-preset-expo"],
        // react-native-worklets/plugin powers react-native-reanimated v4 worklets
        // (drag-and-drop on the Kanban board). It MUST be the last plugin.
        plugins: ["react-native-worklets/plugin"],
    };
};