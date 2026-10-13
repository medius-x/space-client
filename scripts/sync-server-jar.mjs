#!/usr/bin/env node
/**
 * Refreshes the bundled provisioning jar (electron/provisioning/files/oak-server.jar)
 * from a local oak-server build — the dev-cycle twin of round D's release pipeline
 * (which will drop the release artifact there during the electron-builder packaging).
 *
 *   cd oak-server && mvn -B package -DskipTests
 *   cd ../space-client && npm run jar:sync
 */
import { copyFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceCandidates = [
  join(scriptDir, "..", "..", "oak-server", "target", "oak-server-1.0-SNAPSHOT.jar"),
  join(scriptDir, "..", "..", "oak-server", "env", "oak-server.jar"),
];
const target = join(scriptDir, "..", "electron", "provisioning", "files", "oak-server.jar");

const source = sourceCandidates.find((candidate) => existsSync(candidate));
if (source === undefined) {
  console.error("No oak-server jar found — build it first: cd ../oak-server && mvn -B package -DskipTests");
  process.exit(1);
}
copyFileSync(source, target);
const megabytes = statSync(target).size / 1024 / 1024;
console.log(`bundled server jar updated: ${source} -> ${target} (${megabytes.toFixed(1)} MB)`);
