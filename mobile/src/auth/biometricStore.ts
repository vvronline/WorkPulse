import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";

/**
 * Biometric ("login with your face") device-credential store — Option B.
 *
 * The server (POST /api/auth/biometric/enroll) mints a high-entropy device
 * secret + an opaque credentialId. We persist BOTH here:
 *   - credentialId: not sensitive (it's an opaque handle) → plain SecureStore.
 *   - deviceSecret: sensitive → SecureStore with `requireAuthentication: true`
 *     so the OS gates every read behind Face ID / Touch ID / device biometric.
 *
 * On login the app reads the secret (triggering the OS biometric prompt) and
 * exchanges it for a normal session via POST /api/auth/biometric/login.
 *
 * No biometric/face data ever touches our code — the OS performs the match
 * and only releases the stored secret on success.
 */

const CRED_ID_KEY = "wp_biometric_cred_id";
const SECRET_KEY = "wp_biometric_secret";

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
}

/** The platform string the server expects for this device. */
export function biometricPlatform(): BiometricPlatform {
  return Platform.OS === "ios" ? "ios" : "android";
}

/**
 * Resolve the device's biometric capability: availability + a HONEST,
 * platform-aware label/icon. We can't know in advance *which* sensor the OS
 * will choose on an Android device that has both face + fingerprint, so we use
 * a neutral "Biometric Login" label there. iOS maps cleanly to Face ID / Touch
 * ID because a given iPhone has exactly one.
 */
export async function getBiometricCapability(): Promise<BiometricCapability> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return { available: false, label: "Biometric Login", kind: "biometric" };
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    if (!isEnrolled) return { available: false, label: "Biometric Login", kind: "biometric" };

    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    const hasFace = types.includes(
      LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
    );
    const hasFingerprint = types.includes(
      LocalAuthentication.AuthenticationType.FINGERPRINT,
    );

    if (Platform.OS === "ios") {
      // An iPhone/iPad has exactly one modality, so the label is unambiguous.
      if (hasFace) return { available: true, label: "Face ID", kind: "face" };
      return { available: true, label: "Touch ID", kind: "fingerprint" };
    }

    // Android: a device may expose BOTH. We can't predict which the OS prompt
    // will use, so prefer an honest neutral label when both are present.
    if (hasFace && hasFingerprint) {
      return { available: true, label: "Biometric Login", kind: "biometric" };
    }
    if (hasFace) return { available: true, label: "Face Unlock", kind: "face" };
    if (hasFingerprint) return { available: true, label: "Fingerprint", kind: "fingerprint" };
    return { available: true, label: "Biometric Login", kind: "biometric" };
  } catch {
    return { available: false, label: "Biometric Login", kind: "biometric" };
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
 * Persist a freshly-enrolled credential. The secret is stored behind the OS
 * biometric gate; the id is stored normally.
 */
export async function saveBiometricCredential(
  credentialId: string,
  deviceSecret: string,
): Promise<void> {
  await SecureStore.setItemAsync(CRED_ID_KEY, credentialId);
  await SecureStore.setItemAsync(SECRET_KEY, deviceSecret, {
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
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
    // Reading a `requireAuthentication: true` item triggers the OS biometric
    // prompt automatically on both platforms.
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
}