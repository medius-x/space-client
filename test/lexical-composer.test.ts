// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createComposerEditor,
  loadComposerText,
  serializeComposerState,
  toggleSpoilerSelection,
  $caretModelOffsets,
  $loadComposerText,
  $setCaretFromModel,
} from "../src/renderer/lexical-composer";
import { wrapSelectionInMarker } from "../src/domain/logic/composer-format";
import {
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $isTextNode,
  FORMAT_TEXT_COMMAND,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

/** Lexical 0.53 batches plain editor.update into a microtask — every test
 * mutation runs DISCRETE so the very next read sees it. */
function discreteUpdate(editor: LexicalEditor, mutate: () => void): void {
  editor.update(mutate, { discrete: true });
}

function makeEditor(): LexicalEditor {
  const editor = createComposerEditor((error) => {
    throw error;
  }, () => undefined);
  const root = document.createElement("div");
  document.body.appendChild(root);
  editor.setRootElement(root);
  return editor;
}

/** Loads a model string and returns the serialized round-trip. */
function roundTrip(editor: LexicalEditor, content: string): string {
  loadComposerText(editor, content, { start: 0, end: 0 });
  return serializeComposerState(editor);
}

/** Replaces a paragraph child's text (the way native editing would change a
 * node's own content), keeping its format — the honest simulation of typing
 * inside a format run. */
function rewriteChildText(editor: LexicalEditor, childIndex: number, text: string): void {
  discreteUpdate(editor, () => {
    const paragraph = $getRoot().getFirstChild();
    if (!$isParagraphNode(paragraph)) {
      throw new Error("no paragraph");
    }
    const child: LexicalNode | undefined = paragraph.getChildren()[childIndex];
    if (!$isTextNode(child)) {
      throw new Error("child is not a text node");
    }
    const grown = $createTextNode(text);
    grown.setFormat(child.getFormat());
    child.replace(grown);
  });
}

describe("wrapSelectionInMarker (the plain mode's model wrap)", () => {
  it("wraps a range and selects the wrapped content", () => {
    expect(wrapSelectionInMarker("hello world", 0, 5, "**")).toEqual({
      next: "**hello** world",
      nextStart: 2,
      nextEnd: 7,
    });
  });

  it("an empty range drops the pair at the caret", () => {
    expect(wrapSelectionInMarker("ab", 1, 1, "*")).toEqual({
      next: "a**b",
      nextStart: 2,
      nextEnd: 2,
    });
  });

  it("unwraps when the range already sits inside the exact pair", () => {
    expect(wrapSelectionInMarker("**hello** world", 2, 7, "**")).toEqual({
      next: "hello world",
      nextStart: 0,
      nextEnd: 5,
    });
  });

  it("a marker touching only one side still wraps (no accidental unwrap)", () => {
    expect(wrapSelectionInMarker("a *b* c", 3, 5, "*").next).toBe("a **b** c");
  });
});

describe("serializeComposerRoot round-trips", () => {
  it("returns the model string verbatim for flat markers", () => {
    const editor = makeEditor();
    const model = "plain **bold** and `code` and ||sp|| ~~s~~ __u__";
    expect(roundTrip(editor, model)).toBe(model);
  });

  it("nested italics/bold re-serialize into an equivalent marker shape", () => {
    // *a **b** c* flattens to three runs (italic, italic+bold, italic) and
    // serializes as *a* ***b*** *c* — not byte-identical, but the parser reads
    // the same visual formatting back, and a second round-trip is stable
    const editor = makeEditor();
    const firstPass = roundTrip(editor, "*a **b** c*");
    expect(firstPass).toBe("*a* ***b*** *c*");
    expect(roundTrip(editor, firstPass)).toBe(firstPass);
  });

  it("the empty string is an empty document (no dangling markers)", () => {
    const editor = makeEditor();
    expect(roundTrip(editor, "")).toBe("");
  });

  it("newlines survive as model \\n", () => {
    const editor = makeEditor();
    expect(roundTrip(editor, "one\ntwo **bold**\nnext")).toBe("one\ntwo **bold**\nnext");
  });

  it("a bold pair spanning a newline serializes as two pairs", () => {
    // the document cannot carry a marker pair across a line break
    const editor = makeEditor();
    loadComposerText(editor, "**a\nb**", { start: 0, end: 0 });
    expect(serializeComposerState(editor)).toBe("**a**\n**b**");
  });

  it("an NBSP typed outside code becomes an ordinary space (the double-space report)", () => {
    const editor = makeEditor();
    loadComposerText(editor, "word", { start: 0, end: 0 });
    rewriteChildText(editor, 0, "word "); // a NBSP the way Chromium types it at a line edge
    expect(serializeComposerState(editor)).toBe("word ");
  });

  it("an NBSP inside inline code is data — kept verbatim", () => {
    const editor = makeEditor();
    expect(roundTrip(editor, "`a b`")).toBe("`a b`");
  });

  it("a trailing space typed inside a bold run moves OUTSIDE the pair", () => {
    // "слово " typed inside a bold format: naive serialization would emit
    // "**слово **" — a pair the parser REJECTS (content must hug its markers)
    const editor = makeEditor();
    loadComposerText(editor, "**слово**", { start: 0, end: 0 });
    rewriteChildText(editor, 0, "слово ");
    expect(serializeComposerState(editor)).toBe("**слово** ");
  });

  it("inline code keeps its edge spaces — the parser allows them there", () => {
    const editor = makeEditor();
    expect(roundTrip(editor, "` x `")).toBe("` x `");
  });

  it("a whitespace-only format run collapses to the whitespace itself", () => {
    const editor = makeEditor();
    loadComposerText(editor, "**x**y", { start: 0, end: 0 });
    rewriteChildText(editor, 0, "  "); // the user erased the word, spaces remain
    expect(serializeComposerState(editor)).toBe("  y");
  });
});

describe("the caret offset bridge (model coordinates)", () => {
  it("offsets count the marker pairs — the mode-switch regression", () => {
    const editor = makeEditor();
    loadComposerText(editor, "**bo**ld\nnext", { start: 0, end: 0 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(3, 3); // between "b" and "o" — 2 markers + 1
    });
    expect(editor.getEditorState().read(() => $caretModelOffsets())).toEqual({ start: 3, end: 3 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(2, 4); // the bold run's content
    });
    expect(editor.getEditorState().read(() => $caretModelOffsets())).toEqual({ start: 2, end: 4 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(9, 13); // after the newline, to the end
    });
    expect(editor.getEditorState().read(() => $caretModelOffsets())).toEqual({ start: 9, end: 13 });
  });

  it("an offset on the pair's outer edge stays OUTSIDE the markers", () => {
    const editor = makeEditor();
    loadComposerText(editor, "**bold** tail", { start: 0, end: 0 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(8, 8); // right after the closing markers
    });
    expect(editor.getEditorState().read(() => $caretModelOffsets())).toEqual({ start: 8, end: 8 });
  });

  it("a caret past the end clamps to the tail", () => {
    const editor = makeEditor();
    loadComposerText(editor, "**bo**ld", { start: 99, end: 99 });
    expect(editor.getEditorState().read(() => $caretModelOffsets())).toEqual({ start: 8, end: 8 });
  });

  it("a code run's marker pair counts in the bridge", () => {
    // the code pair is emitted by the serializer but code is absent from
    // MARKER_ORDER — before the zone-based layout the bridge miscounted the
    // run by both backticks and every offset AFTER it shifted by 2
    const editor = makeEditor();
    loadComposerText(editor, "`x` tail", { start: 0, end: 0 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(4, 8); // "tail" — after the code pair and the space
    });
    expect(editor.getEditorState().read(() => $caretModelOffsets())).toEqual({ start: 4, end: 8 });
  });

  it("edge-whitespace runs map through the pair's zones (the strike report's document)", () => {
    // after unwrapping a word inside a strike run the document holds
    // strike("one two ") + plain("three"): the serialized model is
    // `~~one two~~ three`, and the bridge must agree with it EXACTLY —
    // copy/cut/delete speak these offsets
    const editor = makeEditor();
    loadComposerText(editor, "~~one two three~~", { start: 0, end: 0 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(10, 15); // "three"
    });
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough");
    expect(serializeComposerState(editor)).toBe("~~one two~~ three");
    // the restored selection reads back at the model's own offsets
    expect(editor.getEditorState().read(() => $caretModelOffsets())).toEqual({ start: 12, end: 17 });
  });

  it("the empty document keeps offset 0", () => {
    const editor = makeEditor();
    loadComposerText(editor, "", { start: 0, end: 0 });
    expect(editor.getEditorState().read(() => $caretModelOffsets())).toEqual({ start: 0, end: 0 });
  });
});

describe("live formatting", () => {
  it("FORMAT_TEXT_COMMAND wraps the selected range (vanilla core handler)", () => {
    const editor = makeEditor();
    loadComposerText(editor, "hello world", { start: 0, end: 0 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(0, 5); // "hello"
    });
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
    expect(serializeComposerState(editor)).toBe("**hello** world");
  });

  it("a second FORMAT_TEXT_COMMAND unwraps", () => {
    const editor = makeEditor();
    loadComposerText(editor, "**hello** world", { start: 0, end: 0 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(2, 7); // "hello" inside the pair
    });
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
    expect(serializeComposerState(editor)).toBe("hello world");
  });

  it("unwrapping a WORD inside a longer strike run yields a VALID model (the context-menu report)", () => {
    // The smoke report: words in strike, a space, one more word, select THAT
    // word and unwrap — the old model-wrap could only unwrap a WHOLE pair, so
    // it wrapped markers INSIDE the existing pair and sent
    // `~~one two ~~three~~~~`; the parser rejects that (an edge space inside
    // the first pair) and the markers rendered as literal text. The live
    // command toggles exactly the SEEN characters instead.
    const editor = makeEditor();
    loadComposerText(editor, "~~one two three~~", { start: 0, end: 0 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(10, 15); // "three" — a strict SUB-RANGE of the pair's content
    });
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough");
    const model = serializeComposerState(editor);
    expect(model).toBe("~~one two~~ three");
    // the parser must take it back — a second round-trip is stable, no junk
    expect(roundTrip(editor, model)).toBe(model);
  });

  it("the spoiler toggle wraps and unwraps the selection", () => {
    const editor = makeEditor();
    loadComposerText(editor, "secret stuff", { start: 0, end: 0 });
    discreteUpdate(editor, () => {
      $setCaretFromModel(0, 6); // "secret"
    });
    toggleSpoilerSelection(editor);
    expect(serializeComposerState(editor)).toBe("||secret|| stuff");
    // the selection survived the toggle — the second call unwraps
    const selectionAfterWrap = editor.getEditorState().read(() => {
      const selection = $getSelection();
      return $isRangeSelection(selection) && !selection.isCollapsed();
    });
    expect(selectionAfterWrap).toBe(true);
    toggleSpoilerSelection(editor);
    expect(serializeComposerState(editor)).toBe("secret stuff");
  });

  it("a collapsed caret toggles the FLOWING format (Ctrl+B then types bold)", () => {
    const editor = makeEditor();
    loadComposerText(editor, "plain ", { start: 6, end: 6 }); // caret after the space
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
    const selectionFormat = editor.getEditorState().read(() => {
      const selection = $getSelection();
      return $isRangeSelection(selection) ? selection.format : -1;
    });
    expect(selectionFormat).toBeGreaterThan(0); // the flowing bold bit is armed
  });

  it("a collapsed caret is a no-op for the spoiler (it needs a selection)", () => {
    const editor = makeEditor();
    loadComposerText(editor, "plain", { start: 2, end: 2 });
    toggleSpoilerSelection(editor);
    expect(serializeComposerState(editor)).toBe("plain");
  });

  it("the DOM carries the format classes (what the composer visually shows)", () => {
    const editor = makeEditor();
    loadComposerText(editor, "**b** *i* __u__ ~~s~~ `c` ||sp||", { start: 0, end: 0 });
    const rootElement = editor.getRootElement();
    // Lexical renders bold as <strong>, italic as <em>, code inside <code> —
    // whatever the tag, the theme class must sit on each formatted element
    const classNames = [...(rootElement?.querySelectorAll<HTMLElement>("[class]") ?? [])]
      .map((element) => element.className)
      .filter((className) => className.startsWith("fmt-"))
      .sort();
    expect(classNames).toEqual([
      "fmt-bold",
      "fmt-code",
      "fmt-italic",
      "fmt-spoiler",
      "fmt-strike",
      "fmt-underline",
    ]);
  });
});
