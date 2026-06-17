const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const META_NAME = "com.google.firebase.messaging.default_notification_channel_id";
const DEFAULT_CHANNEL = "default";

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

    return config;
  });
};