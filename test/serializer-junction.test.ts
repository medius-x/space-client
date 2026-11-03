// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createComposerEditor,
  loadComposerText,
  serializeComposerState,
} from "../src/renderer/lexical-composer";
import {
  segmentMessageContent,
  type MessageSegment,
} from "../src/domain/logic/mention-segmenter";
import type { LexicalEditor } from "lexical";

/** Adjacent runs whose marker sets share a boundary character. Each document
 * is loaded from a PARSEABLE model (the wrapping form, e.g. `~~**b**~~`), so
 * the run layout itself is legitimate — the question is what the serializer
 * emits for the junction. */
function makeEditor(): LexicalEditor {
  const editor = createComposerEditor((error) => {
    throw error;
  }, () => undefined);
  const root = document.createElement("div");
  document.body.appendChild(root);
  editor.setRootElement(root);
  return editor;
}

function serializedModelOf(model: string): string {
  const editor = makeEditor();
  loadComposerText(editor, model, { start: 0, end: 0 });
  return serializeComposerState(editor);
}

/** Flattens parsed segments into text/format-set pairs for assertions. */
function flatSegmentsOf(model: string): { text: string; formats: string[] }[] {
  const flat: { text: string; formats: string[] }[] = [];
  const walk = (segments: readonly MessageSegment[], inherited: string[]): void => {
    for (const segment of segments) {
      if (segment.kind === "formatted") {
        walk(segment.children, [...inherited, segment.format]);
        continue;
      }
      if (segment.kind === "text") {
        flat.push({ text: segment.text, formats: inherited });
      }
    }
  };
  walk(segmentMessageContent(model, []), []);
  return flat;
}

describe("serializer junctions between adjacent differently-formatted runs", () => {
  it("bold adjacent to bold+strike does not emit touching asterisks (report 2: four asterisks)", () => {
    // The document: [bold "a"][bold+strike "b"] — the exact shape of the
    // report. Today the serializer emits `**a****~~b~~**`: the parser's
    // touching-rule makes the outer bold swallow both runs and `****`
    // survives as literal text in the rendered message.
    const model = serializedModelOf("**a**~~**b**~~");
    // The second run must be emitted with the marker that does NOT share the
    // boundary character leading (strike first: `~~**b**~~`).
    expect(model).toBe("**a**~~**b**~~");
    expect(flatSegmentsOf(model)).toEqual([
      { text: "a", formats: ["bold"] },
      { text: "b", formats: ["strike", "bold"] },
    ]);
  });

  it("underline adjacent to underline+strike does not emit touching underscores", () => {
    const model = serializedModelOf("__a__~~__b__~~");
    expect(model).toBe("__a__~~__b__~~");
    expect(flatSegmentsOf(model)).toEqual([
      { text: "a", formats: ["underline"] },
      { text: "b", formats: ["strike", "underline"] },
    ]);
  });

  it("plain text with literal marker characters passes through verbatim", () => {
    // Documents the boundary: a plain run keeps its characters as-is (no
    // escaping exists); such text may not round-trip as formatted — the same
    // tradeoff every plain-text sender already has.
    expect(serializedModelOf("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("junctions without a shared boundary character are untouched", () => {
    expect(serializedModelOf("**a**__b__")).toBe("**a**__b__");
    expect(serializedModelOf("**a** b **c**")).toBe("**a** b **c**");
    expect(serializedModelOf("`code` **a**")).toBe("`code` **a**");
  });
});
