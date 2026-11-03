import { registerRichText } from "@lexical/rich-text";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  createEditor,
  FORMAT_TEXT_COMMAND,
  LineBreakNode,
  ParagraphNode,
  PASTE_COMMAND,
  TextNode,
  type EditorThemeClasses,
  type LexicalEditor,
  type LexicalNode,
  type SerializedTextNode,
  type TextFormatType,
} from "lexical";
import { FORMAT_MARKER_OF } from "../domain/logic/composer-format";
import { segmentMessageContent, type FormatKind, type MessageSegment } from "../domain/logic/mention-segmenter";

/**
 * The WYSIWYG composer mode's editor layer (Lexical, migrated 2026-11-03 after
 * two rounds of hand-rolled contentEditable fixes kept losing to real Chromium
 * — the "library after two misses" rule). Lexical OWNS the DOM, the caret and
 * the typing; the flat marker string stays the single MODEL: every state change
 * serializes the document into it, and every external edit reloads the
 * document from it.
 *
 * - $loadComposerText: model string → document (the segmenter's tree becomes
 *   text nodes with format bits; a spoiler becomes a SpoilerTextNode).
 * - serializeComposerRoot: document → the model string. Adjacent text nodes
 *   with the same format merge into runs first, so a pair split across nodes
 *   still emits ONE marker pair. Edge whitespace moves OUTSIDE the pair (the
 *   parser requires content to hug its markers); inline code keeps its spaces.
 * - $caretModelOffsets / $setCaretFromModel: the caret as offsets in the MODEL
 *   string (marker pairs counted) — the coordinate system both editor modes
 *   share, so mode switches and external edits land the caret exactly.
 *
 * Formatting rides native machinery: FORMAT_TEXT_COMMAND toggles the built-in
 * bold/italic/underline/strikethrough/code bits, and a COLLAPSED caret simply
 * keeps the format flowing over everything typed next (Lexical's selection
 * format — Discord's typing toggle for free, no DOM tricks). The spoiler has
 * no native bit: it is a TextNode subclass toggled over the live selection.
 */

/** The spoiler's text node: renders as the .fmt-spoiler span, otherwise a
 * fully editable, splittable text node (its format bits — bold inside a
 * spoiler — ride along like on any text node). */
export class SpoilerTextNode extends TextNode {
  /** Lexical 0.53's declarative node protocol: the runtime resolves the node
   * TYPE through $config (the classic static getType() is internal now). */
  override $config(): ReturnType<TextNode["$config"]> {
    return this.config("spoiler", { extends: TextNode });
  }

  static override clone(node: SpoilerTextNode): SpoilerTextNode {
    const clone = new SpoilerTextNode(node.__text, node.__key);
    clone.afterCloneFrom(node); // carries __format/__style/__mode/__detail
    return clone;
  }

  override createDOM(config: Parameters<TextNode["createDOM"]>[0]): ReturnType<TextNode["createDOM"]> {
    const dom = super.createDOM(config);
    dom.classList.add("fmt-spoiler");
    return dom;
  }

  override updateDOM(
    prevNode: this,
    dom: HTMLElement,
    config: Parameters<TextNode["updateDOM"]>[2],
  ): boolean {
    // the spoiler class never changes on a live node (a toggle REPLACES the
    // node) — only the text/format reconciliation matters
    return super.updateDOM(prevNode, dom, config);
  }

  override exportJSON(): SerializedTextNode {
    return { ...super.exportJSON(), type: "spoiler" };
  }

  static override importJSON(json: SerializedTextNode): SpoilerTextNode {
    const node = new SpoilerTextNode(json.text);
    node.updateFromJSON(json);
    return node;
  }
}

export function $isSpoilerNode(node: LexicalNode | null | undefined): node is SpoilerTextNode {
  return node instanceof SpoilerTextNode;
}

/** The built-in Lexical format bit for each marker our model carries (the
 * spoiler is the node subclass — it has no bit). */
const NATIVE_TEXT_FORMAT_OF_MARKER: Readonly<Record<string, TextFormatType>> = {
  "**": "bold",
  "*": "italic",
  "__": "underline",
  "~~": "strikethrough",
  "`": "code",
};

/** The marker emission order (outermost first; closing happens in reverse, so
 * bold+italic emits ***…*** — the parser reads that back as bold(italic)
 * through its re-wrapping). Code is terminal and emits ALONE: the parser
 * keeps code children terminal, so a code+bold run could never round-trip. */
const MARKER_ORDER: readonly Exclude<FormatKind, "code">[] = ["spoiler", "bold", "italic", "underline", "strike"];

// ---------------------------------------------------------------------------
// Serialization: document → the flat model string
// ---------------------------------------------------------------------------

/** A run of adjacent text nodes sharing one format set — the unit the marker
 * emission and the caret offsets are both computed over. The `newline`
 * discriminator separates runs from line breaks. */
interface ComposerRun {
  newline: false;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  spoiler: boolean;
  text: string;
  /** The run's nodes in order (node key + its own text) — the offset bridge
   * maps model offsets onto these. */
  nodes: { key: string; text: string }[];
}

interface ComposerLineBreak {
  newline: true;
}

type ComposerUnit = ComposerRun | ComposerLineBreak;

function sameFormats(left: ComposerRun, right: ComposerRun): boolean {
  return left.bold === right.bold
    && left.italic === right.italic
    && left.underline === right.underline
    && left.strike === right.strike
    && left.code === right.code
    && left.spoiler === right.spoiler;
}

/** Walks the document's single paragraph into units (merging adjacent
 * same-format text nodes into runs). Must run inside read/update scope. */
function $composerUnits(): ComposerUnit[] {
  const units: ComposerUnit[] = [];
  for (const block of $getRoot().getChildren()) {
    if (!$isParagraphNode(block)) {
      continue; // the composer keeps exactly one paragraph by construction
    }
    for (const child of block.getChildren()) {
      if ($isLineBreakNode(child)) {
        units.push({ newline: true });
        continue;
      }
      if (!$isTextNode(child)) {
        continue; // nothing else lives in this editor by construction
      }
      // Chromium types NO-BREAK SPACE for edge/sequential spaces — it must
      // never leak into the model (the double-space smoke report). Inside
      // inline CODE a pasted NBSP is data — kept verbatim.
      const text = child.hasFormat("code")
        ? child.getTextContent()
        : child.getTextContent().replace(/ /g, " ");
      const run: ComposerRun = {
        newline: false,
        bold: child.hasFormat("bold"),
        italic: child.hasFormat("italic"),
        underline: child.hasFormat("underline"),
        strike: child.hasFormat("strikethrough"),
        code: child.hasFormat("code"),
        spoiler: $isSpoilerNode(child),
        text,
        nodes: [{ key: child.getKey(), text }],
      };
      const previous = units[units.length - 1];
      if (previous !== undefined && previous.newline === false && sameFormats(previous, run)) {
        previous.text += text;
        previous.nodes.push({ key: child.getKey(), text });
        continue;
      }
      units.push(run);
    }
  }
  return units;
}

/** The marker pair around a run's core. The order only permutes which marker
 * wraps which — nesting flattens into the leaf's format set on load, so any
 * order round-trips losslessly (lengths are order-independent, keeping the
 * caret bridge's zone math valid). */
function runMarkers(
  run: ComposerRun,
  order: readonly Exclude<FormatKind, "code">[] = MARKER_ORDER,
): { open: string; close: string } {
  let open = "";
  let close = "";
  for (const kind of order) {
    if (run[kind]) {
      open += FORMAT_MARKER_OF[kind];
      close = FORMAT_MARKER_OF[kind] + close;
    }
  }
  return { open, close };
}

/** The emission order for a run that must not OPEN with the character the
 * previous run's closing marker ended with: touching identical marker
 * characters at a junction make the parser's touching-rule reject both pairs
 * (report 2: `**a****~~b~~**` degrades to literal `****` in the rendered
 * message). Keeps the canonical order unless the boundary demands a safe
 * lead; when every enabled marker shares the boundary character (e.g. bold
 * after bold+italic) no reorder exists and today's degradation stands. */
function markerOrderAvoidingBoundary(
  run: ComposerRun,
  boundaryChar: string | null,
): readonly Exclude<FormatKind, "code">[] {
  if (boundaryChar === null) {
    return MARKER_ORDER;
  }
  const enabled = MARKER_ORDER.filter((kind) => run[kind]);
  const safeLead = enabled.find((kind) => FORMAT_MARKER_OF[kind][0] !== boundaryChar);
  if (safeLead === undefined || enabled[0] === safeLead) {
    return MARKER_ORDER;
  }
  return [
    safeLead,
    ...enabled.filter((kind) => kind !== safeLead),
    ...MARKER_ORDER.filter((kind) => !run[kind]),
  ];
}

/** Serializes the document into the flat model string. Must run inside
 * read/update scope. */
export function serializeComposerRoot(): string {
  let out = "";
  // the character the previous emission ended with when that was a marker
  // character — null means the junction cannot touch (whitespace, newline,
  // start of the document)
  let boundaryChar: string | null = null;
  for (const unit of $composerUnits()) {
    if (unit.newline === true) {
      out += "\n";
      boundaryChar = null;
      continue;
    }
    if (unit.code) {
      // terminal: the pair hugs the run verbatim (the parser allows edge
      // spaces inside code); an emptied code run emits nothing at all
      if (unit.text.length > 0) {
        out += "`" + unit.text + "`";
        boundaryChar = "`";
      } else {
        boundaryChar = null;
      }
      continue;
    }
    const leading = unit.text.match(/^\s+/)?.[0] ?? "";
    const trailing = unit.text.length > leading.length ? unit.text.match(/\s+$/)?.[0] ?? "" : "";
    const core = unit.text.slice(leading.length, unit.text.length - trailing.length);
    if (core.length === 0) {
      out += leading + trailing; // whitespace-only: the run collapses
      boundaryChar = null;
      continue;
    }
    const markers = runMarkers(
      unit,
      leading.length > 0 ? MARKER_ORDER : markerOrderAvoidingBoundary(unit, boundaryChar),
    );
    out += leading + markers.open + core + markers.close + trailing;
    boundaryChar = trailing.length > 0 ? null : markers.close.slice(-1);
  }
  return out;
}

/** Reads the CURRENT editor state's serialization (the sync-loop helper). */
export function serializeComposerState(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => serializeComposerRoot());
}

// ---------------------------------------------------------------------------
// Parsing: the flat model string → document
// ---------------------------------------------------------------------------

/** The full format set a text leaf carries (nesting flattens into it). */
interface LeafFormats {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  spoiler: boolean;
  code: boolean;
}

const EMPTY_LEAF_FORMATS: LeafFormats = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  spoiler: false,
  code: false,
};

/** Loads the model string into the editor document (replaces everything,
 * leaves a single paragraph; the empty string = one empty paragraph). Must
 * run inside editor.update. */
export function $loadComposerText(content: string): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  appendSegments(paragraph, segmentMessageContent(content, []), EMPTY_LEAF_FORMATS);
  root.append(paragraph);
}

function appendSegments(paragraph: ParagraphNode, segments: readonly MessageSegment[], inherited: LeafFormats): void {
  for (const segment of segments) {
    if (segment.kind !== "formatted") {
      appendLeaf(paragraph, segment.text, inherited);
      continue;
    }
    const formats = { ...inherited, [segment.format]: true } as LeafFormats;
    if (segment.format === "code") {
      // terminal leaf — the parser guarantees a single text child
      const inner = segment.children.length === 1 && segment.children[0]!.kind === "text"
        ? segment.children[0]!.text
        : "";
      appendLeaf(paragraph, inner, formats);
      continue;
    }
    appendSegments(paragraph, segment.children, formats);
  }
}

/** Appends a text leaf, splitting on "\n" into LineBreakNodes. */
function appendLeaf(paragraph: ParagraphNode, text: string, formats: LeafFormats): void {
  text.split("\n").forEach((part, partIndex) => {
    if (partIndex > 0) {
      paragraph.append($createLineBreakNode());
    }
    if (part.length === 0) {
      return;
    }
    const node = formats.spoiler ? new SpoilerTextNode(part) : $createTextNode(part);
    if (formats.bold) {
      node.toggleFormat("bold");
    }
    if (formats.italic) {
      node.toggleFormat("italic");
    }
    if (formats.underline) {
      node.toggleFormat("underline");
    }
    if (formats.strike) {
      node.toggleFormat("strikethrough");
    }
    if (formats.code) {
      node.toggleFormat("code");
    }
    paragraph.append(node);
  });
}

// ---------------------------------------------------------------------------
// The caret offset bridge (model string coordinates ⇄ document points)
// ---------------------------------------------------------------------------

/** A run's precomputed model coordinates. */
interface RunLayout {
  start: number;
  length: number;
  unit: ComposerRun;
  /** The run's zones in the SERIALIZED shape (the parser requires content to
   *  hug its markers, so edge whitespace sits OUTSIDE the pair and code keeps
   *  its own pair): the bridge maps node offsets through the same zones the
   *  serializer emits, keeping both directions of the bridge consistent. */
  parts: RunParts;
}

/** The run's zone lengths; node text is [leading][core][trailing], the model
 *  emission is [leading][open][core][open][trailing] (the closing marker's
 *  length equals the opening one's). */
interface RunParts {
  leading: number;
  open: number;
  core: number;
  trailing: number;
}

function runParts(run: ComposerRun): RunParts {
  if (run.code) {
    // the code pair hugs the run verbatim (edge spaces are DATA there)
    return run.text.length > 0
      ? { leading: 0, open: 1, core: run.text.length, trailing: 0 }
      : { leading: 0, open: 0, core: 0, trailing: 0 };
  }
  const leading = run.text.match(/^\s+/)?.[0].length ?? 0;
  const trailing = run.text.length > leading ? run.text.match(/\s+$/)?.[0].length ?? 0 : 0;
  const core = run.text.length - leading - trailing;
  if (core === 0) {
    // whitespace-only: the run collapses to the whitespace itself, no markers
    return { leading, open: 0, core: 0, trailing };
  }
  return { leading, open: runMarkers(run).open.length, core, trailing };
}

/** Maps a node offset within the run's RAW text to the model offset. The gap
 *  positions keep their human meaning: the gap at the core's end reads BEFORE
 *  the closing markers when nothing follows in the node (the run's whole tail
 *  then hugs its text), and past the closing markers once a trailing zone is
 *  there to land in. */
function nodeOffsetToModel(layout: RunLayout, nodeOffset: number): number {
  const { parts } = layout;
  const coreStart = layout.start + parts.leading + parts.open;
  const coreEndNode = parts.leading + parts.core;
  if (nodeOffset > coreEndNode || (nodeOffset === coreEndNode && parts.trailing > 0)) {
    return coreStart + parts.core + parts.open + (nodeOffset - coreEndNode);
  }
  if (parts.leading > 0 && nodeOffset <= parts.leading) {
    return layout.start + nodeOffset;
  }
  return coreStart + (nodeOffset - parts.leading);
}

/** Lays every run out on the model line (newlines count one model character
 * between runs). Must run inside read/update scope. */
function $runLayouts(): { runs: RunLayout[]; total: number } {
  const runs: RunLayout[] = [];
  let position = 0;
  for (const unit of $composerUnits()) {
    if (unit.newline === true) {
      position += 1;
      continue;
    }
    const parts = runParts(unit);
    const length = parts.leading + parts.open + parts.core + parts.open + parts.trailing;
    runs.push({ start: position, length, unit, parts });
    position += length;
  }
  return { runs, total: position };
}

/** The live selection as MODEL offsets (marker pairs counted), or null when
 * there is no range selection. Must run inside read scope. */
export function $caretModelOffsets(): { start: number; end: number } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return null;
  }
  const { runs, total } = $runLayouts();
  const paragraphKey = $getRoot().getFirstChild()?.getKey();
  const pointToModel = (point: typeof selection.anchor): number => {
    if (point.type === "element") {
      // the paragraph itself — selectAll's endpoints; 0 and everything else
      return point.key === paragraphKey && point.offset > 0 ? total : 0;
    }
    for (const run of runs) {
      let textBefore = 0;
      for (const piece of run.unit.nodes) {
        if (piece.key === point.key) {
          return nodeOffsetToModel(run, textBefore + Math.min(point.offset, piece.text.length));
        }
        textBefore += piece.text.length;
      }
    }
    return total; // a point on some other node — clamp to the tail
  };
  const start = pointToModel(selection.anchor);
  const end = pointToModel(selection.focus);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/** Places the selection at MODEL offsets (marker pairs counted). An offset on
 * a marker boundary takes the OUTER side — typing before the opening markers
 * or after the closing ones stays plain, never "inside" an invisible marker.
 * Must run inside editor.update. */
export function $setCaretFromModel(start: number, end: number): void {
  const paragraph = $getRoot().getFirstChild();
  if (paragraph === null) {
    return;
  }
  const { runs, total } = $runLayouts();
  /** The point at a RAW node offset inside the run (clamped to the tail). */
  const pointAtNodeOffset = (run: RunLayout, nodeOffset: number): { key: string; offset: number; type: "text" } => {
    let textBefore = 0;
    for (const piece of run.unit.nodes) {
      if (nodeOffset <= textBefore + piece.text.length) {
        return { key: piece.key, offset: nodeOffset - textBefore, type: "text" };
      }
      textBefore += piece.text.length;
    }
    const lastNode = run.unit.nodes[run.unit.nodes.length - 1]!;
    return { key: lastNode.key, offset: lastNode.text.length, type: "text" };
  };
  const resolvePoint = (offset: number): { key: string; offset: number; type: "text" | "element" } => {
    if (runs.length === 0) {
      return { key: paragraph.getKey(), offset: 0, type: "element" };
    }
    const clamped = Math.max(0, Math.min(offset, total));
    let previousTail: { key: string; offset: number; type: "text" } | null = null;
    for (const run of runs) {
      const { parts } = run;
      const openStart = run.start + parts.leading;
      const coreStart = openStart + parts.open;
      const coreEnd = coreStart + parts.core;
      const closeEnd = coreEnd + parts.open;
      if (clamped < openStart) {
        // the leading zone — honest text positions before the pair
        return pointAtNodeOffset(run, clamped - run.start);
      }
      if (parts.open > 0 && clamped < coreStart) {
        // inside the opening markers — the OUTER side: the previous run's
        // tail; the document head keeps the first run's start
        return previousTail ?? { key: run.unit.nodes[0]!.key, offset: 0, type: "text" };
      }
      if (clamped < coreEnd) {
        return pointAtNodeOffset(run, parts.leading + (clamped - coreStart));
      }
      previousTail = pointAtNodeOffset(run, parts.leading + parts.core + parts.trailing);
      if (clamped < closeEnd) {
        return previousTail; // inside the closing markers — the run's tail
      }
      if (clamped < run.start + run.length) {
        // the trailing zone — honest text positions after the pair
        return pointAtNodeOffset(run, parts.leading + parts.core + (clamped - closeEnd));
      }
    }
    return previousTail ?? { key: paragraph.getKey(), offset: 0, type: "element" };
  };
  const anchor = resolvePoint(start);
  const focus = resolvePoint(end);
  const selection = $createRangeSelection();
  selection.anchor.set(anchor.key, anchor.offset, anchor.type);
  selection.focus.set(focus.key, focus.offset, focus.type);
  $setSelection(selection);
}

/** Replaces the whole document with `content` and places the caret at the
 * given model offsets — the external-edit entry point (mode switches, picker
 * inserts, mention substitutions, sends). Discrete: the model must read back
 * the new text SYNCHRONOUSLY after the call (Lexical 0.53 batches plain
 * updates into a microtask). */
export function loadComposerText(editor: LexicalEditor, content: string, caret: { start: number; end: number }): void {
  editor.update(() => {
    $loadComposerText(content);
    $setCaretFromModel(caret.start, caret.end);
  }, { discrete: true });
}

// ---------------------------------------------------------------------------
// Editor construction and the formatting actions
// ---------------------------------------------------------------------------

/** The editor's theme maps the native format bits onto the project's message
 * format classes — the composer renders exactly what a sent message will. */
const COMPOSER_THEME: EditorThemeClasses = {
  text: {
    bold: "fmt-bold",
    italic: "fmt-italic",
    underline: "fmt-underline",
    strikethrough: "fmt-strike",
    code: "fmt-code",
  },
};

export function createComposerEditor(onError: (error: Error) => void, onPasteFiles: (files: File[]) => void): LexicalEditor {
  const editor = createEditor({
    namespace: "space-composer",
    nodes: [ParagraphNode, TextNode, LineBreakNode, SpoilerTextNode],
    theme: COMPOSER_THEME,
    onError,
  });
  // The native-editing behavior (typing, backspace/delete, selection moves,
  // paste) lives in @lexical/rich-text — the PROBE (scripts/lexical-probe.cjs)
  // proved a bare editor swallows every keystroke: core Lexical intercepts
  // beforeinput but nobody answers INSERT_TEXT without this plugin.
  void registerRichText(editor);
  // Paste is OURS entirely (the no-rich-HTML discipline): files go to the
  // attachment staging callback, text/plain enters through the plain
  // inserter — rich-text's own paste handler never runs (a higher priority
  // returns true first).
  void editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      // the payload is the DOM paste ClipboardEvent (0.53 types it as an
      // InputEvent union — the runtime object carries clipboardData)
      const clipboard = (event as ClipboardEvent).clipboardData;
      const files = [...clipboard?.files ?? []];
      if (files.length > 0) {
        event.preventDefault();
        onPasteFiles(files);
        return true;
      }
      const pastedText = clipboard?.getData("text/plain") ?? "";
      if (pastedText.length > 0) {
        event.preventDefault();
        insertPlainText(editor, pastedText);
        return true;
      }
      return false;
    },
    COMMAND_PRIORITY_CRITICAL,
  );
  // FORMAT_TEXT_COMMAND: rich-text registers a handler, but 0.53's
  // RangeSelection.formatText proved unreliable on a range that already
  // carries the format — our own explicit semantics run first instead:
  // - a COLLAPSED caret toggles the selection's FLOWING format (everything
  //   typed next inherits it — Discord's typing toggle);
  // - a RANGE is split at its edges (selection.extract), every fragment is
  //   set-or-cleared uniformly (all-fragments-have-it ⇒ clear), and the
  //   selection is restored over the fragments so a second press unwraps.
  void editor.registerCommand(
    FORMAT_TEXT_COMMAND,
    (format) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return;
        }
        if (selection.isCollapsed()) {
          // the canonical collapsed path — toggles the selection's own
          // flowing format (everything typed next inherits it)
          selection.formatText(format);
          return;
        }
        const fragments = selection.extract().filter((node): node is TextNode => $isTextNode(node));
        if (fragments.length === 0) {
          return;
        }
        const clearIt = fragments.every((fragment) => fragment.hasFormat(format));
        for (const fragment of fragments) {
          if (fragment.hasFormat(format) === clearIt) {
            fragment.toggleFormat(format);
          }
        }
        const first = fragments[0]!;
        const last = fragments[fragments.length - 1]!;
        const restored = $createRangeSelection();
        restored.anchor.set(first.getKey(), 0, "text");
        restored.focus.set(last.getKey(), last.getTextContent().length, "text");
        $setSelection(restored);
      }, { discrete: true });
      return true;
    },
    COMMAND_PRIORITY_CRITICAL,
  );
  return editor;
}

/** A formatting action for the LIVE selection: the native bits go through
 * FORMAT_TEXT_COMMAND (which also toggles a COLLAPSED caret's flowing format —
 * Lexical's selection format, the Discord typing toggle); the spoiler
 * wraps/unwraps the selected nodes. Returns false when the marker has no live
 * action (the caller falls back to the model wrap). */
export function applyLiveFormatCommand(editor: LexicalEditor, marker: string): boolean {
  if (marker === "||") {
    editor.focus();
    toggleSpoilerSelection(editor);
    return true;
  }
  const nativeFormat = NATIVE_TEXT_FORMAT_OF_MARKER[marker];
  if (nativeFormat === undefined) {
    return false;
  }
  editor.focus();
  editor.dispatchCommand(FORMAT_TEXT_COMMAND, nativeFormat);
  return true;
}

/** Wraps the selection's text nodes in SpoilerTextNode (or unwraps when every
 * selected node is already a spoiler). A collapsed caret is a no-op — the
 * spoiler has no native bit, so it cannot flow like bold; it needs a
 * selection. */
export function toggleSpoilerSelection(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || selection.isCollapsed()) {
      return;
    }
    const extracted = selection.extract(); // splits partial nodes at the edges
    const replacements: LexicalNode[] = [];
    for (const node of extracted) {
      if ($isSpoilerNode(node)) {
        const plain = $createTextNode(node.getTextContent());
        plain.setFormat(node.getFormat());
        node.replace(plain);
        replacements.push(plain);
      } else if ($isTextNode(node)) {
        const spoiler = new SpoilerTextNode(node.getTextContent());
        spoiler.setFormat(node.getFormat());
        node.replace(spoiler);
        replacements.push(spoiler);
      }
      // line breaks pass through unwrapped — a marker pair may not span one
    }
    const first = replacements[0];
    const last = replacements[replacements.length - 1];
    if (first !== undefined && last !== undefined) {
      const restored = $createRangeSelection();
      restored.anchor.set(first.getKey(), 0, "text");
      restored.focus.set(last.getKey(), last.getTextContent().length, "text");
      $setSelection(restored);
    }
  }, { discrete: true });
}

/** Inserts plain (possibly multi-line) text at the live selection — the paste
 * path (no rich HTML ever enters the editor). */
export function insertPlainText(editor: LexicalEditor, value: string): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return;
    }
    const nodes: LexicalNode[] = [];
    value.split("\n").forEach((part, partIndex) => {
      if (partIndex > 0) {
        nodes.push($createLineBreakNode());
      }
      if (part.length > 0) {
        nodes.push($createTextNode(part));
      }
    });
    if (nodes.length > 0) {
      selection.insertNodes(nodes);
    }
  }, { discrete: true });
}
