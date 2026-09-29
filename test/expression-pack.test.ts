import { describe, expect, it } from "vitest";
import {
  buildPackManifest,
  buildZipArchive,
  contentTypeForExtension,
  emojiEntryPath,
  emojiExportEntry,
  extensionFromKey,
  formatExportReport,
  formatImportReport,
  manifestJsonBytes,
  parsePackArchive,
  planPackImport,
  sanitizeFileBaseName,
  stickerEntryPath,
  stickerExportEntry,
  tallyPlannedSkips,
  tallyRuntimeOutcome,
  EMOJI_CATALOG_CAP,
  PACK_FORMAT_VERSION,
  PACK_MAX_FILE_BYTES,
  STICKER_PACK_CAP,
  STICKER_TOTAL_CAP,
  type ImportCatalogState,
  type PackManifest,
  type PackManifestEntry,
} from "../src/domain/logic/expression-pack";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 4, 5, 6]);

function entry(name: string, file: string): PackManifestEntry {
  return { name, file };
}

function manifestOf(
  emojis: PackManifestEntry[],
  packs: { name: string; stickers: PackManifestEntry[] }[] = [],
): PackManifest {
  return buildPackManifest({
    serverName: "Cats",
    exportedAt: "2026-09-30T10:00:00.000Z",
    kind: "expressions",
    emojis,
    packs,
  });
}

function archiveOf(manifest: PackManifest, files: Record<string, Uint8Array>): Uint8Array {
  const entries = new Map<string, Uint8Array>([["pack.json", manifestJsonBytes(manifest)], ...Object.entries(files)]);
  return buildZipArchive(entries);
}

function emptyCatalog(): ImportCatalogState {
  return { emojiCount: 0, emojiNames: new Set(), stickerTotal: 0, packNames: new Set(), packStickerNames: new Map() };
}

describe("expression-pack naming helpers", () => {
  it("recovers a whitelisted extension from the object key tail", () => {
    expect(extensionFromKey("custom-emojis/uuid-1/cat.png")).toBe("png");
    expect(extensionFromKey("stickers/uuid-2/dog.gif")).toBe("gif");
    expect(extensionFromKey("custom-emojis/uuid-3/x.WebP")).toBe("webp"); // case-normalized
  });

  it("returns null for dotless tails and non-image extensions", () => {
    expect(extensionFromKey("custom-emojis/uuid/cat")).toBeNull();
    expect(extensionFromKey("custom-emojis/uuid/cat.")).toBeNull();
    expect(extensionFromKey("custom-emojis/uuid/cat.jpg")).toBeNull();
    expect(extensionFromKey("")).toBeNull();
  });

  it("builds emoji and sticker entry paths, pack index zero-padded", () => {
    expect(emojiEntryPath("cat", "png")).toBe("emojis/cat.png");
    expect(stickerEntryPath(3, "dog", "gif")).toBe("stickers/03/dog.gif");
    expect(stickerEntryPath(0, "dog", "png")).toBe("stickers/00/dog.png");
    expect(contentTypeForExtension("webp")).toBe("image/webp");
  });

  it("resolves export entries; an unresolvable extension yields null", () => {
    expect(emojiExportEntry({ name: "cat", key: "custom-emojis/uuid/cat.png" })).toEqual({ name: "cat", file: "emojis/cat.png" });
    expect(stickerExportEntry(1, { name: "dog", key: "stickers/uuid/dog.gif" })).toEqual({ name: "dog", file: "stickers/01/dog.gif" });
    expect(emojiExportEntry({ name: "cat", key: "custom-emojis/uuid/cat.jpg" })).toBeNull();
  });

  it("assembles the manifest verbatim, entry order preserved", () => {
    const manifest = manifestOf([entry("b", "emojis/b.png"), entry("a", "emojis/a.gif")], [
      { name: "Pack One", stickers: [entry("cat", "stickers/00/cat.png")] },
    ]);
    expect(manifest.formatVersion).toBe(PACK_FORMAT_VERSION);
    expect(manifest.kind).toBe("expressions");
    expect(manifest.emojis.map((emojiEntry) => emojiEntry.name)).toEqual(["b", "a"]);
    expect(manifest.packs[0]?.stickers[0]?.file).toBe("stickers/00/cat.png");
    // purity: exportedAt rides through untouched, no Date inside
    expect(manifest.exportedAt).toBe("2026-09-30T10:00:00.000Z");
  });

  it("sanitizes an OS-safe base name and KEEPS dashes", () => {
    expect(sanitizeFileBaseName("My-Cool:Pack*?<>|/\\x")).toBe("My-Cool Pack x");
    expect(sanitizeFileBaseName("name...")).toBe("name");
    expect(sanitizeFileBaseName("   ")).toBe("pack");
    expect(sanitizeFileBaseName("")).toBe("pack");
    expect(sanitizeFileBaseName("x".repeat(120))).toHaveLength(80);
  });
});

describe("parsePackArchive", () => {
  it("round-trips a built archive: manifest deep-equal, files byte-identical", () => {
    const manifest = manifestOf([entry("cat", "emojis/cat.png")], [
      { name: "Pack One", stickers: [entry("dog", "stickers/00/dog.gif")] },
    ]);
    const parsed = parsePackArchive(archiveOf(manifest, { "emojis/cat.png": PNG_BYTES, "stickers/00/dog.gif": GIF_BYTES }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.manifest).toEqual(manifest);
    expect(Array.from(parsed.files.get("emojis/cat.png") ?? [])).toEqual(Array.from(PNG_BYTES));
    expect(parsed.files.get("stickers/00/dog.gif")).toEqual(GIF_BYTES);
    expect(parsed.files.has("pack.json")).toBe(false); // the manifest rides separately
  });

  it("rejects non-zip garbage", () => {
    const parsed = parsePackArchive(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(parsed).toEqual({ ok: false, reason: "The file is not a valid expression pack archive." });
  });

  it("rejects an archive without pack.json", () => {
    const parsed = parsePackArchive(buildZipArchive(new Map([["emojis/cat.png", PNG_BYTES]])));
    expect(parsed).toEqual({ ok: false, reason: "The archive has no pack.json manifest." });
  });

  it("rejects a manifest that is not valid JSON", () => {
    const parsed = parsePackArchive(buildZipArchive(new Map([["pack.json", new Uint8Array([123, 44, 44, 44])]])));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      return;
    }
    throw new Error("unreachable");
  });

  it("rejects a wrong manifest shape even at the right version", () => {
    const malformed = buildZipArchive(
      new Map([["pack.json", manifestJsonBytes({ ...manifestOf([]), packs: "nope" } as unknown as PackManifest)]]),
    );
    const parsed = parsePackArchive(malformed);
    expect(parsed).toEqual({ ok: false, reason: "The pack.json manifest has an unexpected shape." });
  });

  it("rejects unknown and missing format versions", () => {
    const future = buildZipArchive(
      new Map([["pack.json", manifestJsonBytes({ ...manifestOf([]), formatVersion: 2 } as unknown as PackManifest)]]),
    );
    expect(parsePackArchive(future)).toEqual({ ok: false, reason: "Unsupported pack format version 2." });
    const versionless = buildZipArchive(
      new Map([["pack.json", new Uint8Array(new TextEncoder().encode('{"kind":"expressions"}'))]]),
    );
    expect(parsePackArchive(versionless)).toEqual({ ok: false, reason: "The pack.json manifest has no format version." });
  });

  it("accepts every produced kind and rejects an unknown one", () => {
    for (const kind of ["emojis", "stickers", "sticker-pack"] as const) {
      const archive = buildZipArchive(
        new Map([["pack.json", manifestJsonBytes({ ...manifestOf([]), kind } as unknown as PackManifest)]]),
      );
      expect(parsePackArchive(archive).ok).toBe(true);
    }
    const bogus = buildZipArchive(
      new Map([["pack.json", manifestJsonBytes({ ...manifestOf([]), kind: "everything" } as unknown as PackManifest)]]),
    );
    expect(parsePackArchive(bogus).ok).toBe(false);
  });

  it("never extracts junk entries outside the whitelist", () => {
    const manifest = manifestOf([entry("cat", "emojis/cat.png")]);
    const archive = buildZipArchive(
      new Map([
        ["pack.json", manifestJsonBytes(manifest)],
        ["emojis/cat.png", PNG_BYTES],
        ["evil.exe", new Uint8Array([0x4d, 0x5a])],
      ]),
    );
    const parsed = parsePackArchive(archive);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.files.has("evil.exe")).toBe(false);
    expect(parsed.files.size).toBe(1);
  });
});

describe("planPackImport", () => {
  const catalogWith = (overrides: Partial<ImportCatalogState>): ImportCatalogState => ({ ...emptyCatalog(), ...overrides });

  it("plans every item for import on a clean server", () => {
    const manifest = manifestOf([entry("cat", "emojis/cat.png")], [
      { name: "Pack One", stickers: [entry("dog", "stickers/00/dog.gif")] },
    ]);
    const files = new Map([["emojis/cat.png", PNG_BYTES], ["stickers/00/dog.gif", GIF_BYTES]]);
    const plan = planPackImport(manifest, files, emptyCatalog());
    expect(plan.emojiDecisions).toEqual([{ kind: "import", name: "cat", file: "emojis/cat.png", contentType: "image/png" }]);
    expect(plan.packPlans).toHaveLength(1);
    expect(plan.packPlans[0]?.resolution).toBe("create");
    expect(plan.packPlans[0]?.decisions[0]?.kind).toBe("import");
  });

  it("emoji names collide globally, sticker names only inside their pack", () => {
    const manifest = manifestOf([entry("cat", "emojis/cat.png")], [
      { name: "Pack One", stickers: [entry("cat", "stickers/00/cat.png")] },
    ]);
    const files = new Map([["emojis/cat.png", PNG_BYTES], ["stickers/00/cat.png", PNG_BYTES]]);
    const plan = planPackImport(manifest, files, catalogWith({ emojiNames: new Set(["cat"]) }));
    expect(plan.emojiDecisions[0]).toEqual({ kind: "skip-name-exists", name: "cat" });
    // the same name as a STICKER in a brand-new pack imports fine
    expect(plan.packPlans[0]?.decisions[0]?.kind).toBe("import");
  });

  it("stops planning emoji imports at the 200 cap", () => {
    const names = Array.from({ length: 5 }, (unused, index) => `e${index}`);
    const manifest = manifestOf(names.map((name) => entry(name, `emojis/${name}.png`)));
    const files = new Map(names.map((name) => [`emojis/${name}.png`, PNG_BYTES]));
    const plan = planPackImport(manifest, files, catalogWith({ emojiCount: EMOJI_CATALOG_CAP - 2 }));
    const kinds = plan.emojiDecisions.map((decision) => decision.kind);
    expect(kinds.filter((kind) => kind === "import")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "skip-limit")).toHaveLength(3);
  });

  it("the 200-sticker cap spans all packs", () => {
    const manifest = manifestOf([], [
      { name: "Pack One", stickers: Array.from({ length: 10 }, (unused, index) => entry(`s${index}`, `stickers/00/s${index}.png`)) },
    ]);
    const files = new Map(
      Array.from({ length: 10 }, (unused, index) => [`stickers/00/s${index}.png`, PNG_BYTES] as const),
    );
    const plan = planPackImport(manifest, files, catalogWith({ stickerTotal: STICKER_TOTAL_CAP - 5 }));
    const kinds = plan.packPlans[0]?.decisions.map((decision) => decision.kind) ?? [];
    expect(kinds.filter((kind) => kind === "import")).toHaveLength(5);
    expect(kinds.filter((kind) => kind === "skip-limit")).toHaveLength(5);
  });

  it("an existing pack merges by exact name; collisions skip inside it only", () => {
    const manifest = manifestOf([], [
      { name: "Pack One", stickers: [entry("cat", "stickers/00/cat.png"), entry("dog", "stickers/00/dog.png")] },
      { name: "Pack Two", stickers: [entry("cat", "stickers/01/cat.png")] },
    ]);
    const files = new Map([
      ["stickers/00/cat.png", PNG_BYTES],
      ["stickers/00/dog.png", PNG_BYTES],
      ["stickers/01/cat.png", PNG_BYTES],
    ]);
    const catalog = catalogWith({
      packNames: new Set(["Pack One"]),
      packStickerNames: new Map([["Pack One", new Set(["cat"])]]),
    });
    const plan = planPackImport(manifest, files, catalog);
    const firstPack = plan.packPlans.find((packPlan) => packPlan.manifestPack.name === "Pack One");
    expect(firstPack?.resolution).toBe("existing");
    expect(firstPack?.decisions).toEqual([
      { kind: "skip-name-exists", name: "cat" },
      { kind: "import", name: "dog", file: "stickers/00/dog.png", contentType: "image/png" },
    ]);
    // the same "cat" in ANOTHER pack imports — names collide per-pack only
    const secondPack = plan.packPlans.find((packPlan) => packPlan.manifestPack.name === "Pack Two");
    expect(secondPack?.decisions[0]?.kind).toBe("import");
  });

  it("a pack that must be created but hits the 20-pack cap is skipped whole", () => {
    const manifest = manifestOf([], [{ name: "Fresh", stickers: [entry("cat", "stickers/00/cat.png")] }]);
    const files = new Map([["stickers/00/cat.png", PNG_BYTES]]);
    const twentyNames = Array.from({ length: STICKER_PACK_CAP }, (unused, index) => `p${index}`);
    const plan = planPackImport(manifest, files, catalogWith({ packNames: new Set(twentyNames) }));
    expect(plan.packPlans).toHaveLength(0);
    expect(plan.skippedPacks).toEqual([{ name: "Fresh", reason: "pack-limit", stickerCount: 1 }]);
  });

  it("a duplicate name in the manifest keeps the first entry and skips the rest as invalid", () => {
    const manifest = manifestOf([entry("cat", "emojis/cat.png"), entry("cat", "emojis/cat-2.png")]);
    const files = new Map([["emojis/cat.png", PNG_BYTES], ["emojis/cat-2.png", PNG_BYTES]]);
    const plan = planPackImport(manifest, files, emptyCatalog());
    expect(plan.emojiDecisions[0]?.kind).toBe("import");
    expect(plan.emojiDecisions[1]).toMatchObject({ kind: "skip-invalid", name: "cat", reason: "duplicate name in the pack" });
  });

  it("two manifest packs sharing a name merge into ONE plan with deduped stickers", () => {
    const manifest = manifestOf(
      [],
      [
        { name: " Pack One ", stickers: [entry("cat", "stickers/00/cat.png")] },
        { name: "Pack One", stickers: [entry("dog", "stickers/01/dog.png"), entry("cat", "stickers/01/cat-2.png")] },
      ],
    );
    const files = new Map([
      ["stickers/00/cat.png", PNG_BYTES],
      ["stickers/01/dog.png", PNG_BYTES],
      ["stickers/01/cat-2.png", PNG_BYTES],
    ]);
    const plan = planPackImport(manifest, files, emptyCatalog());
    expect(plan.packPlans).toHaveLength(1);
    const merged = plan.packPlans[0];
    expect(merged?.manifestPack.name).toBe("Pack One"); // trimmed
    expect(merged?.manifestPack.stickers).toHaveLength(3);
    const kinds = merged?.decisions.map((decision) => decision.kind) ?? [];
    expect(kinds).toEqual(["import", "import", "skip-invalid"]);
  });

  it("invalid items each get their own skip reason", () => {
    const oversized = new Uint8Array(PACK_MAX_FILE_BYTES + 1);
    const manifest = manifestOf([
      entry("Cat", "emojis/Cat.png"), // bad grammar (uppercase)
      entry("x".repeat(33), `emojis/${"x".repeat(33)}.png`), // too long
      entry("jpg", "emojis/jpg.jpg"), // bad extension
      entry("ghost", "emojis/ghost.png"), // file missing from the archive
      entry("big", "emojis/big.png"), // over 1 MB
    ]);
    const files = new Map([["emojis/Cat.png", PNG_BYTES], [`emojis/${"x".repeat(33)}.png`, PNG_BYTES], ["emojis/jpg.jpg", PNG_BYTES], ["emojis/big.png", oversized]]);
    const plan = planPackImport(manifest, files, emptyCatalog());
    expect(plan.emojiDecisions.map((decision) => (decision.kind === "skip-invalid" ? decision.reason : decision.kind))).toEqual([
      "invalid name",
      "invalid name",
      "unsupported file type",
      "missing file",
      "file exceeds 1 MB",
    ]);
  });

  it("a blank or oversized pack name skips the whole pack as invalid", () => {
    const manifest = manifestOf([], [
      { name: "   ", stickers: [entry("cat", "stickers/00/cat.png")] },
      { name: "x".repeat(33), stickers: [entry("dog", "stickers/01/dog.png")] },
    ]);
    const plan = planPackImport(manifest, new Map(), emptyCatalog());
    expect(plan.packPlans).toHaveLength(0);
    expect(plan.skippedPacks.map((skipped) => skipped.reason)).toEqual(["invalid-name", "invalid-name"]);
    expect(plan.skippedPacks.map((skipped) => skipped.stickerCount)).toEqual([1, 1]);
  });
});

describe("expression-pack report builders", () => {
  it("tallies planned skips including whole skipped packs", () => {
    const manifest = manifestOf([entry("cat", "emojis/cat.png"), entry("dup", "emojis/dup.png")], [
      { name: "Fresh", stickers: [entry("s1", "stickers/00/s1.png")] },
    ]);
    const files = new Map([["emojis/cat.png", PNG_BYTES], ["stickers/00/s1.png", PNG_BYTES]]);
    const catalog: ImportCatalogState = {
      emojiCount: 0,
      emojiNames: new Set(["cat"]),
      stickerTotal: 0,
      packNames: new Set(Array.from({ length: STICKER_PACK_CAP }, (unused, index) => `p${index}`)),
      packStickerNames: new Map(),
    };
    const plan = planPackImport(manifest, files, catalog);
    // cat → name-exists; dup → invalid (missing file); Fresh → pack-limit with 1 sticker
    expect(tallyPlannedSkips(plan)).toEqual({ imported: 0, skippedNames: 1, skippedLimits: 1, invalid: 1, failed: 0 });
  });

  it("merges runtime outcomes: 409 counts as a name conflict, not a failure", () => {
    let counts = tallyRuntimeOutcome({ imported: 0, skippedNames: 0, skippedLimits: 0, invalid: 0, failed: 0 }, "imported");
    counts = tallyRuntimeOutcome(counts, "conflict");
    counts = tallyRuntimeOutcome(counts, "failed");
    expect(counts).toEqual({ imported: 1, skippedNames: 1, skippedLimits: 0, invalid: 0, failed: 1 });
  });

  it("renders only the non-zero import segments", () => {
    expect(formatImportReport({ imported: 40, skippedNames: 0, skippedLimits: 0, invalid: 0, failed: 0 }, 0)).toBe("Imported 40");
    expect(
      formatImportReport({ imported: 38, skippedNames: 3, skippedLimits: 2, invalid: 1, failed: 1 }, 2),
    ).toBe("Imported 38, skipped 3 (name exists), 2 skipped (limit), 1 invalid, 1 failed · created 2 packs");
    expect(formatImportReport({ imported: 1, skippedNames: 0, skippedLimits: 0, invalid: 0, failed: 0 }, 1)).toBe(
      "Imported 1 · created 1 pack",
    );
  });

  it("renders the export report with singular/plural and the unavailable suffix", () => {
    expect(formatExportReport({ emojis: 38, stickers: 45, packs: 3, unavailable: 0, fileName: "cats.zip" })).toBe(
      "Exported 38 emojis and 45 stickers (3 packs) to cats.zip",
    );
    expect(formatExportReport({ emojis: 1, stickers: 1, packs: 1, unavailable: 1, fileName: "one.zip" })).toBe(
      "Exported 1 emoji and 1 sticker (1 pack) to one.zip · 1 file was unavailable and skipped",
    );
    expect(formatExportReport({ emojis: 2, stickers: 0, packs: 0, unavailable: 2, fileName: "two.zip" })).toBe(
      "Exported 2 emojis and 0 stickers to two.zip · 2 files were unavailable and skipped",
    );
  });
});
