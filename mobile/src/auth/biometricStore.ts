import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";

/**
 * Biometric ("login with your face") device-credential store — Option B.
 *
 * The server (POST /api/auth/biometric/enroll) mints a high-entropy device
 * secret + an opaque credentialId. We persist BOTH here:
 *   - credentialId: not sensitive (it's an opaque handle) → plain SecureStore.
 *   - deviceSecret: sensitive. On devices with a STRONG (Android Class 3 /
 *     iOS) biometric we store it with `requireAuthentication: true` so the OS
 *     gates every read behind a hardware-backed KeyStore key. On WEAK-only
 *     devices (Class 2 camera Face Unlock, e.g. OnePlus Pad Go) the KeyStore
 *     can't release such a key, so we store the secret without that flag and
 *     gate reads with an explicit `authenticateAsync()` app-level prompt that
 *     accepts weak biometrics.
 *
 * On login the app reads the secret (triggering the OS biometric prompt) and
 * exchanges it for a normal session via POST /api/auth/biometric/login.
 *
 * No biometric/face data ever touches our code — the OS performs the match
 * and only releases the stored secret on success.
 */

const CRED_ID_KEY = "wp_biometric_cred_id";
const SECRET_KEY = "wp_biometric_secret";

/**
 * Marks that the current secret was stored with the WEAK fallback (no
 * `requireAuthentication`), so `unlockBiometricCredential()` knows to gate the
 * read with an explicit `authenticateAsync()` instead of relying on the
 * KeyStore prompt.
 */
const WEAK_FLAG_KEY = "wp_biometric_weak";

export type BiometricPlatform = "ios" | "android";

/** Visual "kind" so the UI can pick the right icon. */
export type BiometricKind = "face" | "fingerprint" | "biometric";

export interface BiometricCapability {
  /** Hardware present AND a biometric enrolled with the OS. */
  available: boolean;
  /** User-facing label, e.g. "Face ID", "Touch ID", "Fingerprint". */
  label: string;
  /** Icon hint for the UI. */
  kind: BiometricKind;
  /**
   * Whether the device exposes a STRONG (Android Class 3 / iOS) biometric that
   * can gate a hardware-backed KeyStore secret. When false, the device only
   * has a WEAK (Class 2, camera-based Face Unlock) biometric — common on
   * tablets like the OnePlus Pad Go — which CANNOT unlock a KeyStore key, so
   * we fall back to an app-level `authenticateAsync()` gate.
   */
  strong: boolean;
}

/** The platform string the server expects for this device. */
export function biometricPlatform(): BiometricPlatform {
  return Platform.OS === "ios" ? "ios" : "android";
}

/**
 * Resolve the device's biometric capability: availability + a HONEST,
 * platform-aware label/icon + whether a STRONG biometric is present.
 *
 * iOS maps cleanly to Face ID / Touch ID because a given iPhone/iPad has
 * exactly one modality. Android may expose both face + fingerprint (or only a
 * weak camera Face Unlock), so we report a combined label and the `strong`
 * flag the store uses to pick the KeyStore vs app-level path.
 */
export async function getBiometricCapability(): Promise<BiometricCapability> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();

    // `isEnrolledAsync()` only reports TRUE for a *strong* (Class 3) biometric
    // on Android. Many tablets (e.g. OnePlus Pad Go / Oppo Pad) expose only a
    // *weak* (Class 2) camera-based Face Unlock and have no fingerprint sensor,
    // so `isEnrolledAsync()` returns FALSE there even though the user HAS set
    // up face unlock — which used to hide the login button + profile toggle.
    //
    // We additionally consult `getEnrolledLevelAsync()` and treat ANY enrolled
    // biometric level (weak OR strong) as usable. Only `NONE` means no
    // biometric is enrolled at all.
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    let enrolledLevel: LocalAuthentication.SecurityLevel | null = null;
    try {
      enrolledLevel = await LocalAuthentication.getEnrolledLevelAsync();
    } catch {
      enrolledLevel = null;
    }
    const hasStrong =
      enrolledLevel === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG ||
      // `isEnrolledAsync()` returning true also implies a strong biometric on
      // Android; on iOS enrollment is always "strong" for our purposes.
      isEnrolled;
    const hasWeak =
      enrolledLevel === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK;
    const hasWeakOrStrong = hasStrong || hasWeak;

    if (__DEV__) {
      console.log("[biometric] capability probe", {
        platform: Platform.OS,
        hasHardware,
        isEnrolled,
        enrolledLevel,
        hasStrong,
        hasWeak,
      });
    }

    // A weak-only camera Face Unlock device (e.g. OnePlus Pad Go) may report
    // `hasHardwareAsync() === false` on some OEM builds, yet still expose an
    // enrolled WEAK level. Treat an enrolled weak biometric as available even
    // when the hardware probe is unenthusiastic.
    if (!hasHardware && !hasWeak) {
      return {
        available: false,
        label: "Biometric Login",
        kind: "biometric",
        strong: false,
      };
    }
    if (!hasWeakOrStrong) {
      return {
        available: false,
        label: "Biometric Login",
        kind: "biometric",
        strong: false,
      };
    }

    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    const hasFace = types.includes(
      LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
    );
    const hasFingerprint = types.includes(
      LocalAuthentication.AuthenticationType.FINGERPRINT,
    );

    if (Platform.OS === "ios") {
      // An iPhone/iPad has exactly one modality, so the label is unambiguous.
      if (hasFace)
        return { available: true, label: "Face ID", kind: "face", strong: true };
      return {
        available: true,
        label: "Touch ID",
        kind: "fingerprint",
        strong: true,
      };
    }

    // Android. `strong` decides whether the KeyStore-gated path can be used.
    // A weak-only Face Unlock device reports no supported *types* at all
    // (Class 2 isn't surfaced by `supportedAuthenticationTypesAsync()`), so we
    // infer "face" when only a weak biometric is enrolled.
    if (hasFace && hasFingerprint) {
      return {
        available: true,
        label: "Face or Fingerprint",
        kind: "biometric",
        strong: hasStrong,
      };
    }
    if (hasFingerprint) {
      return {
        available: true,
        label: "Fingerprint",
        kind: "fingerprint",
        strong: hasStrong,
      };
    }
    if (hasFace) {
      return {
        available: true,
        label: "Face Unlock",
        kind: "face",
        strong: hasStrong,
      };
    }
    // No supported types surfaced but a biometric IS enrolled → almost always a
    // weak-only camera Face Unlock. Offer it via the app-level fallback.
    if (hasWeak) {
      return {
        available: true,
        label: "Face Unlock",
        kind: "face",
        strong: false,
      };
    }
    return {
      available: true,
      label: "Biometric Login",
      kind: "biometric",
      strong: hasStrong,
    };
  } catch {
    return {
      available: false,
      label: "Biometric Login",
      kind: "biometric",
      strong: false,
    };
  }
}

/**
 * Whether this device has biometric hardware AND the user has enrolled at
 * least one biometric (face/fingerprint) with the OS. Both are required
 * before we offer biometric login.
 */
export async function isBiometricAvailable(): Promise<boolean> {
  return (await getBiometricCapability()).available;
}

/** True when a biometric credential has been enrolled+stored on this device. */
export async function hasBiometricCredential(): Promise<boolean> {
  try {
    const id = await SecureStore.getItemAsync(CRED_ID_KEY);
    return !!id;
  } catch {
    return false;
  }
}

/**
 * Persist a freshly-enrolled credential.
 *
 * On STRONG-biometric devices the secret is stored behind the OS KeyStore gate
 * (`requireAuthentication: true`). On WEAK-only devices the KeyStore can't
 * release such a key, so we store the secret plainly (still encrypted at rest
 * by SecureStore) and record a flag so reads are gated by an explicit
 * `authenticateAsync()` prompt that accepts weak biometrics.
 */
export async function saveBiometricCredential(
  credentialId: string,
  deviceSecret: string,
): Promise<void> {
  const { strong } = await getBiometricCapability();
  await SecureStore.setItemAsync(CRED_ID_KEY, credentialId);

  if (strong) {
    await SecureStore.deleteItemAsync(WEAK_FLAG_KEY).catch(() => {});
    await SecureStore.setItemAsync(SECRET_KEY, deviceSecret, {
      requireAuthentication: true,
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return;
  }

  // WEAK-only fallback: store without the KeyStore auth gate and remember that
  // we did so, so unlock knows to prompt via authenticateAsync() itself.
  await SecureStore.setItemAsync(SECRET_KEY, deviceSecret, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(WEAK_FLAG_KEY, "1");
}

/** Read the stored credentialId (no biometric prompt). */
export async function getBiometricCredentialId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(CRED_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * Read the device secret, triggering the OS biometric prompt. Returns the
 * { credentialId, deviceSecret } pair to POST to /auth/biometric/login, or
 * null if the user cancelled / the read failed.
 */
export async function unlockBiometricCredential(): Promise<{
  credentialId: string;
  deviceSecret: string;
} | null> {
  try {
    const credentialId = await SecureStore.getItemAsync(CRED_ID_KEY);
    if (!credentialId) return null;

    const isWeak = (await SecureStore.getItemAsync(WEAK_FLAG_KEY)) === "1";

    if (isWeak) {
      // WEAK-only device: the secret isn't KeyStore-gated, so prompt for the
      // biometric ourselves (allowing device fallback + weak biometrics) and
      // only read the secret after a successful match.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Sign in",
        // Allow the device PIN/pattern fallback so a weak-face mismatch still
        // has a recovery path without dropping to password entirely.
        disableDeviceFallback: false,
      });
      if (!result.success) return null;
      const deviceSecret = await SecureStore.getItemAsync(SECRET_KEY);
      if (!deviceSecret) return null;
      return { credentialId, deviceSecret };
    }

    // STRONG device: reading a `requireAuthentication: true` item triggers the
    // OS biometric prompt automatically on both platforms.
    const deviceSecret = await SecureStore.getItemAsync(SECRET_KEY, {
      requireAuthentication: true,
    });
    if (!deviceSecret) return null;
    return { credentialId, deviceSecret };
  } catch {
    // User cancelled the prompt, or the secret is no longer retrievable.
    return null;
  }
}

/** Remove the local biometric credential (e.g. on disable or after revoke). */
export async function clearBiometricCredential(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CRED_ID_KEY);
  } catch {
    /* ignore */
  }
  try {
    await SecureStore.deleteItemAsync(SECRET_KEY);
  } catch {
    /* ignore */
  }
  try {
    await SecureStore.deleteItemAsync(WEAK_FLAG_KEY);
  } catch {
    /* ignore */
  }
}