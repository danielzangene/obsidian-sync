export type SecretKey = "clientSecret" | "refreshToken";

/** Keeps the OAuth client secret and refresh token outside the plugin's data file. */
export interface CredentialStore {
  get(key: SecretKey): string | null;
  /** Stores `value`; an empty string clears the secret. */
  set(key: SecretKey, value: string): void;
}
