import type { SecretStorage } from "obsidian";
import type { CredentialStore, SecretKey } from "../../ports/credential-store";

/** Fixed IDs in Obsidian's secret storage (lowercase letters, digits and dashes only). */
const SECRET_IDS: Record<SecretKey, string> = {
  clientSecret: "gdrive-sync-client-secret",
  refreshToken: "gdrive-sync-refresh-token",
};

/** `CredentialStore` on Obsidian's secret storage. */
export class SecretStorageCredentialStore implements CredentialStore {
  constructor(private readonly secrets: SecretStorage) {}

  get(key: SecretKey): string | null {
    const value = this.secrets.getSecret(SECRET_IDS[key]);
    return value === null || value === "" ? null : value;
  }

  set(key: SecretKey, value: string): void {
    this.secrets.setSecret(SECRET_IDS[key], value);
  }
}
