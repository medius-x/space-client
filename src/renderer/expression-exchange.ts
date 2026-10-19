import { ApiError } from "../core/rest";
import { log } from "../logging";
import {
  buildPackManifest,
  buildZipArchive,
  emojiExportEntry,
  IMPORT_ARCHIVE_MAX_BYTES,
  manifestJsonBytes,
  parsePackArchive,
  planPackImport,
  sanitizeFileBaseName,
  stickerExportEntry,
  tallyPlannedSkips,
  tallyRuntimeOutcome,
  type ImportCatalogState,
  type ImportDecision,
  type ImportPlan,
  type ImportReportCounts,
  type PackManifest,
  type PackManifestEntry,
} from "../domain/logic/expression-pack";
import type { ConnectionSession } from "../domain/session/connection-session";
import type { StickerPack } from "../types";

/**
 * The expression-pack exchange orchestrator — the network half of
 * domain/logic/expression-pack.ts. Entirely client-side: export downloads
 * each file over a fresh presigned link (the Lightbox download primitive)
 * and zips them; import replays the EXISTING per-item upload ladder
 * (slot → PUT → create), so every server-side gate (name grammar, caps,
 * MANAGE_EMOJIS, catalog pings) applies exactly as it does to a manual
 * upload. No cancel: a run is bounded by the catalog caps and every item
 * is caught individually — closing the settings pane lets it finish in the
 * background (setState on an unmounted component is a no-op).
 */

export interface ExchangeProgress {
  done: number;
  total: number;
  label: string;
}

type ProgressSink = (progress: ExchangeProgress) => void;

/** The logger takes a flat message — fold the thrown value into it. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What an export covers — each settings page exports ITS OWN shelf
 *  (user decision): the Emoji page all emojis, the Stickers page all packs,
 *  a pack header that one pack. */
export type ExportScope = { kind: "emojis" } | { kind: "stickers" } | { kind: "pack"; pack: StickerPack };

export interface ExportExpressionResult {
  status: "saved" | "canceled" | "failed";
  filePath: string | null;
  error: string | null;
  /** Surviving items (unavailable ones excluded). */
  emojis: number;
  stickers: number;
  packs: number;
  unavailable: number;
  fileName: string;
}

/** A resolved manifest entry plus the object key its bytes come from. */
interface ExportRow {
  entry: PackManifestEntry;
  key: string;
}

export async function exportExpressionPack(
  session: ConnectionSession,
  scope: ExportScope,
  serverName: string,
  onProgress?: ProgressSink,
): Promise<ExportExpressionResult> {
  const emojiState = session.emojiStore.getSnapshot();
  const stickerState = session.stickerStore.getSnapshot();
  const scopeSuffix =
    scope.kind === "emojis" ? "-emojis" : scope.kind === "stickers" ? "-stickers" : `-${sanitizeFileBaseName(scope.pack.name)}`;
  const baseName = `${sanitizeFileBaseName(serverName)}${scopeSuffix}`;
  const fileName = `${baseName}.zip`;
  const emptyOutcome = (status: ExportExpressionResult["status"], error: string | null): ExportExpressionResult => ({
    status,
    filePath: null,
    error,
    emojis: 0,
    stickers: 0,
    packs: 0,
    unavailable: 0,
    fileName,
  });

  let unavailable = 0;
  const emojiRows: ExportRow[] = [];
  if (scope.kind === "emojis") {
    for (const emoji of emojiState.emojis) {
      const entry = emojiExportEntry(emoji);
      if (entry === null) {
        // the key's tail carries no allowed image extension — nothing to download
        unavailable += 1;
        continue;
      }
      emojiRows.push({ entry, key: emoji.key });
    }
  }
  const packsInScope = scope.kind === "stickers" ? stickerState.packs : scope.kind === "pack" ? [scope.pack] : [];
  const packRows: { name: string; rows: ExportRow[] }[] = [];
  for (const pack of packsInScope) {
    const rows: ExportRow[] = [];
    for (const sticker of pack.stickers) {
      const entry = stickerExportEntry(packRows.length, sticker);
      if (entry === null) {
        unavailable += 1;
        continue;
      }
      rows.push({ entry, key: sticker.key });
    }
    packRows.push({ name: pack.name, rows });
  }
  const allRows = [...emojiRows, ...packRows.flatMap((pack) => pack.rows)];

  try {
    const files = new Map<string, Uint8Array>();
    let done = 0;
    for (const row of allRows) {
      try {
        const url = await session.rest.freshAttachmentLink(row.key);
        if (url === null) {
          // the object is gone (deleted between the snapshot and the attempt)
          unavailable += 1;
        } else {
          files.set(row.entry.file, new Uint8Array(await session.rest.downloadBytes(url)));
        }
      } catch (error) {
        unavailable += 1;
        log.warn("export", `pack export: downloading ${row.entry.name} failed: ${errorText(error)}`);
      }
      done += 1;
      onProgress?.({ done, total: allRows.length, label: "Exporting" });
    }

    // The manifest carries only SURVIVING entries — a pack whose every file
    // died is dropped entirely (importing it would create an empty pack).
    const manifest = buildPackManifest({
      serverName,
      exportedAt: new Date().toISOString(),
      kind: scope.kind === "emojis" ? "emojis" : scope.kind === "stickers" ? "stickers" : "sticker-pack",
      emojis: emojiRows.filter((row) => files.has(row.entry.file)).map((row) => row.entry),
      packs: packRows
        .map((pack) => ({ name: pack.name, stickers: pack.rows.filter((row) => files.has(row.entry.file)).map((row) => row.entry) }))
        .filter((pack) => pack.stickers.length > 0),
    });
    const stickers = manifest.packs.reduce((sum, pack) => sum + pack.stickers.length, 0);
    files.set("pack.json", manifestJsonBytes(manifest));

    const savedPath = await window.spaceMedia?.saveFile(fileName, buildZipArchive(files));
    if (savedPath === undefined || savedPath === null) {
      // No save dialog anymore (the downloads-folder round, 2026-10-19): null
      // is a WRITE failure — the archive bytes are lost, say so honestly.
      return { status: "failed", filePath: null, error: "The archive could not be written to the downloads folder.", emojis: manifest.emojis.length, stickers, packs: manifest.packs.length, unavailable, fileName };
    }
    return {
      status: "saved",
      filePath: typeof savedPath === "string" ? savedPath : null,
      error: null,
      emojis: manifest.emojis.length,
      stickers,
      packs: manifest.packs.length,
      unavailable,
      fileName,
    };
  } catch (error) {
    log.warn("export", `pack export failed: ${errorText(error)}`);
    return emptyOutcome("failed", "Export failed — see the log for details.");
  }
}

export interface ImportExpressionResult {
  /** Import outcome tallies — the report sentence is built by the caller. */
  counts: ImportReportCounts;
  packsCreated: number;
}

/** A validated archive, split for the preview flow: read once, shown to the
 *  user (who may drop items), then imported from the possibly-filtered copy. */
export interface ParsedPackArchive {
  manifest: PackManifest;
  files: ReadonlyMap<string, Uint8Array>;
}

export type ReadPackArchiveResult = { ok: true; archive: ParsedPackArchive } | { ok: false; error: string };

/** One snapshot of both catalog stores, the planner's input — shared by the
 *  import run and the preview modal so they see the same world. */
export function catalogSnapshotOf(session: ConnectionSession): ImportCatalogState {
  const emojiState = session.emojiStore.getSnapshot();
  const stickerState = session.stickerStore.getSnapshot();
  return {
    emojiCount: emojiState.emojis.length,
    emojiNames: emojiState.names,
    stickerTotal: stickerState.totalStickers,
    packNames: new Set(stickerState.packs.map((pack) => pack.name)),
    packStickerNames: new Map(
      stickerState.packs.map((pack) => [pack.name, new Set(pack.stickers.map((sticker) => sticker.name))]),
    ),
  };
}

/** Size gate + parse — no catalog snapshots, nothing imported yet. */
export async function readPackArchive(file: File): Promise<ReadPackArchiveResult> {
  if (file.size > IMPORT_ARCHIVE_MAX_BYTES) {
    return { ok: false, error: "The archive is larger than 256 MB." };
  }
  const parsed = parsePackArchive(new Uint8Array(await file.arrayBuffer()));
  if (!parsed.ok) {
    return { ok: false, error: parsed.reason };
  }
  return { ok: true, archive: { manifest: parsed.manifest, files: parsed.files } };
}

export async function importPackArchive(
  session: ConnectionSession,
  archive: ParsedPackArchive,
  onProgress?: ProgressSink,
): Promise<ImportExpressionResult> {
  const current = catalogSnapshotOf(session);
  const plan = planPackImport(archive.manifest, archive.files, current);
  let counts = tallyPlannedSkips(plan);
  let packsCreated = 0;
  const totalImports = countImports(plan);
  let done = 0;

  /** One item through the ladder; a server 409 (the name appeared between the
   *  snapshot and the attempt) counts as a conflict. An abandoned upload slot
   *  (bytes PUT, create rejected) is reclaimed by the server's nightly GC. */
  const runItem = async (itemName: string, upload: () => Promise<void>): Promise<"imported" | "failed" | "conflict"> => {
    try {
      await upload();
      return "imported";
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        return "conflict";
      }
      log.warn("import", `pack import: item ${itemName} failed: ${errorText(error)}`);
      return "failed";
    }
  };
  const uploadEntry = async (decision: ImportDecision & { kind: "import" }, mintSlot: (fileName: string) => Promise<{ key: string; uploadUrl: string }>, commit: (fileKey: string) => Promise<unknown>): Promise<void> => {
    const slot = await mintSlot(decision.file.split("/").pop() ?? `${decision.name}.png`);
    const entryBytes = archive.files.get(decision.file);
    if (entryBytes === undefined) {
      return; // the planner guaranteed presence — unreachable, nothing to commit
    }
    await session.rest.uploadBytes(slot.uploadUrl, entryBytes.slice().buffer as ArrayBuffer, decision.contentType);
    await commit(slot.key);
  };
  const step = (outcome: "imported" | "failed" | "conflict"): void => {
    counts = tallyRuntimeOutcome(counts, outcome);
    done += 1;
    onProgress?.({ done, total: totalImports, label: "Importing" });
  };

  for (const decision of plan.emojiDecisions) {
    if (decision.kind !== "import") {
      continue;
    }
    const outcome = await runItem(decision.name, () =>
      uploadEntry(
        decision,
        (uploadFileName) => session.rest.requestEmojiUploadSlot(uploadFileName),
        (fileKey) => session.rest.createEmoji({ name: decision.name, fileKey }),
      ),
    );
    step(outcome);
  }

  for (const packPlan of plan.packPlans) {
    let packId: number | null = null;
    if (packPlan.resolution === "existing") {
      packId = session.stickerStore.getSnapshot().packs.find((pack) => pack.name === packPlan.manifestPack.name)?.id ?? null;
    }
    if (packId === null) {
      try {
        const created = await session.rest.createStickerPack(packPlan.manifestPack.name);
        packId = created.id;
        packsCreated += 1;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          // someone created the pack since the snapshot — merge into it
          const freshCatalog = await session.rest.getStickerPacks();
          packId = freshCatalog?.find((pack) => pack.name === packPlan.manifestPack.name)?.id ?? null;
        }
        if (packId === null) {
          log.warn("import", `pack import: creating pack "${packPlan.manifestPack.name}" failed: ${errorText(error)}`);
          // the pack's planned imports die with it — convert them to limit skips
          counts = { ...counts, skippedLimits: counts.skippedLimits + packPlan.decisions.filter((decision) => decision.kind === "import").length };
          continue;
        }
      }
    }
    const resolvedPackId: number = packId;
    for (const decision of packPlan.decisions) {
      if (decision.kind !== "import") {
        continue;
      }
      const outcome = await runItem(decision.name, () =>
        uploadEntry(
          decision,
          (uploadFileName) => session.rest.requestStickerUploadSlot(uploadFileName),
          (fileKey) => session.rest.createSticker({ name: decision.name, packId: resolvedPackId, fileKey }),
        ),
      );
      step(outcome);
    }
  }

  session.refreshEmojis();
  session.refreshStickers();
  return { counts, packsCreated };
}

function countImports(plan: ImportPlan): number {
  const stickerImports = plan.packPlans.reduce(
    (sum, packPlan) => sum + packPlan.decisions.filter((decision) => decision.kind === "import").length,
    0,
  );
  return plan.emojiDecisions.filter((decision) => decision.kind === "import").length + stickerImports;
}
