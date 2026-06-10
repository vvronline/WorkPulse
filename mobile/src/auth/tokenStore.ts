import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "wp_auth_token";

/** Read the persisted JWT, or null if not signed in. */
export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Persist the JWT in the device's secure keystore. */
export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

/** Remove the persisted JWT (sign out). */
export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
