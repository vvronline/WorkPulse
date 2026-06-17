const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const META_NAME = "com.google.firebase.messaging.default_notification_channel_id";
const DEFAULT_CHANNEL = "default";

// The expo-notifications config plugin (when given `color`) and
// @react-native-firebase/messaging BOTH declare this meta-data, which causes a
// manifest-merger conflict:
//   default_notification_color: @color/notification_icon_color (expo)
//   default_notification_color: @color/white                   (rn-firebase)
// We resolve it by forcing `tools:replace` on the color (and icon) meta-data so
// the app's value wins instead of failing the build.
const COLOR_META_NAME = "com.google.firebase.messaging.default_notification_color";
const ICON_META_NAME = "com.google.firebase.messaging.default_notification_icon";

function upsertReplaceableMeta(metaData, name, replaceAttr) {
  const existing = metaData.find((entry) => entry?.$?.["android:name"] === name);
  if (!existing) {
    // Nothing to do — if the meta-data isn't present, there's no conflict to
    // resolve. (expo-notifications only injects it when `color`/`icon` is set.)
    return;
  }
  existing.$ = {
    ...existing.$,
    "tools:replace": existing.$["tools:replace"]
      ? `${existing.$["tools:replace"]},${replaceAttr}`
      : replaceAttr,
  };
}

module.exports = function withFirebaseNotificationChannelOverride(config) {
  return withAndroidManifest(config, (config) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(
      config.modResults,
    );

    const metaData = mainApplication["meta-data"] || [];
    let channelMeta = metaData.find(
      (entry) => entry?.$?.["android:name"] === META_NAME,
    );

    if (!channelMeta) {
      channelMeta = {
        $: {
          "android:name": META_NAME,
        },
      };
      metaData.push(channelMeta);
      mainApplication["meta-data"] = metaData;
    }

    channelMeta.$ = {
      ...channelMeta.$,
      "android:value": DEFAULT_CHANNEL,
      "tools:replace": "android:value",
    };

    // Resolve the default_notification_color / icon merge conflicts between
    // expo-notifications and @react-native-firebase/messaging.
    upsertReplaceableMeta(metaData, COLOR_META_NAME, "android:resource");
    upsertReplaceableMeta(metaData, ICON_META_NAME, "android:resource");

    mainApplication["meta-data"] = metaData;

    return config;
  });
};
