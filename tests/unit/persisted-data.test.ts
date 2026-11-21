import { describe, expect, it } from "vitest";
import {
  defaultPersistedData,
  normalizePersistedData,
} from "../../src/adapters/obsidian/persisted-data";
import { EPOCH_ISO } from "../../src/domain/constants";

describe("normalizePersistedData (DESIGN §4.1)", () => {
  it("returns defaults for missing data", () => {
    expect(normalizePersistedData(null)).toEqual(defaultPersistedData());
    expect(normalizePersistedData("garbage")).toEqual(defaultPersistedData());
  });

  it("keeps valid fields and drops malformed ones", () => {
    const data = normalizePersistedData({
      settings: { clientId: "id", clientSecretName: 42 },
      state: {
        lastSyncTime: "not a date",
        fileIndex: {
          "ok.md": { remoteId: "r", md5: "m", mtimeMs: 1, size: 2 },
          "bad.md": { remoteId: "r" },
        },
        driveCache: { vaultFolderId: "v", folderIds: { a: "1", b: 2 } },
      },
    });
    expect(data.settings.clientId).toBe("id");
    expect(data.settings.clientSecretName).toBe("");
    expect(data.state.lastSyncTime).toBe(EPOCH_ISO);
    expect(Object.keys(data.state.fileIndex)).toEqual(["ok.md"]);
    expect(data.state.driveCache).toEqual({ vaultFolderId: "v", folderIds: { a: "1" } });
  });
});
