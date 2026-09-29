import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/**
 * Pure logic of the expression-pack exchange (export/import of custom emojis
 * and sticker packs as a ZIP archive) — the emoji-picker/reaction-picker
 * precedent: everything testable lives here, the network ladder stays in the
 * renderer orchestrator. The archive is assembled and read ENTIRELY on the
 * client; the server is not touched (files travel client ↔ MinIO over the
 * existing presigned ladder, exactly like a manual upload).
 *
 * Archive layout (STORE — png/gif/webp are already compressed):
 *
 *   pack.json                        — the manifest (schema below)
 *   emojis/<name>.<ext>              — the name grammar has no dots
 *   stickers/<NN>/<name>.<ext>       — NN = pack index, zero-padded
 *
 * Sticker PACK names are free text (spaces, unicode) and cannot be folder
 * names — that is why sticker files are grouped by manifest index instead.
 */

export const PACK_FORMAT_VERSION = 1;

/** The only image extensions the upload slots accept (server-side ladder). */
export const PACK_IMAGE_EXTENSIONS = ["png", "gif", "webp"] as const;

/** Per-file size cap — the same 1 MB gate the manual upload form enforces. */
export const PACK_MAX_FILE_BYTES = 1024 * 1024;

/** Sanity cap on the archive itself; anything bigger is rejected up front. */
export const IMPORT_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;

/** Server catalog caps (mirrored for the import planner and the report). */
export const EMOJI_CATALOG_CAP = 200;
export const STICKER_TOTAL_CAP = 200;
export const STICKER_PACK_CAP = 20;

/** The catalog name grammar (emojis and stickers share it). */
const PACK_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

const PACK_MANIFEST_PATH = "pack.json";

export interface PackManifestEntry {
  /** Catalog name, validated against the grammar on import. */
  name: string;
  /** Archive-internal path of the image file. */
  file: string;
}

export interface PackManifestStickerPack {
  /** Free text ≤32 chars — informational for humans, matched by exact name on import. */
  name: string;
  stickers: PackManifestEntry[];
}

/** The manifest's informational kind — which shelf the archive was exported
 *  from. "expressions" (both catalogs) is no longer produced but stays
 *  parseable: import is TOTAL whatever the kind says. */
export type PackManifestKind = "expressions" | "emojis" | "stickers" | "sticker-pack";

export interface PackManifest {
  /** Must equal PACK_FORMAT_VERSION; anything else rejects the whole archive. */
  formatVersion: number;
  kind: PackManifestKind;
  serverName: string;
  exportedAt: string;
  /** Empty in a per-pack export. */
  emojis: PackManifestEntry[];
  /** Empty when the server has no sticker packs. */
  packs: PackManifestStickerPack[];
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

/** The whitelisted extension of a file name tail, lowercased; null when the
 *  tail has no dot, ends on one, or the extension is not an allowed image. */
function extensionFromFileName(tail: string): string | null {
  const dotIndex = tail.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === tail.length - 1) {
    return null;
  }
  const extension = tail.slice(dotIndex + 1).toLowerCase();
  return (PACK_IMAGE_EXTENSIONS as readonly string[]).includes(extension) ? extension : null;
}

/** The original ASCII file name rides the tail of the object key
 *  ({@code custom-emojis/<uuid>/<name>.png}); an unresolvable or non-image
 *  extension yields null and the item is skipped at export. */
export function extensionFromKey(key: string): string | null {
  return extensionFromFileName(key.split("/").pop() ?? "");
}

/** The extension of an archive-internal entry path ({@code emojis/cat.png}). */
function extensionFromEntryPath(path: string): string | null {
  return extensionFromFileName(path.split("/").pop() ?? "");
}

export function emojiEntryPath(name: string, extension: string): string {
  return `emojis/${name}.${extension}`;
}

export function stickerEntryPath(packIndex: number, name: string, extension: string): string {
  return `stickers/${String(packIndex).padStart(2, "0")}/${name}.${extension}`;
}

/** image/png, image/gif, image/webp — the extension IS the sub-type for the whole whitelist. */
export function contentTypeForExtension(extension: string): string {
  return `image/${extension}`;
}

/** An OS-safe base name for the downloaded archive file: strips path/Windows
 *  forbidden characters and control/format code points, collapses whitespace,
 *  trims edges and trailing dots, caps length; an empty result falls back to
 *  "pack". (\p{C} covers the whole control block without writing NUL escapes
 *  into the source — a literal escape there collapses to a real byte.) */
export function sanitizeFileBaseName(raw: string): string {
  const cleaned = raw
    .replace(/[\p{C}\\/:*?"<>|]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  return cleaned.length > 0 ? cleaned : "pack";
}

// ---------------------------------------------------------------------------
// Export side: entry resolution + manifest assembly
// ---------------------------------------------------------------------------

/** The manifest entry for an emoji; null when the key's extension cannot be
 *  resolved to an allowed image type (the item is reported unavailable). */
export function emojiExportEntry(item: { name: string; key: string }): PackManifestEntry | null {
  const extension = extensionFromKey(item.key);
  return extension === null ? null : { name: item.name, file: emojiEntryPath(item.name, extension) };
}

/** The manifest entry for a sticker of pack {@code packIndex} (null = unresolvable extension). */
export function stickerExportEntry(packIndex: number, item: { name: string; key: string }): PackManifestEntry | null {
  const extension = extensionFromKey(item.key);
  return extension === null ? null : { name: item.name, file: stickerEntryPath(packIndex, item.name, extension) };
}

/** Assembles the manifest verbatim — a pure function, the caller supplies
 *  serverName/exportedAt (Date stays out so tests stay deterministic). */
export function buildPackManifest(input: {
  serverName: string;
  exportedAt: string;
  kind: PackManifestKind;
  emojis: readonly PackManifestEntry[];
  packs: readonly { name: string; stickers: readonly PackManifestEntry[] }[];
}): PackManifest {
  return {
    formatVersion: PACK_FORMAT_VERSION,
    kind: input.kind,
    serverName: input.serverName,
    exportedAt: input.exportedAt,
    emojis: input.emojis.map((entry) => ({ ...entry })),
    packs: input.packs.map((pack) => ({ name: pack.name, stickers: pack.stickers.map((entry) => ({ ...entry })) })),
  };
}

// ---------------------------------------------------------------------------
// ZIP wrappers (the ONLY fflate import site)
// ---------------------------------------------------------------------------

/** Packs the files into a ZIP at compression level 0 (STORE): the content is
 *  png/gif/webp — already compressed — so zipping is a memcpy plus headers. */
export function buildZipArchive(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, bytes] of files) {
    entries[path] = bytes;
  }
  return zipSync(entries, { level: 0 });
}

export type PackParseResult =
  | { ok: true; manifest: PackManifest; files: ReadonlyMap<string, Uint8Array> }
  | { ok: false; reason: string };

/** Archive-level ladder — every failure is terminal (nothing is imported):
 *  unzip → pack.json present → JSON parses → shape check → format version.
 *  Junk entries outside the pack.json / emojis / stickers trees are never extracted. */
export function parsePackArchive(bytes: Uint8Array): PackParseResult {
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes, {
      filter: (file) =>
        file.name === PACK_MANIFEST_PATH || file.name.startsWith("emojis/") || file.name.startsWith("stickers/"),
    });
  } catch {
    return { ok: false, reason: "The file is not a valid expression pack archive." };
  }
  const manifestBytes = extracted[PACK_MANIFEST_PATH];
  if (manifestBytes === undefined) {
    return { ok: false, reason: "The archive has no pack.json manifest." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(manifestBytes));
  } catch {
    return { ok: false, reason: "The pack.json manifest is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "The pack.json manifest has an unexpected shape." };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.formatVersion !== "number") {
    return { ok: false, reason: "The pack.json manifest has no format version." };
  }
  if (record.formatVersion !== PACK_FORMAT_VERSION) {
    return { ok: false, reason: `Unsupported pack format version ${String(record.formatVersion)}.` };
  }
  const manifest = coercePackManifest(record);
  if (manifest === null) {
    return { ok: false, reason: "The pack.json manifest has an unexpected shape." };
  }
  const files = new Map<string, Uint8Array>();
  for (const [path, fileBytes] of Object.entries(extracted)) {
    if (path !== PACK_MANIFEST_PATH) {
      files.set(path, fileBytes);
    }
  }
  return { ok: true, manifest, files };
}

/** Narrows an already-version-checked record into a PackManifest; unknown
 *  EXTRA fields are tolerated (forward-compatible additions), wrong shapes of
 *  the known fields are not. */
const PACK_MANIFEST_KINDS: readonly PackManifestKind[] = ["expressions", "emojis", "stickers", "sticker-pack"];

function coercePackManifest(record: Record<string, unknown>): PackManifest | null {
  if (typeof record.kind !== "string" || !(PACK_MANIFEST_KINDS as readonly string[]).includes(record.kind)) {
    return null;
  }
  if (typeof record.serverName !== "string" || typeof record.exportedAt !== "string") {
    return null;
  }
  if (!isEntryList(record.emojis) || !isPackList(record.packs)) {
    return null;
  }
  return {
    formatVersion: PACK_FORMAT_VERSION,
    kind: record.kind as PackManifestKind,
    serverName: record.serverName,
    exportedAt: record.exportedAt,
    emojis: record.emojis,
    packs: record.packs,
  };
}

function isEntryList(value: unknown): value is PackManifestEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).name === "string" &&
        typeof (entry as Record<string, unknown>).file === "string",
    )
  );
}

function isPackList(value: unknown): value is PackManifestStickerPack[] {
  return (
    Array.isArray(value) &&
    value.every(
      (pack) =>
        typeof pack === "object" &&
        pack !== null &&
        typeof (pack as Record<string, unknown>).name === "string" &&
        isEntryList((pack as Record<string, unknown>).stickers),
    )
  );
}

// ---------------------------------------------------------------------------
// Import planner
// ---------------------------------------------------------------------------

export type ImportDecision =
  | { kind: "import"; name: string; file: string; contentType: string }
  | { kind: "skip-name-exists"; name: string }
  | { kind: "skip-limit"; name: string }
  | { kind: "skip-invalid"; name: string; reason: string };

export interface ImportPackPlan {
  manifestPack: PackManifestStickerPack;
  /** existing = merge into a pack that already exists by exact name; create = a new pack. */
  resolution: "existing" | "create";
  /** Sticker-name-scoped decisions in manifest order. */
  decisions: ImportDecision[];
}

export interface SkippedPack {
  name: string;
  reason: "pack-limit" | "invalid-name";
  /** How many stickers died with the pack — feeds the report tallies. */
  stickerCount: number;
}

export interface ImportPlan {
  emojiDecisions: ImportDecision[];
  packPlans: ImportPackPlan[];
  skippedPacks: SkippedPack[];
}

/** The catalog snapshot the planner runs against (one snapshot of both stores). */
export interface ImportCatalogState {
  emojiCount: number;
  emojiNames: ReadonlySet<string>;
  stickerTotal: number;
  /** Exact names of the existing packs (already server-trimmed). */
  packNames: ReadonlySet<string>;
  /** Per existing pack (by name): its sticker names — stickers collide per-pack only. */
  packStickerNames: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Pre-computes every item's fate against the current catalogs so the run
 *  itself is a straight loop. Sticker packs: an exact (trimmed) name match
 *  MERGES into the existing pack; a pack that must be created but hits the
 *  20-pack cap (or has an invalid name) is skipped whole. Manifest packs
 *  sharing a name merge into ONE plan. Emoji and sticker names are
 *  independent namespaces — a same-named pair does not collide. */
export function planPackImport(
  manifest: PackManifest,
  files: ReadonlyMap<string, Uint8Array>,
  current: ImportCatalogState,
): ImportPlan {
  const emojiDecisions = planEmojiEntries(manifest.emojis, files, current);
  const packPlans: ImportPackPlan[] = [];
  const skippedPacks: SkippedPack[] = [];
  const plansByName = new Map<string, ImportPackPlan>();
  const seenNamesByPlan = new Map<ImportPackPlan, Set<string>>();
  const skippedByName = new Map<string, SkippedPack>();
  // The 200-sticker cap spans ALL packs — one running counter, mutated by the chunks.
  const stickersToImport = { count: 0 };
  let packsToCreate = 0;

  for (const manifestPack of manifest.packs) {
    const trimmedName = manifestPack.name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 32) {
      mergeSkippedPack(skippedPacks, skippedByName, {
        name: manifestPack.name,
        reason: "invalid-name",
        stickerCount: manifestPack.stickers.length,
      });
      continue;
    }
    const mergeTarget = plansByName.get(trimmedName);
    if (mergeTarget !== undefined) {
      const seenNames = seenNamesByPlan.get(mergeTarget) ?? new Set<string>();
      const chunk = planStickerChunk(manifestPack.stickers, files, current, mergeTarget, seenNames, stickersToImport);
      mergeTarget.manifestPack.stickers.push(...manifestPack.stickers);
      mergeTarget.decisions.push(...chunk);
      seenNamesByPlan.set(mergeTarget, seenNames);
      continue;
    }
    const isExisting = current.packNames.has(trimmedName);
    if (!isExisting && current.packNames.size + packsToCreate >= STICKER_PACK_CAP) {
      mergeSkippedPack(skippedPacks, skippedByName, {
        name: trimmedName,
        reason: "pack-limit",
        stickerCount: manifestPack.stickers.length,
      });
      continue;
    }
    if (!isExisting) {
      packsToCreate += 1;
    }
    const plan: ImportPackPlan = {
      manifestPack: { name: trimmedName, stickers: [...manifestPack.stickers] },
      resolution: isExisting ? "existing" : "create",
      decisions: [],
    };
    // One shared seen-set per plan: the chunk fills it, merged chunks continue it.
    const seenNames = new Set<string>();
    plan.decisions = planStickerChunk(plan.manifestPack.stickers, files, current, plan, seenNames, stickersToImport);
    plansByName.set(trimmedName, plan);
    seenNamesByPlan.set(plan, seenNames);
    packPlans.push(plan);
  }
  return { emojiDecisions, packPlans, skippedPacks };
}

function planEmojiEntries(
  entries: readonly PackManifestEntry[],
  files: ReadonlyMap<string, Uint8Array>,
  current: ImportCatalogState,
): ImportDecision[] {
  const decisions: ImportDecision[] = [];
  const seenNames = new Set<string>();
  let imported = 0;
  for (const entry of entries) {
    const validation = validateEntry(entry, files, seenNames);
    if (!validation.ok) {
      decisions.push(validation.decision);
      continue;
    }
    if (current.emojiNames.has(entry.name)) {
      decisions.push({ kind: "skip-name-exists", name: entry.name });
      continue;
    }
    if (current.emojiCount + imported >= EMOJI_CATALOG_CAP) {
      decisions.push({ kind: "skip-limit", name: entry.name });
      continue;
    }
    imported += 1;
    decisions.push({
      kind: "import",
      name: entry.name,
      file: entry.file,
      contentType: contentTypeForExtension(validation.extension),
    });
  }
  return decisions;
}

/** Plans one pack's sticker chunk: names collide per-pack (a name taken in
 *  ANOTHER pack still imports); the global 200-sticker cap rides the shared
 *  mutable counter so it holds across packs. */
function planStickerChunk(
  entries: readonly PackManifestEntry[],
  files: ReadonlyMap<string, Uint8Array>,
  current: ImportCatalogState,
  plan: ImportPackPlan,
  seenNames: Set<string>,
  stickersToImport: { count: number },
): ImportDecision[] {
  const targetNames =
    plan.resolution === "existing" ? current.packStickerNames.get(plan.manifestPack.name) : undefined;
  const decisions: ImportDecision[] = [];
  for (const entry of entries) {
    const validation = validateEntry(entry, files, seenNames);
    if (!validation.ok) {
      decisions.push(validation.decision);
      continue;
    }
    if (targetNames !== undefined && targetNames.has(entry.name)) {
      decisions.push({ kind: "skip-name-exists", name: entry.name });
      continue;
    }
    if (current.stickerTotal + stickersToImport.count >= STICKER_TOTAL_CAP) {
      decisions.push({ kind: "skip-limit", name: entry.name });
      continue;
    }
    stickersToImport.count += 1;
    decisions.push({
      kind: "import",
      name: entry.name,
      file: entry.file,
      contentType: contentTypeForExtension(validation.extension),
    });
  }
  return decisions;
}

/** The shared per-item ladder: name grammar → extension whitelist → the file
 *  is present in the archive → per-file size cap → duplicate name within the
 *  planned scope (the first entry wins). Passes add the name to seenNames and
 *  return the extension; failures return the ready skip decision. */
type EntryValidation = { ok: true; extension: string } | { ok: false; decision: ImportDecision };

function validateEntry(entry: PackManifestEntry, files: ReadonlyMap<string, Uint8Array>, seenNames: Set<string>): EntryValidation {
  if (!PACK_NAME_PATTERN.test(entry.name)) {
    return { ok: false, decision: { kind: "skip-invalid", name: entry.name, reason: "invalid name" } };
  }
  const extension = extensionFromEntryPath(entry.file);
  if (extension === null) {
    return { ok: false, decision: { kind: "skip-invalid", name: entry.name, reason: "unsupported file type" } };
  }
  const bytes = files.get(entry.file);
  if (bytes === undefined) {
    return { ok: false, decision: { kind: "skip-invalid", name: entry.name, reason: "missing file" } };
  }
  if (bytes.length > PACK_MAX_FILE_BYTES) {
    return { ok: false, decision: { kind: "skip-invalid", name: entry.name, reason: "file exceeds 1 MB" } };
  }
  if (seenNames.has(entry.name)) {
    return { ok: false, decision: { kind: "skip-invalid", name: entry.name, reason: "duplicate name in the pack" } };
  }
  seenNames.add(entry.name);
  return { ok: true, extension };
}

/** Same-name manifest packs that were both skipped pool their stickers into
 *  one SkippedPack row instead of double-counting. */
function mergeSkippedPack(skippedPacks: SkippedPack[], byName: Map<string, SkippedPack>, entry: SkippedPack): void {
  const existing = byName.get(entry.name.trim());
  if (existing !== undefined && existing.reason === entry.reason) {
    existing.stickerCount += entry.stickerCount;
    return;
  }
  byName.set(entry.name.trim(), entry);
  skippedPacks.push(entry);
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

export interface ImportReportCounts {
  imported: number;
  skippedNames: number;
  skippedLimits: number;
  invalid: number;
  failed: number;
}

export function emptyImportReportCounts(): ImportReportCounts {
  return { imported: 0, skippedNames: 0, skippedLimits: 0, invalid: 0, failed: 0 };
}

/** The starting tallies of a run: every PLANNED skip lands in its bucket
 *  (a whole skipped pack's stickers count too — pack-limit → limit,
 *  invalid-name → invalid); the import decisions stay at zero until the
 *  network ladder reports their outcomes. */
export function tallyPlannedSkips(plan: ImportPlan): ImportReportCounts {
  const counts = emptyImportReportCounts();
  for (const decision of plan.emojiDecisions) {
    bumpDecision(counts, decision);
  }
  for (const packPlan of plan.packPlans) {
    for (const decision of packPlan.decisions) {
      bumpDecision(counts, decision);
    }
  }
  for (const skippedPack of plan.skippedPacks) {
    if (skippedPack.reason === "pack-limit") {
      counts.skippedLimits += skippedPack.stickerCount;
    } else {
      counts.invalid += skippedPack.stickerCount;
    }
  }
  return counts;
}

function bumpDecision(counts: ImportReportCounts, decision: ImportDecision): void {
  if (decision.kind === "skip-name-exists") {
    counts.skippedNames += 1;
  } else if (decision.kind === "skip-limit") {
    counts.skippedLimits += 1;
  } else if (decision.kind === "skip-invalid") {
    counts.invalid += 1;
  }
}

/** Merges one runtime outcome into the tallies: a server 409 (someone created
 *  the name between the snapshot and the attempt) counts as a name conflict,
 *  not a failure. */
export function tallyRuntimeOutcome(
  counts: ImportReportCounts,
  outcome: "imported" | "failed" | "conflict",
): ImportReportCounts {
  const next = { ...counts };
  if (outcome === "imported") {
    next.imported += 1;
  } else if (outcome === "failed") {
    next.failed += 1;
  } else {
    next.skippedNames += 1;
  }
  return next;
}

/** "Imported 38, skipped 3 (name exists), 2 skipped (limit), 1 invalid, 1 failed · created 2 packs" —
 *  only the non-zero segments render. */
export function formatImportReport(counts: ImportReportCounts, packsCreated: number): string {
  const segments: string[] = [`Imported ${counts.imported}`];
  if (counts.skippedNames > 0) {
    segments.push(`skipped ${counts.skippedNames} (name exists)`);
  }
  if (counts.skippedLimits > 0) {
    segments.push(`${counts.skippedLimits} skipped (limit)`);
  }
  if (counts.invalid > 0) {
    segments.push(`${counts.invalid} invalid`);
  }
  if (counts.failed > 0) {
    segments.push(`${counts.failed} failed`);
  }
  const suffix = packsCreated > 0 ? ` · created ${packsCreated} ${packsCreated === 1 ? "pack" : "packs"}` : "";
  return `${segments.join(", ")}${suffix}`;
}

export interface ExportReportInput {
  emojis: number;
  stickers: number;
  packs: number;
  unavailable: number;
  fileName: string;
}

/** "Exported 38 emojis and 45 stickers (3 packs) to cats.zip · 2 files were unavailable and skipped". */
export function formatExportReport(result: ExportReportInput): string {
  const packsPart = result.packs > 0 ? ` (${result.packs} ${result.packs === 1 ? "pack" : "packs"})` : "";
  let text =
    `Exported ${result.emojis} ${result.emojis === 1 ? "emoji" : "emojis"} and ` +
    `${result.stickers} ${result.stickers === 1 ? "sticker" : "stickers"}${packsPart} to ${result.fileName}`;
  if (result.unavailable > 0) {
    text += ` · ${result.unavailable} ${result.unavailable === 1 ? "file was" : "files were"} unavailable and skipped`;
  }
  return text;
}

/** Serializes the manifest for the archive — pretty-printed, humans will open it. */
export function manifestJsonBytes(manifest: PackManifest): Uint8Array {
  return strToU8(JSON.stringify(manifest, null, 2));
}
