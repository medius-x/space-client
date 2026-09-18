/**
 * Saved-device restoration (# device fix): Chromium's media deviceId hashes are
 * NOT stable across app restarts in this Electron setup (live evidence: every
 * voice join logged "saved microphone unavailable in this window" — the stored
 * exact-id no longer exists), so a pick that only remembers the hash dies on the
 * next launch. The standard workaround: remember the LABEL alongside the id and
 * re-resolve — exact id first, label fallback, system default last.
 */

export interface DeviceRecord {
  deviceId: string;
  label: string;
}

/** Chromium's synthetic entries ("default"/"communications") duplicate real
 *  devices and the UI hides them — they must never win a label match. */
function isRealDevice(device: DeviceRecord): boolean {
  return device.deviceId !== "default" && device.deviceId !== "communications" && device.deviceId.length > 0;
}

/**
 * Resolve the device to use: the saved exact id if it still exists, else the
 * saved label among the enumerated real devices, else null (system default).
 */
export function matchDeviceId(devices: DeviceRecord[], savedId: string | null, savedLabel: string | null): string | null {
  if (savedId !== null) {
    const byId = devices.find((device) => device.deviceId === savedId);
    if (byId !== undefined) {
      return byId.deviceId;
    }
  }
  if (savedLabel !== null && savedLabel.length > 0) {
    const byLabel = devices.find((device) => isRealDevice(device) && device.label === savedLabel);
    if (byLabel !== undefined) {
      return byLabel.deviceId;
    }
  }
  return null;
}

/** The label worth REMEMBERING for a chosen device (empty for the synthetic
 *  default entry — nothing to recover by then). */
export function deviceLabelFor(devices: DeviceRecord[], deviceId: string | null): string | null {
  if (deviceId === null) {
    return null;
  }
  const found = devices.find((device) => device.deviceId === deviceId && isRealDevice(device));
  return found !== undefined && found.label.length > 0 ? found.label : null;
}
