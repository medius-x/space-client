/**
 * The learned-dimensions cache for LEGACY attachments (rows sent before the
 * wire carried width/height, 2026-09-25): the first decode of an image or a
 * video preview records the media's intrinsic size (for video previews the
 * aspect is what matters — the preview JPEG shares the frame's aspect), and
 * every later render of the same key reserves the exact layout box from the
 * cache instead of estimating. localStorage-backed, capped, best-effort — a
 * missing/unavailable storage simply degrades to estimating.
 */
const STORAGE_KEY = "sp-media-dims";
const MAX_ENTRIES = 2000;

type DimMap = Record<string, [number, number]>;

let cache: DimMap | null = null;

function load(): DimMap {
  if (cache !== null) {
    return cache;
  }
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    const parsed = raw === null ? {} : JSON.parse(raw) as DimMap;
    cache = parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist(next: DimMap): void {
  cache = next;
  // Debounced: a channel opening with dozens of first-time decodes used to
  // stringify the whole (up to 2000-entry) map on EVERY onLoad — one write
  // per burst instead, the in-memory copy serves immediately either way.
  if (persistTimer === null) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
        }
      } catch {
        // quota/unavailable — the in-memory copy keeps serving this session
      }
    }, 500);
  }
}

/** The known intrinsic dimensions for a stable attachment/thumbnail key. */
export function learnedDims(key: string | null): { width: number; height: number } | null {
  if (key === null) {
    return null;
  }
  const entry = load()[key];
  if (entry === undefined || entry[0] <= 0 || entry[1] <= 0) {
    return null;
  }
  return { width: entry[0], height: entry[1] };
}

/** Record the measured dimensions (called from the decode's onLoad). */
export function rememberDims(key: string | null, width: number, height: number): void {
  if (key === null || width <= 0 || height <= 0) {
    return;
  }
  const current = load();
  if (current[key]?.[0] === width && current[key]?.[1] === height) {
    return; // unchanged — skip the write
  }
  const next = { ...current, [key]: [width, height] as [number, number] };
  const keys = Object.keys(next);
  if (keys.length > MAX_ENTRIES) {
    // Insertion-order trim (oldest first): the map is approximate anyway.
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete next[stale];
    }
  }
  persist(next);
}
