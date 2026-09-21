/**
 * WASAPI PROCESS-LOOPBACK system-audio capture (#485 spike), main process.
 *
 * Pure TypeScript over koffi — the oak-client JNA choreography transcribed
 * (its WasapiNative/WasapiProcessLoopbackCapturer are the byte-exact spec):
 * the VAD\Process_Loopback activation blob, a hand-rolled COM completion
 * handler (QI answers IUnknown + the handler IID + IAgileObject — without the
 * agility marker the activation fails E_ILLEGAL_METHOD_CALL), vtable-slot
 * calls, a fixed 48k/stereo/16-bit format under AUTOCONVERTPCM, and an
 * event-driven drain pumped by a 10 ms timer (no native thread needed —
 * koffi defers foreign-thread callbacks onto the JS loop, which the probe
 * proved live). EXCLUDE-target-PID mode = the whole desktop minus OUR process:
 * the OS-level replacement for the failed DSP subtraction.
 *
 * ELECTRON TRAP (live, first run): koffi.view() — an ArrayBuffer over NATIVE
 * memory — is FORBIDDEN under Electron (external buffers) and fatals the
 * process (napi_get_last_error_info). Plain Node allows it, which is why the
 * probe ran green. This module therefore touches memory ONLY through
 * koffi.encode/decode (typed single values), memcmp (GUID matching), and
 * msvcrt.memcpy declared with an _Out_ buffer (copies C into a JS Node Buffer
 * after the call — the documented output idiom).
 */

// Native module, loaded defensively: the app must run without it (koffi may be
// absent or unsupported) — the feature then reports unavailable. The main
// bundle is CJS, so a plain guarded require works; koffi is rollup-external.
declare const require: (id: string) => unknown;

type KoffiModule = {
  load: (library: string) => { func: (signature: string) => (...args: never[]) => unknown };
  proto: (signature: string) => unknown;
  pointer: (type: unknown) => unknown;
  register: (callback: (...args: unknown[]) => unknown, type: unknown) => bigint;
  alloc: (type: string, length: number) => unknown;
  address: (value: unknown) => bigint;
  as: (value: unknown, type: string) => unknown;
  call: (pointer: bigint, proto: unknown, ...args: unknown[]) => unknown;
  encode: (ref: unknown, offset: number, type: string, value: unknown) => void;
  decode: {
    int32: (ref: unknown) => number;
    uint32: (ref: unknown) => number;
    uchar: (ref: unknown, offset?: number) => number;
  };
};

let koffi: KoffiModule | null = null;
try {
  koffi = require("koffi") as KoffiModule;
} catch {
  koffi = null; // the feature is absent, the app is fine
}

import * as os from "node:os";
import { parseWindowHwnd } from "./window-liveness";

export interface SystemAudioFrame {
  /** Interleaved stereo 16-bit LE samples (variable chunk length). */
  pcm: Int16Array;
  /** AUDCLNT_BUFFERFLAGS_SILENT — the packet was a silent pad. */
  silent: boolean;
}

export type SystemAudioFrameSink = (frame: SystemAudioFrame) => void;

interface CaptureSession {
  stop(): void;
}

let activeSession: CaptureSession | null = null;

/** Windows 10 2004 (build 19041) — the first build with process loopback. */
export function isSystemAudioAvailable(): boolean {
  if (koffi === null || process.platform !== "win32") {
    return false;
  }
  const release = os.release();
  const build = Number.parseInt(release.split(".").pop() ?? "0", 10);
  return Number.isFinite(build) && build >= 19041;
}

// ---------------------------------------------------------------------------
// The koffi bindings — created lazily ONCE per process (the COM handler stub
// is never freed: the activation machinery may touch its vtable in windows we
// cannot observe — the oak/vlcj retired-stub rule).
// ---------------------------------------------------------------------------

const activationState = {
  fired: false,
  operationAddress: null as bigint | null,
};

/** An allocated native scratch cell + the write/decode toolkit (NO views). */
interface Cell {
  ref: unknown;
  address: bigint;
}

interface Bindings {
  activate(device: string, iidRef: unknown, propVariantRef: unknown, handlerRef: unknown, operationOut: unknown): number;
  memcpyOut(dest: unknown, sourceAddress: bigint, count: number): void;
  memcmpEqual(a: unknown, b: unknown): boolean;
  createEvent(): unknown;
  waitFor(event: unknown, milliseconds: number): number;
  closeHandle(event: unknown): void;
  currentPid(): number;
  /** HWND → owning process id (null = invalid handle / dead window). */
  windowPid(hwnd: bigint): number | null;
  coInitialize(): number;
  coUninitialize(): void;
  cell(byteCount: number): Cell;
  cellBytes(cellRef: Cell, bytes: Uint8Array): void;
  writeU16(cellRef: Cell, offset: number, value: number): void;
  writeU32(cellRef: Cell, offset: number, value: number): void;
  writePointer(cellRef: Cell, offset: number, value: bigint): void;
  readI32(cellRef: Cell): number;
  readU32(cellRef: Cell): number;
  readQwordAt(address: bigint): bigint;
  comCall(objectAddress: bigint, slotIndex: number, proto: unknown, ...args: unknown[]): number;
  iids: { audioClient: unknown; captureClient: unknown };
  activation: { handlerRef: Cell; operationAddress: () => bigint | null; fired: () => boolean };
  protos: {
    qi: unknown;
    release: unknown;
    getActivateResult: unknown;
    initialize: unknown;
    setEventHandle: unknown;
    getService: unknown;
    start: unknown;
    stop: unknown;
    getNextPacketSize: unknown;
    getBuffer: unknown;
    releaseBuffer: unknown;
  };
}

let bindings: Bindings | null = null;

function buildBindings(): Bindings | null {
  if (koffi === null) {
    return null;
  }
  const kernel32 = koffi.load("kernel32.dll");
  const ole32 = koffi.load("ole32.dll");
  const mmdevapi = koffi.load("mmdevapi.dll");
  const msvcrt = koffi.load("msvcrt.dll");
  const user32 = koffi.load("user32.dll");

  const funcOf = (library: { func: (signature: string) => (...args: never[]) => unknown }, signature: string) =>
    library.func(signature) as unknown as (...args: unknown[]) => unknown;
  const createEventW = funcOf(kernel32, "void *CreateEventW(void *attr, int manualReset, int initialState, const char16_t *name)");
  const waitForSingleObject = funcOf(kernel32, "uint32_t WaitForSingleObject(void *handle, uint32_t milliseconds)");
  const closeHandle = funcOf(kernel32, "int CloseHandle(void *handle)");
  const getCurrentProcessId = funcOf(kernel32, "uint32_t GetCurrentProcessId()");
  const getWindowThreadProcessId = funcOf(user32, "uint32_t GetWindowThreadProcessId(void *hwnd, uint32_t *pid)");
  const coInitializeEx = funcOf(ole32, "int CoInitializeEx(void *reserved, uint32_t coinit)");
  const coUninitializeFn = funcOf(ole32, "void CoUninitialize()");
  const activateAsync = funcOf(mmdevapi, "int ActivateAudioInterfaceAsync(const char16_t *device, void *riid, void *activationParams, void *handler, void **operationOut)");
  // The two memory tools that keep this module view-free:
  //   _Out_ dest — koffi copies C→JS into the Node Buffer argument after the call;
  //   memcmp — GUID equality without reading a single byte into JS.
  const memcpyOutFn = funcOf(msvcrt, "void *memcpy(_Out_ void *dest, const void *src, size_t count)");
  const memcmpFn = funcOf(msvcrt, "int memcmp(const void *left, const void *right, size_t count)");

  const cell = (byteCount: number): Cell => {
    const ref = koffi!.alloc("uint8_t", byteCount);
    return { ref, address: koffi!.address(ref) };
  };
  const writeBytes = (target: Cell, bytes: Uint8Array): void => {
    for (let index = 0; index < bytes.length; index += 1) {
      koffi!.encode(target.ref, index, "uint8_t", bytes[index]);
    }
  };
  const qwordBuffer = Buffer.allocUnsafe(8);
  const qwordView = new DataView(qwordBuffer.buffer, qwordBuffer.byteOffset, 8);
  const memcpyOut = (dest: unknown, sourceAddress: bigint, count: number): void => {
    memcpyOutFn(dest, koffi!.as(sourceAddress, "void *"), count);
  };
  const readQwordAt = (address: bigint): bigint => {
    memcpyOut(qwordBuffer, address, 8);
    return qwordView.getBigUint64(0, true);
  };

  // --- IIDs as native cells (memcmp targets and riid arguments) ---
  const guidCell = (literal: string): { cell: Cell; bytes: Uint8Array } => {
    const hex = literal.replace(/[{}-]/g, "");
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, Number.parseInt(hex.slice(0, 8), 16), true);
    view.setUint16(4, Number.parseInt(hex.slice(8, 12), 16), true);
    view.setUint16(6, Number.parseInt(hex.slice(12, 16), 16), true);
    for (let index = 0; index < 8; index += 1) {
      bytes[8 + index] = Number.parseInt(hex.slice(16 + index * 2, 18 + index * 2), 16);
    }
    const guidCellInner = cell(16);
    writeBytes(guidCellInner, bytes);
    return { cell: guidCellInner, bytes };
  };
  const iidUnknown = guidCell("{00000000-0000-0000-C000-000000000046}");
  const iidHandler = guidCell("{41D949AB-9862-444A-80F6-C261334DA5EB}");
  const iidAgile = guidCell("{94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}");
  const iidAudioClient = guidCell("{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}");
  const iidCaptureClient = guidCell("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}");

  // --- the hand-rolled COM handler (built ONCE, retired forever) ---
  const queryInterfaceProto = koffi.proto("int32_t QueryInterface(void *self, void *riid, void **ppvObject)");
  const addRefProto = koffi.proto("uint32_t AddRef(void *self)");
  const releaseProto = koffi.proto("uint32_t Release(void *self)");
  const activateCompletedProto = koffi.proto("int32_t ActivateCompleted(void *self, void *operation)");
  const handlerObject = cell(8); // [0] = vtable pointer
  const handlerVtable = cell(8 * 4);
  const encodePointer = (target: Cell, offset: number, value: bigint): void => {
    koffi!.encode(target.ref, offset, "void *", value);
  };
  const queryInterface = koffi.register((self: unknown, riid: unknown, ppvObject: unknown) => {
    try {
      if (memcmpFn(riid, iidUnknown.cell.ref, 16) === 0
        || memcmpFn(riid, iidHandler.cell.ref, 16) === 0
        || memcmpFn(riid, iidAgile.cell.ref, 16) === 0) {
        koffi!.encode(ppvObject, 0, "void *", koffi!.address(self));
        return 0;
      }
      return 0x80004002 | 0;
    } catch {
      return 0x80004002 | 0; // a throw across the COM boundary kills the process
    }
  }, koffi.pointer(queryInterfaceProto));
  const addRef = koffi.register(() => 1, koffi.pointer(addRefProto));
  const release = koffi.register(() => 1, koffi.pointer(releaseProto));
  const activateCompleted = koffi.register((_self: unknown, operation: unknown) => {
    try {
      activationState.operationAddress = koffi!.address(operation);
      activationState.fired = true;
      return 0;
    } catch {
      return 0x80004002 | 0;
    }
  }, koffi.pointer(activateCompletedProto));
  encodePointer(handlerVtable, 0, queryInterface);
  encodePointer(handlerVtable, 8, addRef);
  encodePointer(handlerVtable, 16, release);
  encodePointer(handlerVtable, 24, activateCompleted);
  encodePointer(handlerObject, 0, handlerVtable.address);

  const comCall = (objectAddress: bigint, slotIndex: number, proto: unknown, ...args: unknown[]): number =>
    koffi!.call(readQwordAt(readQwordAt(objectAddress) + BigInt(slotIndex * 8)), proto, koffi!.as(objectAddress, "void *"), ...args) as number;

  return {
    activate: (device, iidRef, propVariantRef, handlerRef, operationOut) => activateAsync(device, iidRef, propVariantRef, handlerRef, operationOut) as number,
    memcpyOut,
    memcmpEqual: (a, b) => memcmpFn(a, b, 16) === 0,
    createEvent: () => createEventW(null, 0, 0, null),
    waitFor: (event, milliseconds) => waitForSingleObject(event, milliseconds) as number,
    closeHandle: (event) => void closeHandle(event),
    currentPid: () => getCurrentProcessId() as number,
    windowPid: (hwnd) => {
      const pidOut = cell(4);
      const threadId = getWindowThreadProcessId(koffi!.as(hwnd, "void *"), pidOut.ref) as number;
      if (threadId === 0) {
        return null; // not a window anymore
      }
      const pid = koffi!.decode.uint32(pidOut.ref);
      return pid > 0 ? pid : null;
    },
    coInitialize: () => coInitializeEx(null, 0) as number,
    coUninitialize: () => coUninitializeFn(),
    cell,
    cellBytes: writeBytes,
    writeU16: (target, offset, value) => koffi!.encode(target.ref, offset, "uint16_t", value),
    writeU32: (target, offset, value) => koffi!.encode(target.ref, offset, "uint32_t", value),
    writePointer: encodePointer,
    readI32: (target) => koffi!.decode.int32(target.ref),
    readU32: (target) => koffi!.decode.uint32(target.ref),
    readQwordAt,
    comCall,
    iids: { audioClient: iidAudioClient.cell.ref, captureClient: iidCaptureClient.cell.ref },
    activation: { handlerRef: handlerObject, operationAddress: () => activationState.operationAddress, fired: () => activationState.fired },
    protos: {
      qi: koffi.proto("int32_t UnknownQI(void *self, void *riid, void **ppvObject)"),
      release: koffi.proto("uint32_t UnknownRelease(void *self)"),
      getActivateResult: koffi.proto("int32_t GetActivateResult(void *self, int32_t *hr, void **unknown)"),
      initialize: koffi.proto("int32_t ClientInitialize(void *self, int32_t shareMode, uint32_t flags, int64_t duration, int64_t periodicity, void *format, void *guid)"),
      setEventHandle: koffi.proto("int32_t ClientSetEventHandle(void *self, void *event)"),
      getService: koffi.proto("int32_t ClientGetService(void *self, void *riid, void **service)"),
      start: koffi.proto("int32_t ClientStart(void *self)"),
      stop: koffi.proto("int32_t ClientStop(void *self)"),
      getNextPacketSize: koffi.proto("int32_t CaptureGetNextPacketSize(void *self, uint32_t *frames)"),
      getBuffer: koffi.proto("int32_t CaptureGetBuffer(void *self, void **data, uint32_t *frames, uint32_t *flags, uint64_t *position, uint64_t *qpcPosition)"),
      releaseBuffer: koffi.proto("int32_t CaptureReleaseBuffer(void *self, uint32_t frames)"),
    },
  };
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface SystemAudioStartOptions {
  /** A desktopCapturer WINDOW source id ("window:HWND:…", decimal HWND) —
   *  flips the capture to INCLUDE mode: only that window's process tree is
   *  captured (per-app audio, oak parity). Absent = whole desktop minus OUR
   *  process tree (exclude-self). */
  sourceId?: string;
}

export interface SystemAudioStartResult {
  started: boolean;
  mode: "exclude-self" | "include";
  /** The captured process tree's pid (ours in exclude-self mode; 0 on failure). */
  pid: number;
}

/**
 * Starts the process-loopback capture — exclude-self (the whole desktop minus
 * OUR process) by default, or a single application's process tree when a
 * window source id is given. Resolves once PCM is flowing (activation is
 * asynchronous); `started:false` on any failure (the caller degrades
 * gracefully). One capture at a time. `onEnded` fires when a RUNNING session
 * tears itself down (a dead WASAPI pipeline must never take main down — the
 * drain catches and stops; the caller deserves to know).
 */
export async function startSystemAudio(
  onFrame: SystemAudioFrameSink,
  onEnded?: (reason: string) => void,
  options?: SystemAudioStartOptions,
): Promise<SystemAudioStartResult> {
  const requestedMode: "exclude-self" | "include" = options?.sourceId !== undefined ? "include" : "exclude-self";
  const failure = (): SystemAudioStartResult => ({ started: false, mode: requestedMode, pid: 0 });
  if (activeSession !== null) {
    return failure();
  }
  if (bindings === null) {
    bindings = buildBindings();
  }
  const lib = bindings;
  if (lib === null) {
    return failure();
  }
  try {
    // INCLUDE mode: resolve the window's HWND to the owning process tree
    // before touching COM.
    let targetPid: number | null = null;
    if (options?.sourceId !== undefined) {
      const hwnd = parseWindowHwnd(options.sourceId);
      targetPid = hwnd !== null ? lib.windowPid(BigInt(hwnd)) : null;
      if (targetPid === null) {
        return failure(); // dead window / malformed id — degrade to no audio
      }
    }
    lib.coInitialize();
    activationState.fired = false;
    activationState.operationAddress = null;

    // The activation blob: AUDIOCLIENT_ACTIVATION_PARAMS (12 B, PID first) in a VT_BLOB PROPVARIANT.
    const activationParams = lib.cell(12);
    lib.writeU32(activationParams, 0, 1); // AUDCLNT_ACTIVATION_TYPE_PROCESS_LOOPBACK
    lib.writeU32(activationParams, 4, targetPid ?? lib.currentPid());
    lib.writeU32(activationParams, 8, targetPid === null ? 1 : 0); // EXCLUDE our tree / INCLUDE the target tree
    const propVariant = lib.cell(24);
    lib.writeU16(propVariant, 0, 65); // VT_BLOB
    lib.writeU32(propVariant, 8, 12);
    lib.writePointer(propVariant, 16, activationParams.address);

    const operationOut = lib.cell(8);
    const hr = lib.activate("VAD\\Process_Loopback", lib.iids.audioClient, propVariant.ref, lib.activation.handlerRef.ref, operationOut.ref);
    if (hr !== 0) {
      lib.coUninitialize();
      return failure();
    }

    // koffi defers the foreign-thread completion onto the JS loop — breathe.
    const deadline = Date.now() + 3000;
    while (!lib.activation.fired() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const operationAddress = lib.activation.operationAddress();
    if (!lib.activation.fired() || operationAddress === null) {
      lib.coUninitialize();
      return failure();
    }

    const hrOut = lib.cell(4);
    const unknownOut = lib.cell(8);
    lib.comCall(operationAddress, 3, lib.protos.getActivateResult, hrOut.ref, unknownOut.ref);
    if (lib.readI32(hrOut) !== 0) {
      lib.comCall(operationAddress, 2, lib.protos.release);
      lib.coUninitialize();
      return failure();
    }
    const audioClientOut = lib.cell(8);
    lib.comCall(lib.readQwordAt(unknownOut.address), 0, lib.protos.qi, lib.iids.audioClient, audioClientOut.ref);
    const audioClientAddress = lib.readQwordAt(audioClientOut.address);

    // The fixed capture format (GetMixFormat is E_NOTIMPL on process loopback —
    // the caller declares it; AUTOCONVERTPCM converts the mix into it).
    const format = lib.cell(18);
    lib.writeU16(format, 0, 1);         // WAVE_FORMAT_PCM
    lib.writeU16(format, 2, 2);         // stereo
    lib.writeU32(format, 4, 48000);     // rate
    lib.writeU32(format, 8, 48000 * 4); // avg bytes
    lib.writeU16(format, 12, 4);        // block align
    lib.writeU16(format, 14, 16);       // bits

    const streamFlags = 0x00020000 | 0x00040000 | 0x80000000 | 0x08000000; // LOOPBACK | EVENTCALLBACK | AUTOCONVERT | SRC_DEFAULT
    if (lib.comCall(audioClientAddress, 3, lib.protos.initialize, 0, streamFlags, 0, 0, format.ref, null) !== 0) {
      lib.comCall(audioClientAddress, 2, lib.protos.release);
      lib.comCall(operationAddress, 2, lib.protos.release);
      lib.coUninitialize();
      return failure();
    }
    const bufferEvent = lib.createEvent();
    lib.comCall(audioClientAddress, 13, lib.protos.setEventHandle, bufferEvent);
    const captureOut = lib.cell(8);
    if (lib.comCall(audioClientAddress, 14, lib.protos.getService, lib.iids.captureClient, captureOut.ref) !== 0) {
      lib.closeHandle(bufferEvent);
      lib.comCall(audioClientAddress, 2, lib.protos.release);
      lib.comCall(operationAddress, 2, lib.protos.release);
      lib.coUninitialize();
      return failure();
    }
    const captureClientAddress = lib.readQwordAt(captureOut.address);
    if (lib.comCall(audioClientAddress, 10, lib.protos.start) !== 0) {
      lib.closeHandle(bufferEvent);
      lib.comCall(audioClientAddress, 2, lib.protos.release);
      lib.comCall(operationAddress, 2, lib.protos.release);
      lib.coUninitialize();
      return failure();
    }

    // The drain: pumped by a 10 ms timer (no native thread), packets batch per
    // tick. PCM leaves native memory through the _Out_ memcpy into a JS Buffer.
    const packetFrames = lib.cell(4);
    const dataOut = lib.cell(8);
    const framesOut = lib.cell(4);
    const flagsOut = lib.cell(4);
    const posOut = lib.cell(8);
    const qpcOut = lib.cell(8);
    let pcmBuffer = Buffer.allocUnsafe(4800 * 2); // grows to the largest packet
    let stopped = false;
    const drain = (): void => {
      if (stopped) {
        return;
      }
      try {
        lib.waitFor(bufferEvent, 0);
        for (;;) {
          lib.comCall(captureClientAddress, 5, lib.protos.getNextPacketSize, packetFrames.ref);
          if (lib.readU32(packetFrames) === 0) {
            break;
          }
          lib.comCall(captureClientAddress, 3, lib.protos.getBuffer, dataOut.ref, framesOut.ref, flagsOut.ref, posOut.ref, qpcOut.ref);
          const frames = lib.readU32(framesOut);
          const flags = lib.readU32(flagsOut);
          const silent = (flags & 0x2) !== 0;
          const sampleCount = frames * 2;
          const byteCount = sampleCount * 2;
          if (byteCount > pcmBuffer.length) {
            pcmBuffer = Buffer.allocUnsafe(byteCount);
          }
          const dataAddress = lib.readQwordAt(dataOut.address);
          if (silent || dataAddress === 0n) {
            pcmBuffer.fill(0, 0, byteCount);
          } else {
            lib.memcpyOut(pcmBuffer, dataAddress, byteCount);
          }
          onFrame({
            pcm: new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount),
            silent,
          });
          lib.comCall(captureClientAddress, 4, lib.protos.releaseBuffer, frames);
        }
      } catch (error) {
        stop(); // a dead capture must never take main down
        try {
          onEnded?.(String(error));
        } catch {
          // notification must never take main down either
        }
      }
    };
    const timer = setInterval(drain, 10);
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      try {
        lib.comCall(audioClientAddress, 11, lib.protos.stop);
        lib.comCall(captureClientAddress, 2, lib.protos.release);
        lib.comCall(audioClientAddress, 2, lib.protos.release);
        lib.comCall(operationAddress, 2, lib.protos.release);
        lib.closeHandle(bufferEvent);
        lib.coUninitialize();
      } catch {
        // teardown best effort
      }
    };
    activeSession = { stop };
    return { started: true, mode: requestedMode, pid: targetPid ?? lib.currentPid() };
  } catch {
    return failure();
  }
}

export function stopSystemAudio(): void {
  activeSession?.stop();
  activeSession = null;
}
