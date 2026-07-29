/**
 * Config plugin: inject a RELEASE signing config into the generated Android
 * project at prebuild time.
 *
 * WHY THIS EXISTS:
 * Expo's generated `android/app/build.gradle` signs the `release` build type
 * with `signingConfigs.debug` (it literally ships the comment "Caution! In
 * production, you need to generate your own keystore file."). A debug-signed
 * artifact is fine for sideloading but the Play Store REJECTS it outright, so
 * a release keystore has to be wired in before any store submission.
 *
 * Wiring the keystore through `android/gradle.properties` alone does NOT work:
 * CI regenerates the gitignored `android/` project with `expo prebuild` on
 * every run, which OVERWRITES build.gradle and throws the signing block away.
 * The same "prebuild clobbers it" problem is why `withAndroidGradleMemory`
 * exists — this plugin is its signing counterpart and re-applies the config on
 * every prebuild.
 *
 * CREDENTIALS (never committed — `*.jks` and `.env*` are gitignored):
 *   ANDROID_KEYSTORE_PATH      absolute path, or relative to `mobile/`
 *   ANDROID_KEYSTORE_PASSWORD  store password
 *   ANDROID_KEY_ALIAS          key alias inside the keystore
 *   ANDROID_KEY_PASSWORD       key password (defaults to the store password)
 *
 * BEHAVIOUR WHEN UNSET:
 * If the env vars are absent (a normal local dev prebuild) the plugin logs and
 * leaves the debug signing in place, so `npx expo prebuild` / `run:android`
 * keep working with no credentials. Only release CI needs them.
 *
 * The keystore is referenced by ABSOLUTE path so it can live outside the repo
 * (CI decodes it to the runner temp dir). Gradle resolves a relative
 * `storeFile` against `android/app/`, which is not what anyone means here.
 */
const fs = require("fs");
const path = require("path");
const { withAppBuildGradle } = require("expo/config-plugins");

const RELEASE_CONFIG_NAME = "release";

/** Escape a value for embedding inside a single-quoted Groovy string. */
function groovyEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Read + validate signing credentials from the environment.
 * Returns null when signing is not configured (dev prebuild).
 */
function resolveCredentials(projectRoot) {
  const storePath = process.env.ANDROID_KEYSTORE_PATH;
  const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
  const keyAlias = process.env.ANDROID_KEY_ALIAS;
  // Most keystores use the same password for the store and the key; default to
  // the store password so CI only has to provide three secrets.
  const keyPassword =
    process.env.ANDROID_KEY_PASSWORD || process.env.ANDROID_KEYSTORE_PASSWORD;

  if (!storePath && !storePassword && !keyAlias) {
    return null;
  }

  // A PARTIAL configuration is always a mistake (typo'd secret name, missing CI
  // env). Failing loudly here beats silently shipping a debug-signed release
  // that the Play Console rejects after a full build has been paid for.
  const missing = [];
  if (!storePath) missing.push("ANDROID_KEYSTORE_PATH");
  if (!storePassword) missing.push("ANDROID_KEYSTORE_PASSWORD");
  if (!keyAlias) missing.push("ANDROID_KEY_ALIAS");
  if (missing.length > 0) {
    throw new Error(
      `[withAndroidSigning] incomplete release signing configuration; missing: ${missing.join(
        ", ",
      )}. Set all of them, or none (to keep debug signing for local builds).`,
    );
  }

  const absoluteStorePath = path.isAbsolute(storePath)
    ? storePath
    : path.resolve(projectRoot, storePath);

  if (!fs.existsSync(absoluteStorePath)) {
    throw new Error(
      `[withAndroidSigning] keystore not found at ${absoluteStorePath} ` +
        `(ANDROID_KEYSTORE_PATH=${storePath}).`,
    );
  }

  return {
    storeFile: absoluteStorePath,
    storePassword,
    keyAlias,
    keyPassword,
  };
}

/**
 * Locate `signingConfigs { ... }` and return the span of its body by walking
 * braces. A lazy regex CANNOT be used here: `signingConfigs {[\s\S]*?release {`
 * happily runs past the end of the block and matches the `release` entry inside
 * `buildTypes`, which made an earlier version of this plugin think the release
 * signing config already existed and silently skip injecting it (leaving the
 * build debug-signed — the exact bug this plugin exists to prevent).
 */
function findSigningConfigsBody(contents) {
  const match = /signingConfigs\s*\{/.exec(contents);
  if (!match) return null;

  const openIndex = match.index + match[0].length - 1; // index of '{'
  let depth = 0;
  for (let i = openIndex; i < contents.length; i++) {
    const ch = contents[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { start: openIndex + 1, end: i, insertAt: openIndex + 1 };
      }
    }
  }
  return null;
}

/**
 * Insert a `release { ... }` entry into the existing `signingConfigs { ... }`
 * block.
 */
function addReleaseSigningConfig(contents, creds) {
  const span = findSigningConfigsBody(contents);
  if (!span) {
    throw new Error(
      "[withAndroidSigning] could not find a `signingConfigs {` block in " +
        "android/app/build.gradle. The Expo template changed — update this plugin.",
    );
  }

  const body = contents.slice(span.start, span.end);
  if (new RegExp(`\\b${RELEASE_CONFIG_NAME}\\s*\\{`).test(body)) {
    return contents; // idempotent re-run
  }

  const releaseBlock =
    `\n        ${RELEASE_CONFIG_NAME} {\n` +
    `            storeFile file('${groovyEscape(creds.storeFile)}')\n` +
    `            storePassword '${groovyEscape(creds.storePassword)}'\n` +
    `            keyAlias '${groovyEscape(creds.keyAlias)}'\n` +
    `            keyPassword '${groovyEscape(creds.keyPassword)}'\n` +
    `        }`;

  return (
    contents.slice(0, span.insertAt) +
    releaseBlock +
    contents.slice(span.insertAt)
  );
}

/**
 * Repoint the `release` build type at `signingConfigs.release`. The generated
 * template hardcodes `signingConfig signingConfigs.debug` inside
 * `buildTypes { release { ... } }`.
 */
function pointReleaseBuildTypeAtReleaseConfig(contents) {
  const buildTypesMatch = contents.match(
    /(buildTypes\s*\{[\s\S]*?\n\s*release\s*\{)([\s\S]*?)(\n\s*\})/,
  );
  if (!buildTypesMatch) {
    throw new Error(
      "[withAndroidSigning] could not find `buildTypes { release { ... } }` in " +
        "android/app/build.gradle. The Expo template changed — update this plugin.",
    );
  }

  const [full, head, body, tail] = buildTypesMatch;
  if (/signingConfig\s+signingConfigs\.release/.test(body)) {
    return contents; // idempotent re-run
  }
  if (!/signingConfig\s+signingConfigs\.debug/.test(body)) {
    throw new Error(
      "[withAndroidSigning] the `release` build type does not reference " +
        "`signingConfigs.debug` as expected. The Expo template changed — " +
        "update this plugin.",
    );
  }

  const patchedBody = body.replace(
    /signingConfig\s+signingConfigs\.debug/,
    `signingConfig signingConfigs.${RELEASE_CONFIG_NAME}`,
  );
  return contents.replace(full, `${head}${patchedBody}${tail}`);
}

module.exports = function withAndroidSigning(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== "groovy") {
      throw new Error(
        "[withAndroidSigning] expected a Groovy build.gradle; got " +
          config.modResults.language,
      );
    }

    const creds = resolveCredentials(config.modRequest.projectRoot);
    if (!creds) {
      console.log(
        "[withAndroidSigning] no ANDROID_KEYSTORE_* env vars set — keeping " +
          "debug signing (fine for local dev; release CI must set them).",
      );
      return config;
    }

    let contents = config.modResults.contents;
    contents = addReleaseSigningConfig(contents, creds);
    contents = pointReleaseBuildTypeAtReleaseConfig(contents);
    config.modResults.contents = contents;

    // Never log secrets — only the alias and path, which are not sensitive.
    console.log(
      `[withAndroidSigning] release signing wired up (alias='${creds.keyAlias}', ` +
        `keystore='${creds.storeFile}')`,
    );
    return config;
  });
};
