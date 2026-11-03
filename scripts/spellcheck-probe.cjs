// One-shot spell-check probe (2026-11-03): prints the platform's dictionary
// facts, drives a REAL spellchecked textarea in a hidden window, and
// synthesizes RIGHT CLICKS over misspelled words to dump the context-menu
// params (misspelledWord + dictionarySuggestions — the only platform source
// for the composer's suggestion menu). Run:
//   npx electron scripts/spellcheck-probe.cjs
//   SPACE_PROBE_LANGS=en,ru npx electron scripts/spellcheck-probe.cjs
// (the env override chases issue #38876: bare vs dashed language codes,
// single vs multiple languages).
const { app, BrowserWindow, session } = require("electron");

const LANGS = (process.env.SPACE_PROBE_LANGS ?? "en-US,ru").split(",").map((code) => code.trim());

app.whenReady().then(() => {
  const ses = session.defaultSession;
  const available = ses.availableSpellCheckerLanguages;
  console.log(`[probe] available languages: ${available.length} total`);
  console.log(`[probe] requested: ${JSON.stringify(LANGS)}`);
  ses.setSpellCheckerEnabled(true);
  ses.setSpellCheckerLanguages(LANGS);
  console.log(`[probe] languages set: ${JSON.stringify(ses.getSpellCheckerLanguages())}`);
  for (const name of [
    "spellcheck-dictionary-initialized",
    "spellcheck-dictionary-download-begin",
    "spellcheck-dictionary-download-success",
    "spellcheck-dictionary-download-failure",
  ]) {
    ses.on(name, (_event, languageCode) => {
      console.log(`[probe] EVENT ${name}: ${languageCode}`);
    });
  }
  // A real spellchecked document is what triggers the lazy dictionary
  // machinery — no document, no events.
  const win = new BrowserWindow({ show: true, width: 300, height: 120 });
  win.webContents.on("context-menu", (_event, params) => {
    console.log(`[probe] CONTEXT-MENU @${params.x},${params.y} misspelled="${params.misspelledWord}" suggestions=${JSON.stringify(params.dictionarySuggestions)} selectionText="${params.selectionText ?? ""}"`);
  });
  void win.loadURL('data:text/html,<body style="margin:0"><textarea spellcheck="true" style="width:300px;height:120px;font-size:14px">helo wrld превет</textarea></body>');
  // Right clicks across the first line — wherever one lands, "helo"/"wrld"
  // is misspelled and MUST surface in params if the platform provides them.
  setTimeout(() => {
    for (const x of [20, 45, 75, 110, 160, 220]) {
      win.webContents.sendInputEvent({ type: "mouseDown", x, y: 12, button: "right", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x, y: 12, button: "right" });
    }
  }, 5000);
  setTimeout(() => {
    void win.webContents.executeJavaScript(`
      (() => {
        const results = [];
        for (const [x, y] of [[20, 12], [75, 12], [160, 12], [60, 40]]) {
          try {
            const range = document.caretRangeFromPoint(x, y);
            const field = document.querySelector("textarea");
            results.push(\`@\${x},\${y}: node=\${range.startContainer.nodeName} offset=\${range.startOffset} valueLen=\${field.value.length}\`);
          } catch (error) {
            results.push(\`@\${x},\${y}: \${String(error)}\`);
          }
        }
        return results.join(" | ");
      })()
    `).then((report) => {
      console.log(`[probe] caretRangeFromPoint: ${report}`);
      console.log(`[probe] enabled AFTER: ${ses.isSpellCheckerEnabled()}`);
      console.log(`[probe] languages AFTER: ${JSON.stringify(ses.getSpellCheckerLanguages())}`);
      app.exit(0);
    });
  }, 9000);
}).catch((error) => {
  console.error(`[probe] FAILED: ${error}`);
  app.exit(1);
});
