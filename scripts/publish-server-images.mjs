#!/usr/bin/env node
/**
 * Attaches the bundled docker-image archives (electron/provisioning/files/images/)
 * to the oak-server GitHub release of a tag — the release workflow of THIS repo
 * downloads them back when building the installer, so the full server kit ships
 * inside the setup exe without ever committing ~530 MB of binaries to git.
 *
 *   npm run images:publish -- v0.1.0
 *
 * Requires the gh CLI (authenticated) and the origin remote pointing at GitHub:
 * the oak-server repo is derived from this repo's remote (same owner, name
 * "oak-server"). Re-running overwrites the assets (--clobber).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const imagesDir = join(scriptDir, "..", "electron", "provisioning", "files", "images");

const tag = process.argv[2];
if (tag === undefined || !tag.startsWith("v") || tag.length < 2) {
  console.error("usage: npm run images:publish -- v<version>   (the oak-server release tag)");
  process.exit(1);
}

const archives = readdirSync(imagesDir).filter((name) => name.endsWith(".tar.gz"));
if (archives.length === 0) {
  console.error(`no image archives in ${imagesDir} — run "npm run images:sync" first`);
  process.exit(1);
}
// Cross-check against the committed manifest: an archive set that drifted from
// the pinned digests would silently provision unpinned images.
const manifest = JSON.parse(readFileSync(join(imagesDir, "manifest.json"), "utf8")).map((entry) => entry.archive);
const manifestOnly = manifest.filter((archive) => !archives.includes(archive));
if (manifestOnly.length > 0 || archives.length !== manifest.length) {
  console.error(`images/ does not match manifest.json (missing: ${manifestOnly.join(", ") || "none"}, extra files: ${archives.length - manifest.length}) — re-run "npm run images:sync"`);
  process.exit(1);
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

let serverRepo;
try {
  const originUrl = run("git", ["remote", "get-url", "origin"]);
  const match = originUrl.match(/[/:]([^/]+)\/[^/]+(?:\.git)?$/);
  if (match === null) {
    throw new Error(`cannot parse owner from remote: ${originUrl}`);
  }
  serverRepo = `${match[1]}/oak-server`;
} catch (error) {
  console.error(`could not derive the oak-server repo from the origin remote (${error instanceof Error ? error.message : String(error)})`);
  process.exit(1);
}

const totalMegabytes = archives.reduce((sum, name) => sum + statSync(join(imagesDir, name)).size, 0) / 1024 / 1024;
console.log(`uploading ${archives.length} archives (${totalMegabytes.toFixed(0)} MB) to ${serverRepo} release ${tag}…`);
const args = ["release", "upload", tag, ...archives.map((name) => join(imagesDir, name)), "--repo", serverRepo, "--clobber"];
try {
  run("gh", args);
} catch (error) {
  // gh prints its own message to stderr (inherited above); add the fix hint.
  console.error(`upload failed — make sure the ${tag} release exists in ${serverRepo} (tag and push it there first) and gh is authenticated (gh auth status)`);
  process.exit(1);
}
console.log("done — the space-client release workflow of this tag can now fetch the full server kit.");
