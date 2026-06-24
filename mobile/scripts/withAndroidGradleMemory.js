const { withGradleProperties } = require("expo/config-plugins");

// The CI release workflow regenerates the native `mobile/android` project with
// `expo prebuild` on every run, which OVERWRITES android/gradle.properties with
// Expo's default template (heap = 2 GiB, metaspace = 512 MiB). With the full RN
// module set, the release build OOMs ("Java heap space") in
// :app:mergeReleaseJavaResource / R8 / lintVital — exactly the failure the build
// log reports ("currently configured max heap space is '2 GiB'").
//
// Committing android/gradle.properties does NOT help because prebuild clobbers
// it. This config plugin re-applies the JVM memory settings during prebuild so
// they survive into the generated project.
//
// Keep these in sync with the (now redundant in CI) committed
// android/gradle.properties so local builds and CI behave identically.
const JVM_ARGS =
    "-Xmx6144m -XX:MaxMetaspaceSize=1024m -XX:+UseG1GC " +
    "-XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8";

/**
 * Upserts a `key=value` entry in the parsed gradle.properties mod results.
 * Expo represents gradle.properties as an array of { type, key, value } items.
 */
function upsertGradleProperty(modResults, key, value) {
    const existing = modResults.find(
        (item) => item.type === "property" && item.key === key,
    );
    if (existing) {
        existing.value = value;
        return modResults;
    }
    modResults.push({ type: "property", key, value });
    return modResults;
}

module.exports = function withAndroidGradleMemory(config) {
    return withGradleProperties(config, (config) => {
        config.modResults = upsertGradleProperty(
            config.modResults,
            "org.gradle.jvmargs",
            JVM_ARGS,
        );
        return config;
    });
};