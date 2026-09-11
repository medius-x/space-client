/** Pure label helpers for the user-settings sections (oak's combo converters). */

export const DISK_CACHE_CHOICES: readonly number[] = [0, 64, 128, 256, 512, 1024, 2048, 4096];

/**
 * oak's cache-size combo converter: 0 → "Off", ≥1024 MB → whole gigabytes,
 * everything else → megabytes.
 */
export function diskCacheLabel(megabytes: number): string {
  if (megabytes === 0) {
    return "Off";
  }
  return megabytes >= 1024 ? `${megabytes / 1024} GB` : `${megabytes} MB`;
}

/**
 * oak's activeServerConnectionAddress: the server-ADVERTISED "host:port" a
 * member types into "Add server" (stored server-side in the profile), or null
 * when the server never set one ("not set by the server").
 */
export function advertisedAddress(connectionHost: string | null, connectionPort: number | null): string | null {
  if (connectionHost === null || connectionPort === null || connectionHost.length === 0) {
    return null;
  }
  return `${connectionHost}:${connectionPort}`;
}
