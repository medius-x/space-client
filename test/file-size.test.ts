import { describe, expect, it } from "vitest";
import { humanByteSize } from "../src/domain/logic/file-size";

describe("humanByteSize", () => {
  it("renders plain bytes under a kibibyte", () => {
    expect(humanByteSize(0)).toBe("0 B");
    expect(humanByteSize(1)).toBe("1 B");
    expect(humanByteSize(1023)).toBe("1023 B");
  });

  it("renders one decimal past the kibibyte boundary", () => {
    expect(humanByteSize(1024)).toBe("1.0 KB");
    expect(humanByteSize(2048)).toBe("2.0 KB");
    expect(humanByteSize(1536)).toBe("1.5 KB");
  });

  it("walks the unit ladder", () => {
    expect(humanByteSize(1024 * 1024)).toBe("1.0 MB");
    expect(humanByteSize(3 * 1024 * 1024 + 512 * 1024)).toBe("3.5 MB");
    expect(humanByteSize(1024 ** 3)).toBe("1.0 GB");
  });

  it("caps the ladder at GB instead of walking off the units array", () => {
    expect(humanByteSize(5 * 1024 ** 4)).toBe("5120.0 GB");
  });
});
