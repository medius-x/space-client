/**
 * The running-process snapshot (the roster activity auto-detect, 2026-11-11):
 * CreateToolhelp32Snapshot/Process32FirstW/NextW over koffi — the defensive-
 * load and view-free patterns of system-audio. The Task-Manager presentation
 * (user request 2026-11-11):
 *  - APPLICATIONS (a process owning a visible window) show the WINDOW TITLE
 *    (window-liveness's EnumWindows walk — minimized windows included, unlike
 *    the desktopCapturer layer it replaced, 2026-11-11),
 *    exactly the first column of Task Manager, plus the app ICON
 *    (app.getFileIcon over the exe path from QueryFullProcessImageNameW).
 *  - BACKGROUND processes show the bare exe name (Task Manager's own fallback
 *    for title-less processes) without icons.
 *
 * Everything is cached per exe NAME for the process lifetime (icons are disk
 * reads; a warm poll costs nothing), and the koffi bindings are a LAZY
 * SINGLETON (a named koffi.struct cannot be re-registered — the live
 * empty-picker lesson, 2026-11-11).
 *
 * Only names, the app/background class, window titles and icon data URLs
 * cross to the renderer (no pids, no paths).
 */
import { app, ipcMain } from "electron";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { visibleWindowTitlesByPid } from "./window-liveness";

// Native module, loaded defensively (the system-audio rule).
declare const require: (id: string) => unknown;

type KoffiModule = {
  load: (library: string) => { func: (signature: string) => (...args: never[]) => unknown };
  struct: (name: string, definition: Record<string, string>) => unknown;
  alloc: (type: string, length: number) => unknown;
  address: (value: unknown) => bigint;
  encode: (ref: unknown, offset: number, type: string, value: unknown) => void;
  sizeof: (type: unknown) => number;
  offsetof: (type: unknown, member: string) => number;
  decode: { string16: (address: bigint) => string; uint32: (address: bigint) => number };
};

let koffi: KoffiModule | null = null;
try {
  koffi = require("koffi") as KoffiModule;
} catch {
  koffi = null; // absent — the picker reads as unavailable
}

/** TH32CS_SNAPPROCESS — the process-list snapshot flavor. */
const TH32CS_SNAPPROCESS = 0x00000002;
/** PROCESS_QUERY_LIMITED_INFORMATION — the mildest read of another process. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const INVALID_HANDLE = -1n;
const MAX_PATH_W = 1024;

/** One picker entry: the exe name + the Task-Manager presentation. */
export interface ProcessNameEntry {
  name: string;
  /** True when some visible window belongs to this process (an "application"). */
  app: boolean;
  /** The window title (the FALLBACK label — a chat name in Telegram, not the app). */
  title: string | null;
  /** The exe's FileDescription — Task Manager's application column ("Telegram
   *  Desktop"); arrives via the describe pass (cached), null before/absent. */
  label: string | null;
  /** 16×16 app icon as a data URL (applications only; cached per exe name). */
  icon: string | null;
}

interface SnapshotBindings {
  entrySize: number;
  pidOffset: bigint;
  nameOffset: bigint;
  createSnapshot: (flags: number, pid: number) => bigint;
  processFirst: (snapshot: bigint, entry: unknown) => number;
  processNext: (snapshot: bigint, entry: unknown) => number;
  closeHandle: (handle: bigint) => number;
  openProcess: (access: number, inherit: number, pid: number) => bigint;
  queryImagePath: (handle: bigint, flags: number, buffer: unknown, sizeRef: unknown) => number;
}

let bindings: SnapshotBindings | null = null;
/** exe name → the polished presentation (FileDescription + icon), filled by the
 *  describe pass; a warm poll or picker open never re-reads what is in here. */
interface AppPresentation {
  label: string | null;
  icon: string | null;
}
const presentationCache = new Map<string, AppPresentation>();
/** In-flight describe pass — concurrent callers share one PowerShell round. */
let describeInFlight: Promise<Map<string, AppPresentation>> | null = null;

export function ensureBindings(): SnapshotBindings | null {
  if (bindings !== null) {
    return bindings;
  }
  if (koffi === null) {
    return null;
  }
  try {
    const kernel32 = koffi.load("kernel32.dll");
    const entryStruct = koffi.struct("OAK_PROCESSENTRY32W", {
      dwSize: "uint32_t",
      cntUsage: "uint32_t",
      th32ProcessID: "uint32_t",
      th32DefaultHeapID: "uintptr_t",
      th32ModuleID: "uint32_t",
      th32CntThreads: "uint32_t",
      th32ParentProcessID: "uint32_t",
      th32PriBase: "int32_t",
      dwFlags: "uint32_t",
      szExeFile: "wchar_t[260]",
    });
    bindings = {
      entrySize: koffi.sizeof(entryStruct),
      pidOffset: BigInt(koffi.offsetof(entryStruct, "th32ProcessID")),
      nameOffset: BigInt(koffi.offsetof(entryStruct, "szExeFile")),
      createSnapshot: kernel32.func("void *CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)") as unknown as (flags: number, pid: number) => bigint,
      processFirst: kernel32.func("int32_t Process32FirstW(void *snapshot, void *entry)") as unknown as (snapshot: bigint, entry: unknown) => number,
      processNext: kernel32.func("int32_t Process32NextW(void *snapshot, void *entry)") as unknown as (snapshot: bigint, entry: unknown) => number,
      closeHandle: kernel32.func("int CloseHandle(void *handle)") as unknown as (handle: bigint) => number,
      openProcess: kernel32.func("void *OpenProcess(uint32_t access, int inherit, uint32_t pid)") as unknown as (access: number, inherit: number, pid: number) => bigint,
      queryImagePath: kernel32.func("int32_t QueryFullProcessImageNameW(void *handle, uint32_t flags, _Out_ wchar_t *buffer, _Inout_ uint32_t *size)") as unknown as (handle: bigint, flags: number, buffer: unknown, sizeRef: unknown) => number,
    };
    return bindings;
  } catch {
    return null; // a malformed binding boot must never take the app down
  }
}

/** The toolhelp walk: pid → exe name (bindings must exist). */
function snapshotProcessNames(toolkits: SnapshotBindings): Map<number, string> | null {
  const snapshot = toolkits.createSnapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot === INVALID_HANDLE) {
    return null;
  }
  try {
    const koffiLoaded = koffi!;
    const pidToName = new Map<number, string>();
    const entry = koffiLoaded.alloc("uint8_t", toolkits.entrySize);
    koffiLoaded.encode(entry, 0, "uint32_t", toolkits.entrySize);
    const base = koffiLoaded.address(entry);
    const nameAddress = base + toolkits.nameOffset;
    const pidAddress = base + toolkits.pidOffset;
    let hasMore = toolkits.processFirst(snapshot, entry) !== 0;
    let guard = 0;
    while (hasMore && guard < 4096) {
      const exeName = path.basename(koffiLoaded.decode.string16(nameAddress));
      if (exeName.length > 0 && exeName.toLowerCase().endsWith(".exe")) {
        pidToName.set(koffiLoaded.decode.uint32(pidAddress), exeName.toLowerCase());
      }
      guard += 1;
      hasMore = toolkits.processNext(snapshot, entry) !== 0;
    }
    return pidToName;
  } catch {
    return null; // a poll must never take the app down
  } finally {
    toolkits.closeHandle(snapshot);
  }
}

/** The exe PATH of a process (for the icon and the Steam dossier), null when unreadable. */
export function processImagePath(toolkits: SnapshotBindings, pid: number): string | null {
  const koffiLoaded = koffi!;
  const handle = toolkits.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === INVALID_HANDLE || handle === 0n) {
    return null;
  }
  try {
    const sizeRef = Buffer.alloc(4);
    sizeRef.writeUInt32LE(MAX_PATH_W, 0);
    const buffer = Buffer.alloc(MAX_PATH_W * 2);
    if (toolkits.queryImagePath(handle, 0, buffer, sizeRef) === 0) {
      return null;
    }
    const length = sizeRef.readUInt32LE(0);
    return buffer.slice(0, length * 2).toString("utf16le");
  } catch {
    return null;
  } finally {
    toolkits.closeHandle(handle);
  }
}

export function installProcessSnapshotIpc(): void {
  ipcMain.handle("space-processes:names", async (): Promise<ProcessNameEntry[] | null> => {
    const toolkits = ensureBindings();
    if (toolkits === null) {
      return null;
    }
    const pidToName = snapshotProcessNames(toolkits);
    if (pidToName === null) {
      return null;
    }
    // The window layer: pid → (app class, the window title fallback). Our own
    // EnumWindows walk (window-liveness) — desktopCapturer DROPPED minimized
    // windows (the user report, 2026-11-11); EnumWindows keeps them (minimize
    // does not unset WS_VISIBLE) and the DWM-cloak check hides suspended UWP
    // remnants instead. Null = no window list — everyone reads as background.
    const pidToTitle = visibleWindowTitlesByPid() ?? new Map<number, string>();
    // pid per uncached app exe (for the describe pass), EXCLUDING cached ones:
    // a warm tick builds no paths at all. The Steam dossier (steam-games.ts) in
    // contrast may be asked about ANY app exe, so THIS tick's full app mapping
    // rides along in appPidsByName.
    const nameToPid = new Map<string, number>();
    const everyAppPid = new Map<string, number>();
    const apps: ProcessNameEntry[] = [];
    const background: ProcessNameEntry[] = [];
    const seen = new Set<string>();
    for (const [pid, name] of pidToName) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const title = pidToTitle.get(pid) ?? null;
      if (title !== null) {
        everyAppPid.set(name, pid);
        const cached = presentationCache.get(name);
        if (cached === undefined) {
          nameToPid.set(name, pid);
          apps.push({ name, app: true, title, label: null, icon: null });
        } else {
          apps.push({ name, app: true, title, label: cached.label, icon: cached.icon });
        }
      } else {
        background.push({ name, app: false, title: null, label: null, icon: null });
      }
    }
    lastAppPids = nameToPid; // the describe pass reuses THIS tick's pid mapping
    appPidsByExeName = everyAppPid;
    return [...apps.sort(byLabelTitleOrName), ...background.sort(byName)];
  });

  // The heavy half, called by the renderer when the picker is OPENED (never by
  // the 5 s detect tick): for every uncached app — the exe path (koffi), the
  // FileDescription (ONE PowerShell batch over all paths: Task Manager's
  // "Telegram Desktop"; the koffi version.dll/SHGetFileInfo routes misbehaved,
  // the two-strikes rule) and the icon (app.getFileIcon). Everything lands in
  // the presentation cache for the process lifetime; a concurrent caller joins
  // the in-flight pass.
  ipcMain.handle("space-processes:describeApps", async (): Promise<Record<string, AppPresentation> | null> => {
    const toolkits = ensureBindings();
    if (toolkits === null) {
      return null;
    }
    const pending = new Map(lastAppPids);
    for (const name of presentationCache.keys()) {
      pending.delete(name);
    }
    if (pending.size === 0) {
      return null; // everything already described — the renderer's list is final
    }
    if (describeInFlight !== null) {
      await describeInFlight;
      return Object.fromEntries(presentationCache);
    }
    describeInFlight = (async () => {
      const paths = new Map<string, string>(); // exe name → exe path
      for (const [name, pid] of pending) {
        const imagePath = processImagePath(toolkits, pid);
        if (imagePath !== null) {
          paths.set(name, imagePath);
        }
      }
      const labels = await fileDescriptions([...paths.values()]);
      for (const [name, imagePath] of paths) {
        let icon: string | null = null;
        try {
          const image = await app.getFileIcon(imagePath, { size: "small" });
          icon = image.isEmpty() ? null : image.toDataURL();
        } catch {
          icon = null;
        }
        presentationCache.set(name, { label: labels.get(imagePath.toLowerCase()) ?? null, icon });
      }
      return presentationCache;
    })();
    try {
      await describeInFlight;
    } finally {
      describeInFlight = null;
    }
    return Object.fromEntries(presentationCache);
  });
}

/** The last tick's app-exe → pid map, handed to the describe pass. */
let lastAppPids = new Map<string, number>();

/** The last tick's mapping of EVERY app exe to a pid (not just the uncached
 *  ones) — the steam-games dossier's entry door. Replaced wholesale each tick. */
let appPidsByExeName = new Map<string, number>();

/** The live app-exe → pid mapping of the most recent snapshot tick. */
export function appPidsByName(): Map<string, number> {
  return appPidsByExeName;
}

/**
 * FileDescription for many exe paths in ONE PowerShell child (the shell
 * mechanism after the koffi API strikes). The script rides -EncodedCommand
 * (base64 UTF-16LE — no argv quoting hell; paths are single-quoted inside
 * with '' doubling) and forces UTF-8 stdout so Russian descriptions survive.
 * Output: `path<TAB>description` lines; a missing description or a failed
 * child degrades to an empty map — the window title stays the label.
 */
function fileDescriptions(paths: string[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    if (paths.length === 0) {
      resolve(new Map());
      return;
    }
    const psArray = paths.map((exePath) => `'${exePath.replace(/'/g, "''")}'`).join(",");
    const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
      + "$list = @(" + psArray + "); "
      + "foreach ($p in $list) { $d = (Get-Item -LiteralPath $p -ErrorAction SilentlyContinue).VersionInfo.FileDescription; "
      + "Write-Output ($p + [char]9 + $d) }";
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve(new Map());
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(new Map()); // no PowerShell — titles stay
    });
    child.on("close", () => {
      clearTimeout(timer);
      const map = new Map<string, string>();
      const text = Buffer.concat(out).toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        const separator = line.indexOf("\t");
        if (separator > 0) {
          const description = line.slice(separator + 1).trim();
          if (description.length > 0) {
            map.set(line.slice(0, separator).trim().toLowerCase(), description);
          }
        }
      }
      resolve(map);
    });
  });
}

function byName(a: ProcessNameEntry, b: ProcessNameEntry): number {
  return a.name.localeCompare(b.name);
}

/** Applications sort by their PRESENTED label (FileDescription first, the
 *  window title as the fallback) — the way the picker shows them. */
function byLabelTitleOrName(a: ProcessNameEntry, b: ProcessNameEntry): number {
  return presentedLabel(a).localeCompare(presentedLabel(b));
}

function presentedLabel(entry: ProcessNameEntry): string {
  return entry.label ?? entry.title ?? entry.name;
}
