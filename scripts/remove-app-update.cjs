// electron-builder always emits resources/app-update.yml — an electron-updater
// feed config it infers from the git remote (owner/repo). SPACE ships no
// auto-updates: electron-updater is not a dependency, nothing reads the file,
// and its "space-client-updater" cache name only confuses (user decision
// 2026-10-15). Strip it from every package.
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function removeAppUpdateConfig(context) {
  const target = path.join(context.appOutDir, "resources", "app-update.yml");
  await fs.promises.rm(target, { force: true });
};
