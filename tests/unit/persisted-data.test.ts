import { describe, expect, it } from "vitest";
import {
  defaultPersistedData,
  migrateLegacySecrets,
  normalizePersistedData,
} from "../../src/adapters/obsidian/persisted-data";
import { EPOCH_ISO } from "../../src/domain/constants";
import type { CredentialStore, SecretKey } from "../../src/ports/credential-store";

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<SecretKey, string>();
  get(key: SecretKey): string | null {
    return this.values.get(key) || null;
  }
  set(key: SecretKey, value: string): void {
    this.values.set(key, value);
  }
}

describe("normalizePersistedData (DESIGN §4.1)", () => {
  it("returns defaults for missing data", () => {
    expect(normalizePersistedData(null)).toEqual(defaultPersistedData());
    expect(normalizePersistedData("garbage")).toEqual(defaultPersistedData());
  });

  it("keeps valid fields and drops malformed ones", () => {
    const data = normalizePersistedData({
      settings: { clientId: "id", remoteFolderName: 42 },
      state: {
        lastSyncTime: "not a date",
        fileIndex: {
          "ok.md": { remoteId: "r", md5: "m", mtimeMs: 1, size: 2 },
          "bad.md": { remoteId: "r" },
        },
        driveCache: { vaultFolderId: "v", folderIds: { a: "1", b: 2 } },
      },
    });
    expect(data.settings).toEqual({ clientId: "id", remoteFolderName: "" });
    expect(data.state.lastSyncTime).toBe(EPOCH_ISO);
    expect(Object.keys(data.state.fileIndex)).toEqual(["ok.md"]);
    expect(data.state.driveCache).toEqual({ vaultFolderId: "v", folderIds: { a: "1" } });
  });

  it("upgrades schema v1 settings, dropping the secret names", () => {
    const data = normalizePersistedData({
      schemaVersion: 1,
      settings: { clientId: "id", clientSecretName: "s", refreshTokenName: "t" },
    });
    expect(data.schemaVersion).toBe(2);
    expect(data.settings).toEqual({ clientId: "id", remoteFolderName: "" });
  });
});

describe("migrateLegacySecrets", () => {
  const named: Record<string, string> = { "my-secret": "S3CRET", "my-token": "1//TOKEN" };
  const read = (name: string) => named[name] ?? null;

  it("copies secrets referenced by schema v1 settings", () => {
    const store = new MemoryCredentialStore();
    migrateLegacySecrets(
      { settings: { clientSecretName: "my-secret", refreshTokenName: "my-token" } },
      read,
      store,
    );
    expect(store.get("clientSecret")).toBe("S3CRET");
    expect(store.get("refreshToken")).toBe("1//TOKEN");
  });

  it("never overwrites a value already set, and ignores missing names", () => {
    const store = new MemoryCredentialStore();
    store.set("clientSecret", "NEWER");
    migrateLegacySecrets(
      { settings: { clientSecretName: "my-secret", refreshTokenName: "unknown" } },
      read,
      store,
    );
    expect(store.get("clientSecret")).toBe("NEWER");
    expect(store.get("refreshToken")).toBeNull();
  });

  it("does nothing for schema v2 data", () => {
    const store = new MemoryCredentialStore();
    migrateLegacySecrets({ settings: { clientId: "id" } }, read, store);
    expect(store.values.size).toBe(0);
  });
});
