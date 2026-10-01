/** Human byte-size rendering ("2.0 KB", "1.5 MB") — the lightbox Details card's
 *  formatter, extracted so the plain-file card shares the exact same ladder
 *  (one decimal, B → KB → MB → GB, capped at GB). */
export function humanByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
