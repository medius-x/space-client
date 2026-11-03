// One-shot contentEditable probe (2026-11-03): answers whether REAL Chromium
// types into an empty inline <span> the caret sits in, or "squeezes" the text
// out beside it (the WYSIWYG composer's typing-tail depends on it; jsdom cannot
// answer this — only the real editing engine can). Run:
//   npx electron scripts/contenteditable-probe.cjs
const { app, BrowserWindow } = require("electron");

const PAGE = `
<body style="margin:0">
<div id="ed" contenteditable="true" spellcheck="false"
     style="width:400px;height:200px;font-size:14px;outline:1px solid #888;padding:8px"></div>
</body>`;

const INSPECT = `(() => {
  const root = document.getElementById("ed");
  const structure = [];
  for (const child of root.childNodes) {
    structure.push(child.nodeType === 3 ? JSON.stringify(child.nodeValue)
      : "<" + child.nodeName.toLowerCase() + (child.dataset && child.dataset.format ? " data-format=" + child.dataset.format : "") + ">" + JSON.stringify(child.textContent ?? ""));
  }
  const sel = document.getSelection();
  return { structure, anchor: sel && sel.anchorNode ? (sel.anchorNode.nodeName === "#text" ? "text:" + JSON.stringify(sel.anchorNode.nodeValue) : sel.anchorNode.nodeName) + "@" + sel.anchorOffset : "none" };
})()`;

function typeText(webContents, text) {
  for (const ch of text) {
    webContents.sendInputEvent({ type: "char", keyCode: ch });
  }
}

function key(webContents, keyCode, modifiers) {
  webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers ?? [] });
  webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers ?? [] });
}

async function dump(webContents, label) {
  const state = await webContents.executeJavaScript(INSPECT);
  console.log(`[probe] ${label}: ${JSON.stringify(state)}`);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 420, height: 240 });
  void win.loadURL(`data:text/html,${encodeURIComponent(PAGE)}`).then(async () => {
    const wc = win.webContents;

    // SCENARIO A: the caret inside an EMPTY format span — does typed text stay in it?
    await wc.executeJavaScript(`(() => {
      const root = document.getElementById("ed");
      const tail = document.createElement("span");
      tail.dataset.format = "bold";
      root.appendChild(tail);
      const range = document.createRange();
      range.setStart(tail, 0);
      range.setEnd(tail, 0);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      root.focus();
    })()`);
    typeText(wc, "word");
    await dump(wc, "A empty-span + typed 'word'");

    // SCENARIO B: a NON-EMPTY span, caret at its very end — does the SPACE
    // land inside the span (the edge case the serializer must normalize)?
    await wc.executeJavaScript(`(() => {
      const root = document.getElementById("ed");
      root.replaceChildren();
      const span = document.createElement("span");
      span.dataset.format = "bold";
      span.textContent = "word";
      root.appendChild(span);
      const range = document.createRange();
      range.setStartAfter(span.firstChild);
      range.setEndAfter(span.firstChild);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      root.focus();
    })()`);
    typeText(wc, " ");
    await dump(wc, "B non-empty span, caret at end, typed ' '");

    // SCENARIO C: the tail with a ZERO-WIDTH SPACE inside (the classic anchor
    // trick) — does typing replace/absorb next to the ZWSP inside the span?
    await wc.executeJavaScript(`(() => {
      const root = document.getElementById("ed");
      root.replaceChildren();
      const tail = document.createElement("span");
      tail.dataset.format = "bold";
      tail.textContent = "\\u200b";
      root.appendChild(tail);
      const range = document.createRange();
      const text = tail.firstChild;
      range.setStart(text, 1);
      range.setEnd(text, 1);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      root.focus();
    })()`);
    typeText(wc, "word");
    await dump(wc, "C zwsp-span + typed 'word'");

    // SCENARIO D: after B, keep typing a WORD — where does it go?
    await wc.executeJavaScript(`(() => {
      const root = document.getElementById("ed");
      root.replaceChildren();
      const span = document.createElement("span");
      span.dataset.format = "bold";
      span.textContent = "word";
      root.appendChild(span);
      root.appendChild(document.createTextNode(" "));
      const text = root.lastChild;
      const range = document.createRange();
      range.setStart(text, 1);
      range.setEnd(text, 1);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      root.focus();
    })()`);
    typeText(wc, "next");
    await dump(wc, "D caret after a space OUTSIDE the span, typed 'next'");

    // SCENARIO E: execCommand insertLineBreak — what does it insert?
    await wc.executeJavaScript(`(() => {
      const root = document.getElementById("ed");
      root.replaceChildren();
      root.textContent = "a";
      const range = document.createRange();
      range.setStart(root.firstChild, 1);
      range.setEnd(root.firstChild, 1);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      root.focus();
    })()`);
    key(wc, "Enter", []);
    await dump(wc, "E Enter via keyDown (native contentEditable)");

    setTimeout(() => app.quit(), 200);
  });
});
