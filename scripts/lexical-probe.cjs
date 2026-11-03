// One-shot Lexical probe (2026-11-03), round 2: reproduces the USER SMOKE
// scenario with REAL key events through the REAL composer module — Ctrl+B
// over a selection, the SECOND Ctrl+B (unwrap), Ctrl+Shift+X (strike), and
// the collapsed Ctrl+B flow toggle twice. The page mimics ChatPane's keydown
// handler (event.code based) and drives the actual applyLiveFormatCommand.
// Run:
//   npx electron scripts/lexical-probe.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

// The browser-side entry: real composer module + a ChatPane-like keydown shim.
const ENTRY = `
import { createComposerEditor, loadComposerText, serializeComposerState, applyLiveFormatCommand, $caretModelOffsets } from "../src/renderer/lexical-composer";
import { $getRoot, $getSelection, $isRangeSelection } from "lexical";

const editor = createComposerEditor((error) => { window.__probeErrors.push(String(error)); }, () => undefined);
window.__probeErrors = [];
window.__events = [];
const ed = () => document.getElementById("ed");

document.addEventListener("DOMContentLoaded", () => {
  editor.setRootElement(ed());
  loadComposerText(editor, "", { start: 0, end: 0 });
  ed().focus();
  // ChatPane's keydown shim: the same event.code logic the React handler uses
  ed().addEventListener("keydown", (event) => {
    window.__events.push(["keydown", event.code, "ctrl=" + event.ctrlKey, "shift=" + event.shiftKey, "prevented=" + event.defaultPrevented]);
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === "KeyX") {
      event.preventDefault();
      applyLiveFormatCommand(editor, "~~");
      window.__events.push(["cmd", "~~"]);
    }
  });
});

window.__probe = {
  focus() {
    ed().focus();
  },
  reset(content) {
    loadComposerText(editor, content, { start: content.length, end: content.length });
    ed().focus();
  },
  state() {
    return {
      dom: ed().innerHTML,
      model: serializeComposerState(editor),
      text: editor.getEditorState().read(() => $getRoot().getTextContent()),
      caret: editor.getEditorState().read(() => $caretModelOffsets()),
      selectionKind: editor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          return selection.isCollapsed() ? "range-collapsed" : "range";
        }
        return selection === null ? "null" : String(selection.getType());
      }),
      selectionFormat: editor.getEditorState().read(() => { const s = $getSelection(); return $isRangeSelection(s) ? s.format : null; }),
      errors: window.__probeErrors,
      events: window.__events.slice(-8),
    };
  },
};
`;

app.whenReady().then(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lexical-probe-"));
  const outFile = path.join(tmpDir, "probe.js");
  try {
    const entryPath = path.join(process.cwd(), "scripts", ".lexical-probe-entry.tmp.ts");
    fs.writeFileSync(entryPath, ENTRY.replace('from "../src/', 'from "../src/'));
    try {
      buildSync({
        entryPoints: [entryPath],
        bundle: true,
        format: "iife",
        platform: "browser",
        outfile: outFile,
        logLevel: "silent",
      });
    } finally {
      fs.rmSync(entryPath, { force: true });
    }
  } catch (buildError) {
    console.error("[probe] esbuild failed:", String(buildError));
    app.quit();
    return;
  }
  const scriptBody = fs.readFileSync(outFile, "utf8");
  // plain CONCATENATION — String.replace would expand $-sequences in the bundle
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<div id="ed" contenteditable="true" style="width:400px;height:160px;font-size:14px;outline:1px solid #888;padding:8px"></div>
<script>${scriptBody}</script></body></html>`;
  const htmlPath = path.join(tmpDir, "probe.html");
  fs.writeFileSync(htmlPath, html);

  const win = new BrowserWindow({ show: false, width: 420, height: 200 });
  const wc = win.webContents;
  wc.on("did-fail-load", (_event, code, description) => {
    console.log(`[probe] did-fail-load ${code} ${description}`);
  });
  void win.loadFile(htmlPath).then(async () => {
    const type = (text) => {
      for (const character of text) {
        wc.sendInputEvent({ type: "char", keyCode: character });
      }
    };
    const key = (keyCode, modifiers) => {
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers ?? [] });
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers ?? [] });
    };
    const dump = async (label) => {
      const state = await wc.executeJavaScript("window.__probe.state()");
      console.log(`[probe] ${label}: ${JSON.stringify(state)}`);
    };
    const focus = () => wc.executeJavaScript("window.__probe.focus()");

    // THE USER SCENARIO: type a couple of words, select the first, bold it,
    // bold it AGAIN (unwrap), strike the second word.
    await focus();
    type("hello world");
    await dump("S6 typed 'hello world'");
    // select "hello": Home, then Shift+ArrowRight ×5
    key("Home");
    for (let pressIndex = 0; pressIndex < 5; pressIndex += 1) {
      key("Right", ["Shift"]);
    }
    await dump("S7 selected 'hello' (Home + Shift+Right x5)");
    key("B", ["Control"]);
    await dump("S8 Ctrl+B over selection");
    key("B", ["Control"]);
    await dump("S9 SECOND Ctrl+B (should unwrap)");

    // select "world": End, then Shift+ArrowLeft ×5
    key("End");
    for (let pressIndex = 0; pressIndex < 5; pressIndex += 1) {
      key("Left", ["Shift"]);
    }
    key("X", ["Control", "Shift"]);
    await dump("S10 Ctrl+Shift+X over 'world'");

    // collapsed flow toggle twice with typing between
    key("End");
    key("B", ["Control"]);
    type(" tail");
    await dump("S11 collapsed Ctrl+B then typed ' tail'");
    key("B", ["Control"]);
    type(" plain");
    await dump("S12 second collapsed Ctrl+B then typed ' plain'");

    // THE STRIKE REPORT: type words in strike, a SPACE, one more word, select
    // that word and unwrap — the sent message shows literal ~~ markers.
    await wc.executeJavaScript('window.__probe.reset("")');
    await focus();
    key("X", ["Control", "Shift"]); // arm the strike flow at a collapsed caret
    type("one two");
    await dump("S13 typed 'one two' in strike flow");
    type(" ");
    await dump("S14 typed a SPACE at the run edge");
    type("three");
    await dump("S15 typed 'three' after the space");
    key("End");
    for (let pressIndex = 0; pressIndex < 5; pressIndex += 1) {
      key("Left", ["Shift"]);
    }
    await dump("S16 selected 'three'");
    key("X", ["Control", "Shift"]);
    await dump("S17 unwrapped 'three' — THE REPORT");
    key("X", ["Control", "Shift"]);
    await dump("S18 SECOND press over the restored selection");
    key("X", ["Control", "Shift"]);
    await dump("S19 third press — unwrapped again");
    // re-select "three" with ARROWS (a DOM selection, not the restored
    // programmatic one) and toggle again — separates a dead restored
    // selection from a broken command path
    key("End");
    for (let pressIndex = 0; pressIndex < 5; pressIndex += 1) {
      key("Left", ["Shift"]);
    }
    await dump("S20 re-selected 'three' with arrows");
    key("X", ["Control", "Shift"]);
    await dump("S21 toggle over the arrow-made selection");

    setTimeout(() => app.quit(), 200);
  });
  // a hard exit — the probe must never hang the console
  setTimeout(() => {
    console.log("[probe] hard timeout exit");
    app.exit(1);
  }, 20000).unref();
});
