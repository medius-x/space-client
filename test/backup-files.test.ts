import { describe, expect, it } from "vitest";
import {
  backupFilesToPrune,
  backupFileName,
  backupFilePrefix,
  backupHostToken,
  backupStamp,
  clampBackupKeepCount,
} from "../src/domain/logic/backup-files";

describe("backup file naming (backup round 2026-10-28)", () => {
  it("the stamp is sort-safe: ascending text order IS ascending time order", () => {
    const early = backupStamp(new Date(2026, 9, 28, 9, 5, 3));
    const later = backupStamp(new Date(2026, 9, 28, 10, 0, 0));
    const nextDay = backupStamp(new Date(2026, 9, 29, 0, 0, 0));
    expect(early).toBe("20261028-090503");
    expect(early < later).toBe(true);
    expect(later < nextDay).toBe(true);
  });

  it("the host token is the plain hostname; IPv6 (colons are illegal in Windows file names) and junk degrade to 'server'", () => {
    expect(backupHostToken("https://example.com:443")).toBe("example.com");
    expect(backupHostToken("http://[::1]:8080")).toBe("server");
    expect(backupHostToken("not a url")).toBe("server");
  });

  it("name and prefix are aligned so pruning never touches foreign files", () => {
    expect(backupFilePrefix("http://example.com")).toBe("server-backup-example.com-");
    expect(backupFileName("http://example.com", "20261028-090503"))
      .toBe("server-backup-example.com-20261028-090503.zip");
    expect(backupFileName("http://example.com", "x").startsWith(backupFilePrefix("http://example.com"))).toBe(true);
  });
});

describe("backup retention", () => {
  it("keeps the newest N of the prefix, deletes the older rest; other files are untouched", () => {
    const names = [
      "readme.txt",
      "server-backup-a-20261027-010101.zip",
      "server-backup-a-20261028-020202.zip",
      "server-backup-a-20261026-030303.zip",
      "server-backup-b-20261028-040404.zip",
    ];
    expect(backupFilesToPrune(names, "server-backup-a-", 1))
      .toEqual(["server-backup-a-20261027-010101.zip", "server-backup-a-20261026-030303.zip"]);
    expect(backupFilesToPrune(names, "server-backup-a-", 2))
      .toEqual(["server-backup-a-20261026-030303.zip"]);
    expect(backupFilesToPrune(names, "server-backup-a-", 5)).toEqual([]);
    expect(backupFilesToPrune(names, "server-backup-b-", 1)).toEqual([]);
    expect(backupFilesToPrune(names, "server-backup-c-", 1)).toEqual([]);
  });

  it("a keepCount below 1 behaves as 1 — retention never deletes the newest archive", () => {
    const names = ["server-backup-a-1.zip", "server-backup-a-2.zip"];
    expect(backupFilesToPrune(names, "server-backup-a-", 0))
      .toEqual(["server-backup-a-1.zip"]);
  });

  it("the keep count clamps to 1..30 for storage", () => {
    expect(clampBackupKeepCount(0)).toBe(1);
    expect(clampBackupKeepCount(1)).toBe(1);
    expect(clampBackupKeepCount(5)).toBe(5);
    expect(clampBackupKeepCount(99)).toBe(30);
    expect(clampBackupKeepCount(Number.NaN)).toBe(1);
    expect(clampBackupKeepCount("junk")).toBe(1);
  });
});
