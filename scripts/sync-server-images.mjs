#!/usr/bin/env node
/**
 * Bundled-image sync (round C, user decision 2026-10-12): pins the deployment
 * stack to EXACTLY the image versions running on THIS dev machine and ships
 * them as docker-save archives next to the templates — the client can then
 * deploy a server on a network where no registry is reachable, uploading only
 * the images the host is missing.
 *
 * What it does:
 *   1. For every image below: docker pull when absent locally (the dev machine
 *      can reach Docker Hub), then read its repo digest.
 *   2. docker save | gzip into electron/provisioning/files/images/<name>.tar.gz.
 *   3. REWRITES the digest pins in the deployment templates (compose image:
 *      lines, the two FROM bases) — a committed diff of pins IS the upgrade.
 *   4. Writes files/images/manifest.json (the pipeline's missing-check list).
 *
 * Run after changing any image version: npm run images:sync
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const filesRoot = join(scriptDir, "..", "electron", "provisioning", "files");
const imagesRoot = join(filesRoot, "images");

/** The single source of truth: service → the LOCAL reference we pin from. */
const IMAGE_SPECS = [
  { name: "postgres", localRef: "postgres:16-alpine", template: { file: "docker-compose.yml", from: "postgres:16-alpine" } },
  { name: "minio", localRef: "minio/minio:latest", template: { file: "docker-compose.yml", from: "minio/minio:latest" } },
  { name: "coturn", localRef: "coturn/coturn:latest", template: { file: "docker-compose.yml", from: "coturn/coturn:latest" } },
  { name: "caddy", localRef: "caddy:2", template: { file: "docker-compose.yml", from: "caddy:2" } },
  { name: "oak-base", localRef: "eclipse-temurin:17-jre-jammy", template: { file: "Dockerfile.server", from: "eclipse-temurin:17-jre-jammy" } },
  { name: "janus-base", localRef: "canyan/janus-gateway:latest", template: { file: join("janus", "Dockerfile"), from: "canyan/janus-gateway:latest" } },
];

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();

/** docker save streamed through gzip — never buffers an image in memory. */
function saveArchive(localRef, targetPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["save", localRef], { stdio: ["ignore", "pipe", "inherit"] });
    const gzip = createGzip({ level: 6 });
    const output = createWriteStream(targetPath);
    child.stdout.pipe(gzip).pipe(output);
    output.on("finish", () => resolve());
    output.on("error", reject);
    child.on("error", reject);
    gzip.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`docker save exited with ${code}`));
      }
    });
  });
}

mkdirSync(imagesRoot, { recursive: true });
const manifest = [];
const templatePatches = new Map(IMAGE_SPECS.map((spec) => [spec.template.file, []]));

for (const spec of IMAGE_SPECS) {
  process.stdout.write(`> ${spec.localRef} … `);
  if (!existsSyncImage(spec.localRef)) {
    process.stdout.write("(pulling) ");
    docker("pull", spec.localRef);
  }
  const digestRef = docker("image", "inspect", spec.localRef, "--format", "{{index .RepoDigests 0}}");
  if (!/^[^@]+@sha256:[0-9a-f]{64}$/.test(digestRef)) {
    throw new Error(`unexpected digest format for ${spec.localRef}: ${digestRef}`);
  }
  const archive = `${spec.name}.tar.gz`;
  const archivePath = join(imagesRoot, archive);
  unlinkSyncIfExists(archivePath);
  await saveArchive(spec.localRef, archivePath);
  const bytes = statSync(archivePath).size;
  manifest.push({ ref: digestRef, archive, bytes });
  templatePatches.get(spec.template.file).push({ from: spec.template.from, to: digestRef });
  console.log(`${(bytes / 1024 / 1024).toFixed(1)} MB  ${digestRef.slice(0, 40)}…`);
}

// Patch the digest pins into the templates. A pinned diff in git IS the
// version bump record — readable, reviewable, revertable.
for (const [file, patches] of templatePatches) {
  const targetPath = join(filesRoot, file);
  let text = readFileSync(targetPath, "utf8");
  for (const patch of patches) {
    const occurrences = text.split(patch.from).length - 1;
    if (occurrences === 0) {
      throw new Error(`${file}: the template no longer contains "${patch.from}" — update IMAGE_SPECS in this script`);
    }
    text = text.split(patch.from).join(patch.to);
  }
  writeFileSync(targetPath, text);
}

writeFileSync(join(imagesRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const totalMb = manifest.reduce((sum, entry) => sum + entry.bytes, 0) / 1024 / 1024;
console.log(`\nmanifest: ${manifest.length} images, ${totalMb.toFixed(0)} MB total — templates pinned to the local versions.`);

function existsSyncImage(ref) {
  try {
    execFileSync("docker", ["image", "inspect", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function unlinkSyncIfExists(targetPath) {
  if (existsSync(targetPath)) {
    unlinkSync(targetPath);
  }
}
