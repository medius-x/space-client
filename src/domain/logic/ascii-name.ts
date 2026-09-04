/**
 * The server's upload-slot validation rejects non-ASCII file names outright
 * (a Cyrillic "отчёт.pdf" is a 400 on /api/attachments). The name feeds only
 * the MinIO OBJECT KEY; the display name travels separately in AttachmentRef.
 * So the slot request gets a flattened ASCII name, the user's original name
 * stays on the message.
 */
export function sanitizeSlotFileName(fileName: string): string {
  const flattened = fileName.replace(/[^A-Za-z0-9-_. ]+/g, "_").replace(/\s+/g, " ").trim();
  if (flattened.length === 0 || flattened === "_") {
    return "file";
  }
  const dot = flattened.lastIndexOf(".");
  const tooLong = flattened.length > 200;
  if (!tooLong) {
    return flattened;
  }
  const extension = dot !== -1 ? flattened.slice(dot) : "";
  return `${flattened.slice(0, 200 - extension.length)}${extension}`;
}
