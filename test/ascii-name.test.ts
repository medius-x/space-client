import { describe, expect, it } from "vitest";
import { sanitizeSlotFileName } from "../src/domain/logic/ascii-name";

/** The server 400s on non-ASCII slot names — the client flattens them for the KEY only. */
describe("sanitizeSlotFileName", () => {
  it("ASCII names pass through untouched", () => {
    expect(sanitizeSlotFileName("photo 1.png")).toBe("photo 1.png");
    expect(sanitizeSlotFileName("clip.MP4")).toBe("clip.MP4");
  });

  it("non-ASCII runs flatten to ONE underscore per run, whitespace collapsed", () => {
    expect(sanitizeSlotFileName("отчёт.pdf")).toBe("_.pdf");
    expect(sanitizeSlotFileName("файл   дока.docx")).toBe("_ _.docx");
    expect(sanitizeSlotFileName("Снимок экрана 2026-09-04.png")).toBe("_ _ 2026-09-04.png");
  });

  it("degenerate inputs fall back to 'file'", () => {
    expect(sanitizeSlotFileName("Изображение")).toBe("file");
    expect(sanitizeSlotFileName("   ")).toBe("file");
  });

  it("overlong names are capped keeping the extension", () => {
    const long = `${"a".repeat(400)}.png`;
    const sanitized = sanitizeSlotFileName(long);
    expect(sanitized.length).toBe(200);
    expect(sanitized.endsWith(".png")).toBe(true);
  });
});
