import { describe, expect, it } from "vitest";
import {
  logBucketName,
  outdatedLogBucketNames,
  parseLogBucketMillis,
} from "../src/domain/logic/log-buckets";

describe("log-buckets", () => {
  it("names the bucket from the UTC hour", () => {
    // 03:30 local-independent: the constructor takes UTC components directly.
    expect(logBucketName(new Date(Date.UTC(2026, 9, 7, 3, 30)))).toBe("space-20261007-03.log");
    expect(logBucketName(new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe("space-20261231-23.log");
    expect(logBucketName(new Date(Date.UTC(2027, 0, 1, 0, 0)))).toBe("space-20270101-00.log");
  });

  it("round-trips a bucket name to its start moment", () => {
    const startedAt = Date.UTC(2026, 9, 7, 3);
    expect(parseLogBucketMillis("space-20261007-03.log")).toBe(startedAt);
    // The parsed moment names the same bucket back.
    expect(logBucketName(new Date(startedAt))).toBe("space-20261007-03.log");
  });

  it("rejects foreign and malformed file names", () => {
    expect(parseLogBucketMillis("space.log")).toBeNull();
    expect(parseLogBucketMillis("space-20261007-3.log")).toBeNull(); // unpadded hour
    expect(parseLogBucketMillis("space-20261007-03.log.gz")).toBeNull();
    expect(parseLogBucketMillis("client-settings.json")).toBeNull();
    // Impossible dates must not silently parse into a neighboring bucket.
    expect(parseLogBucketMillis("space-20261399-99.log")).toBeNull();
  });

  it("keeps the 24-hour window: exactly-old is dropped, just-young survives", () => {
    const now = new Date(Date.UTC(2026, 9, 7, 12));
    const files = [
      "space-20261007-11.log", // 1 h old — kept
      "space-20261007-12.log", // the current bucket — kept
      "space-20261006-12.log", // exactly 24 h old — dropped
      "space-20261006-11.log", // 25 h old — dropped
      "unrelated.txt", // never touched
    ];
    expect(outdatedLogBucketNames(files, now)).toEqual(["space-20261006-12.log", "space-20261006-11.log"]);
  });
});
