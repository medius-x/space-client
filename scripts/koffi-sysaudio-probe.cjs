// Phase-0 probe (#485): WASAPI process-loopback from pure Node via koffi —
// the oak-client JNA choreography transcribed to JS. Run with plain `node`.
// Stage 1: activation + the foreign-thread COM callback (the koffi verdict).
const koffi = require("koffi");

// --- Win32 bindings (x64: single calling convention) ---
const kernel32 = koffi.load("kernel32.dll");
const CreateEventW = kernel32.func("void *CreateEventW(void *attr, int manualReset, int initialState, const char16_t *name)");
const WaitForSingleObject = kernel32.func("uint32_t WaitForSingleObject(void *handle, uint32_t milliseconds)");
const CloseHandle = kernel32.func("int CloseHandle(void *handle)");
const GetCurrentProcessId = kernel32.func("uint32_t GetCurrentProcessId()");
const ole32 = koffi.load("ole32.dll");
const CoInitializeEx = ole32.func("int CoInitializeEx(void *reserved, uint32_t coinit)");
const CoUninitialize = ole32.func("void CoUninitialize()");
const mmdevapi = koffi.load("mmdevapi.dll");
const ActivateAudioInterfaceAsync = mmdevapi.func(
  "int ActivateAudioInterfaceAsync(const char16_t *device, void *riid, void *activationParams, void *handler, void **operationOut)",
);

const COINIT_MULTITHREADED = 0;
const DEVICE_PATH = "VAD\\Process_Loopback"; // UNDERSCORE (a space is a clean 0x80070002)
const ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
const LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1;
const VT_BLOB = 65;

// --- GUIDs (mmdeviceapi.idl, byte-exact per oak's WasapiNative) ---
function guidBytes(literal) {
  const hex = literal.replace(/[{}-]/g, "");
  const data1 = parseInt(hex.slice(0, 8), 16);
  const data2 = parseInt(hex.slice(8, 12), 16);
  const data3 = parseInt(hex.slice(12, 16), 16);
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(0, data1, true);
  new DataView(bytes.buffer).setUint16(4, data2, true);
  new DataView(bytes.buffer).setUint16(6, data3, true);
  for (let index = 0; index < 8; index += 1) {
    bytes[8 + index] = parseInt(hex.slice(16 + index * 2, 18 + index * 2), 16);
  }
  return bytes;
}
const IID_AUDIO_CLIENT = guidBytes("{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}");
const IID_UNKNOWN = guidBytes("{00000000-0000-0000-C000-000000000046}");
const IID_COMPLETION_HANDLER = guidBytes("{41D949AB-9862-444A-80F6-C261334DA5EB}");
const IID_AGILE_OBJECT = guidBytes("{94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}");

function bytesEqual(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

// --- memory helpers: allocate + raw byte access via ArrayBuffer views ---
function allocBytes(count) {
  const ref = koffi.alloc("uint8_t", count);
  return { ref, bytes: new Uint8Array(koffi.view(ref, count)), address: koffi.address(ref) };
}
function writePointerBytes(target, offset, addressBigint) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setBigUint64(offset, addressBigint, true);
}

// --- the hand-rolled COM handler: 4-slot vtable, QI answers IUnknown + handler + IAgileObject ---
const state = {
  activated: false,
  operationAddress: null,
  activateHr: 0,
  log: [],
};
const QueryInterfaceProto = koffi.proto("int32_t QueryInterface(void *self, void *riid, void **ppvObject)");
const AddRefProto = koffi.proto("uint32_t AddRef(void *self)");
const ReleaseProto = koffi.proto("uint32_t Release(void *self)");
const ActivateCompletedProto = koffi.proto("int32_t ActivateCompleted(void *self, void *operation)");

const handlerObject = allocBytes(8); // [0] = vtable pointer
const handlerVtable = allocBytes(8 * 4);

const queryInterface = koffi.register((self, riid, ppvObject) => {
  try {
    const riidBytes = new Uint8Array(koffi.view(riid, 16));
    let matched = null;
    if (bytesEqual(riidBytes, IID_UNKNOWN) || bytesEqual(riidBytes, IID_COMPLETION_HANDLER) || bytesEqual(riidBytes, IID_AGILE_OBJECT)) {
      matched = koffi.address(self);
    }
    if (matched !== null) {
      koffi.encode(ppvObject, 0, "void *", matched);
      state.log.push("QI: matched");
      return 0;
    }
    state.log.push("QI: E_NOINTERFACE");
    return 0x80004002 | 0;
  } catch (error) {
    state.log.push(`QI threw: ${error}`);
    return 0x80004002 | 0;
  }
}, koffi.pointer(QueryInterfaceProto));
const addRef = koffi.register(() => 1, koffi.pointer(AddRefProto));
const release = koffi.register(() => 1, koffi.pointer(ReleaseProto));
const activateCompleted = koffi.register((self, operation) => {
  try {
    state.operationAddress = koffi.address(operation);
    state.activated = true;
    state.log.push("ActivateCompleted fired");
    return 0;
  } catch (error) {
    state.log.push(`ActivateCompleted threw: ${error}`);
    return 0x80004002 | 0;
  }
}, koffi.pointer(ActivateCompletedProto));

writePointerBytes(handlerVtable.bytes, 0 * 8, queryInterface);
writePointerBytes(handlerVtable.bytes, 1 * 8, addRef);
writePointerBytes(handlerVtable.bytes, 2 * 8, release);
writePointerBytes(handlerVtable.bytes, 3 * 8, activateCompleted);
writePointerBytes(handlerObject.bytes, 0, handlerVtable.address);

// --- the activation blob: AUDIOCLIENT_ACTIVATION_PARAMS (12 B, PID first) inside a VT_BLOB PROPVARIANT ---
const activationParams = allocBytes(12);
{
  const view = new DataView(activationParams.bytes.buffer, activationParams.bytes.byteOffset, 12);
  view.setUint32(0, ACTIVATION_TYPE_PROCESS_LOOPBACK, true);
  view.setUint32(4, GetCurrentProcessId(), true); // exclude OURSELVES
  view.setUint32(8, LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, true);
}
const propVariant = allocBytes(24); // vt @0, (pad), cbSize @8, pBlobData @16 — pre-zeroed
{
  const view = new DataView(propVariant.bytes.buffer, propVariant.bytes.byteOffset, 24);
  view.setUint16(0, VT_BLOB, true);
  view.setUint32(8, 12, true);
  view.setBigUint64(16, activationParams.address, true);
}

const operationOut = allocBytes(8);
const iidAudioClient = allocBytes(16);
iidAudioClient.bytes.set(IID_AUDIO_CLIENT);

// --- run ---
const coinitHr = CoInitializeEx(null, COINIT_MULTITHREADED);
console.log(`CoInitializeEx hr=${(coinitHr >>> 0).toString(16)} (1 = S_FALSE already-in, both fine)`);
const hr = ActivateAudioInterfaceAsync(DEVICE_PATH, iidAudioClient.ref, propVariant.ref, handlerObject.ref, operationOut.ref);
console.log(`ActivateAudioInterfaceAsync hr=${(hr >>> 0).toString(16)}`);
if (hr !== 0) {
  console.log("activation call failed — aborting");
  process.exit(1);
}

// let the event loop breathe: koffi queues the foreign-thread callback to the main loop
const deadline = Date.now() + 3000;

// --- vtable invocation (oak's invokeInt, JS shape) ---
const UnknownQI = koffi.proto("int32_t UnknownQI(void *self, void *riid, void **ppvObject)");
const UnknownRelease = koffi.proto("uint32_t UnknownRelease(void *self)");
const GetActivateResult = koffi.proto("int32_t GetActivateResult(void *self, int32_t *hr, void **unknown)");
const ClientInitialize = koffi.proto("int32_t ClientInitialize(void *self, int32_t shareMode, uint32_t flags, int64_t duration, int64_t periodicity, void *format, void *guid)");
const ClientSetEventHandle = koffi.proto("int32_t ClientSetEventHandle(void *self, void *event)");
const ClientGetService = koffi.proto("int32_t ClientGetService(void *self, void *riid, void **service)");
const ClientStart = koffi.proto("int32_t ClientStart(void *self)");
const ClientStop = koffi.proto("int32_t ClientStop(void *self)");
const CaptureGetNextPacketSize = koffi.proto("int32_t CaptureGetNextPacketSize(void *self, uint32_t *frames)");
const CaptureGetBuffer = koffi.proto("int32_t CaptureGetBuffer(void *self, void **data, uint32_t *frames, uint32_t *flags, uint64_t *position, uint64_t *qpcPosition)");
const CaptureReleaseBuffer = koffi.proto("int32_t CaptureReleaseBuffer(void *self, uint32_t frames)");

// The one legitimate "read memory at an arbitrary address" tool: msvcrt memcpy
// into our scratch buffer (koffi has no raw read-at-bigint).
const msvcrt = koffi.load("msvcrt.dll");
const memcpy = msvcrt.func("void *memcpy(void *dest, const void *src, size_t count)");
const scratch = allocBytes(8);
const scratchView = new DataView(scratch.bytes.buffer, scratch.bytes.byteOffset, 8);
const scratch2 = allocBytes(4800); // up to 1200 stereo frames per drain slice

function readQword(addressBigint) {
  memcpy(scratch.ref, koffi.as(addressBigint, "void *"), 8);
  return scratchView.getBigUint64(0, true);
}
function vtableSlot(objectAddress, slotIndex) {
  return readQword(readQword(objectAddress) + BigInt(slotIndex * 8));
}
function comCall(objectAddress, slotIndex, proto, ...args) {
  return koffi.call(vtableSlot(objectAddress, slotIndex), proto, koffi.as(objectAddress, "void *"), ...args);
}

const AUDCLNT_STREAMFLAGS =
  0x00020000 | // LOOPBACK
  0x00040000 | // EVENTCALLBACK
  0x80000000 | // AUTOCONVERTPCM (unsigned!)
  0x08000000;  // SRC_DEFAULT_QUALITY
const captureFormat = allocBytes(18);
{
  const view = new DataView(captureFormat.bytes.buffer, captureFormat.bytes.byteOffset, 18);
  view.setUint16(0, 1, true);         // WAVE_FORMAT_PCM
  view.setUint16(2, 2, true);         // channels
  view.setUint32(4, 48000, true);     // rate
  view.setUint32(8, 48000 * 4, true); // avg bytes
  view.setUint16(12, 4, true);        // block align
  view.setUint16(14, 16, true);       // bits
}

(async () => {
  while (!state.activated && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(`activated=${state.activated}`);
  for (const line of state.log.slice(0, 10)) {
    console.log(`  cb: ${line}`);
  }
  if (!state.activated) {
    console.log("PHASE-0 VERDICT: RED — callback never fired");
    return;
  }
  console.log("PHASE-0 VERDICT: GREEN — foreign-thread COM callback works");

  // --- stage 2: complete the activation and drain real PCM ---
  const hrOut = allocBytes(4);
  const unknownOut = allocBytes(8);
  let callHr = comCall(state.operationAddress, 3, GetActivateResult, hrOut.ref, unknownOut.ref);
  const activateHr = new DataView(hrOut.bytes.buffer, hrOut.bytes.byteOffset, 4).getInt32(0, true);
  const unknownAddress = new DataView(unknownOut.bytes.buffer, unknownOut.bytes.byteOffset, 8).getBigUint64(0, true);
  console.log(`GetActivateResult hr=${(callHr >>> 0).toString(16)} activateHr=${(activateHr >>> 0).toString(16)} unknown=0x${unknownAddress.toString(16)}`);
  if (activateHr !== 0) {
    console.log("activation completed with an error — probe ends (phase-0 still green)");
    return;
  }

  const audioClientOut = allocBytes(8);
  callHr = comCall(unknownAddress, 0, UnknownQI, iidAudioClient.ref, audioClientOut.ref);
  const audioClientAddress = new DataView(audioClientOut.bytes.buffer, audioClientOut.bytes.byteOffset, 8).getBigUint64(0, true);
  console.log(`QI IAudioClient hr=${(callHr >>> 0).toString(16)} client=0x${audioClientAddress.toString(16)}`);

  const iidCaptureClient = allocBytes(16);
  iidCaptureClient.bytes.set(guidBytes("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}"));
  const bufferEvent = CreateEventW(null, 0, 0, null);
  callHr = comCall(audioClientAddress, 3, ClientInitialize, 0, AUDCLNT_STREAMFLAGS, 0, 0, captureFormat.ref, null);
  console.log(`Initialize hr=${(callHr >>> 0).toString(16)}`);
  callHr = comCall(audioClientAddress, 13, ClientSetEventHandle, bufferEvent);
  console.log(`SetEventHandle hr=${(callHr >>> 0).toString(16)}`);
  const captureClientOut = allocBytes(8);
  callHr = comCall(audioClientAddress, 14, ClientGetService, iidCaptureClient.ref, captureClientOut.ref);
  const captureClientAddress = new DataView(captureClientOut.bytes.buffer, captureClientOut.bytes.byteOffset, 8).getBigUint64(0, true);
  console.log(`GetService hr=${(callHr >>> 0).toString(16)} capture=0x${captureClientAddress.toString(16)}`);
  callHr = comCall(audioClientAddress, 10, ClientStart);
  console.log(`Start hr=${(callHr >>> 0).toString(16)}`);

  // drain ~2 s: packets of 16-bit stereo PCM, accumulate RMS
  const packetFrames = allocBytes(4);
  const dataOut = allocBytes(8);
  const framesOut = allocBytes(4);
  const flagsOut = allocBytes(4);
  const posOut = allocBytes(8);
  const qpcOut = allocBytes(8);
  const view32 = (buffer) => new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let totalSamples = 0;
  let totalSquare = 0;
  let peakValue = 0;
  const drainDeadline = Date.now() + 2000;
  while (Date.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    WaitForSingleObject(bufferEvent, 0);
    for (;;) {
      comCall(captureClientAddress, 5, CaptureGetNextPacketSize, packetFrames.ref);
      if (view32(packetFrames.bytes).getUint32(0, true) === 0) {
        break;
      }
      comCall(captureClientAddress, 3, CaptureGetBuffer, dataOut.ref, framesOut.ref, flagsOut.ref, posOut.ref, qpcOut.ref);
      const gotFrames = view32(framesOut.bytes).getUint32(0, true);
      const flags = view32(flagsOut.bytes).getUint32(0, true);
      if ((flags & 0x2) === 0 && gotFrames > 0) {
        const dataAddress = view32(dataOut.bytes) instanceof DataView
          ? new DataView(dataOut.bytes.buffer, dataOut.bytes.byteOffset, 8).getBigUint64(0, true)
          : 0n;
        const copyBytes = Math.min(gotFrames * 4, 4800);
        memcpy(scratch2.ref, koffi.as(dataAddress, "void *"), copyBytes);
        const sampleCount = copyBytes / 2;
        const samples = new Int16Array(scratch2.bytes.buffer, scratch2.bytes.byteOffset, sampleCount);
        for (let index = 0; index < sampleCount; index += 1) {
          const value = samples[index] / 32768;
          totalSquare += value * value;
          if (Math.abs(value) > peakValue) {
            peakValue = Math.abs(value);
          }
        }
        totalSamples += sampleCount;
      }
      comCall(captureClientAddress, 4, CaptureReleaseBuffer, gotFrames);
    }
  }
  const rms = totalSamples > 0 ? Math.sqrt(totalSquare / totalSamples) : 0;
  console.log(`drained ${totalSamples} samples in 2 s — rms=${rms.toFixed(5)} peak=${peakValue.toFixed(3)} (silence is fine; the pipeline is the proof)`);

  callHr = comCall(audioClientAddress, 11, ClientStop);
  console.log(`Stop hr=${(callHr >>> 0).toString(16)} — PHASE 2: PCM ${totalSamples > 0 ? "flows" : "did NOT flow"}`);
  comCall(captureClientAddress, 2, UnknownRelease);
  comCall(audioClientAddress, 2, UnknownRelease);
  comCall(state.operationAddress, 2, UnknownRelease);
  CloseHandle(bufferEvent);
  CoUninitialize();
})();
