import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";

export const SCRATCH_ARM_BYPASS_META = "scratchArmBypass";

export interface ScratchArmedRange {
  readonly from: number;
  readonly to: number;
}

export interface ScratchArmPluginState {
  readonly armed: ScratchArmedRange | null;
  readonly inactiveCaretPos: number | null;
}

export interface ScratchArmMeta {
  readonly type: "arm" | "release" | "inactive-caret";
  readonly armed?: ScratchArmedRange | null;
  readonly inactiveCaretPos?: number | null;
}

export const scratchArmKey = new PluginKey<ScratchArmPluginState>("scratchArm");

const LIST_NODE_NAMES = new Set(["bulletList", "orderedList", "taskList"]);
const LIST_ITEM_NODE_NAMES = new Set(["listItem", "taskItem"]);

function listDepthAt($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (LIST_NODE_NAMES.has($pos.node(depth).type.name)) return depth;
  }
  return null;
}

function listItemDepthInside($pos: ResolvedPos, listDepth: number): number | null {
  for (let depth = listDepth + 1; depth <= $pos.depth; depth += 1) {
    if (LIST_ITEM_NODE_NAMES.has($pos.node(depth).type.name)) return depth;
  }
  return null;
}

/** Snaps a selection out to whole blocks so a chunk never starts or ends mid-node. */
export function snapSelectionToBlocks(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): ScratchArmedRange | null {
  if (doc.content.size === 0) return null;
  const start = Math.max(0, Math.min(from, doc.content.size));
  const end = Math.max(start, Math.min(to, doc.content.size));
  if (end <= start) return null;

  const $start = doc.resolve(start);
  const $end = doc.resolve(end);
  // Walk out of any nested block(s) whose start boundary equals `end` (e.g., triple-click
  // landing at offset 0 of a following paragraph, list item, or blockquote).
  let outerBoundary = end;
  for (let depth = $end.depth; depth >= 1; depth -= 1) {
    if (outerBoundary === $end.start(depth)) {
      outerBoundary = $end.before(depth);
    } else {
      break;
    }
  }
  const steppedBack = outerBoundary < end && outerBoundary > start;
  const effectiveEnd = steppedBack ? outerBoundary : end;
  const $effectiveEnd = doc.resolve(
    steppedBack ? Math.max(start, outerBoundary - 1) : Math.max(start, effectiveEnd),
  );

  // If both endpoints stay within a shared enclosing list, snap to whole list items instead of the whole list.
  const fromListDepth = listDepthAt($start);
  const toListDepth = listDepthAt($effectiveEnd);
  let sharedListDepth: number | null = null;
  if (fromListDepth !== null && toListDepth !== null) {
    for (let depth = Math.min(fromListDepth, toListDepth); depth >= 1; depth -= 1) {
      if (
        LIST_NODE_NAMES.has($start.node(depth).type.name) &&
        $start.before(depth) === $effectiveEnd.before(depth)
      ) {
        sharedListDepth = depth;
        break;
      }
    }
  }
  if (sharedListDepth !== null) {
    const startItemDepth = listItemDepthInside($start, sharedListDepth);
    const endItemDepth = listItemDepthInside($effectiveEnd, sharedListDepth);
    if (startItemDepth !== null && endItemDepth !== null) {
      const itemFrom = $start.before(startItemDepth);
      const itemTo = $effectiveEnd.after(endItemDepth);
      // If every item in the list is selected, snap to the enclosing list node so consumption leaves no empty marker.
      if (
        itemFrom === $start.start(sharedListDepth) &&
        itemTo === $effectiveEnd.end(sharedListDepth)
      ) {
        return {
          from: $start.before(sharedListDepth),
          to: $effectiveEnd.after(sharedListDepth),
        };
      }
      return { from: itemFrom, to: itemTo };
    }
  }

  let rangeFrom: number | null = null;
  let rangeTo: number | null = null;
  doc.forEach((node, offset) => {
    const blockFrom = offset;
    const blockTo = offset + node.nodeSize;
    // A triple-click lands at offset 0 of the next block; only include blocks strictly overlapped.
    const overlaps = blockTo > start && blockFrom < effectiveEnd;
    if (!overlaps) return;
    if (rangeFrom === null) rangeFrom = blockFrom;
    rangeTo = blockTo;
  });

  if (rangeFrom === null || rangeTo === null) return null;
  return { from: rangeFrom, to: rangeTo };
}

export function editBounds(
  doc: ProseMirrorNode,
  armed: ScratchArmedRange,
): { min: number; max: number } {
  const clampedFrom = Math.max(0, Math.min(armed.from, doc.content.size));
  const clampedTo = Math.max(clampedFrom, Math.min(armed.to, doc.content.size));
  const firstNode = doc.nodeAt(clampedFrom);
  const min =
    firstNode !== null && !firstNode.isAtom ? Math.min(clampedFrom + 1, clampedTo) : clampedFrom;
  let lastIsAtom = false;
  doc.nodesBetween(clampedFrom, clampedTo, (node, pos) => {
    if (pos + node.nodeSize === clampedTo) {
      lastIsAtom = node.isAtom;
    }
    return !node.isLeaf;
  });
  const max = !lastIsAtom ? Math.max(min, clampedTo - 1) : clampedTo;
  return { min, max };
}

function innerSelectionBounds(
  doc: ProseMirrorNode,
  armed: ScratchArmedRange,
): { from: number; to: number } {
  const { min, max } = editBounds(doc, armed);
  const startSel = Selection.near(doc.resolve(min), 1);
  const endSel = Selection.near(doc.resolve(max), -1);
  const from = startSel.from >= armed.from && startSel.from <= armed.to ? startSel.from : min;
  const to = endSel.to >= from && endSel.to <= armed.to ? endSel.to : Math.max(from, max);
  return { from, to };
}

function stepTouchesOutside(tr: Transaction, min: number, max: number): boolean {
  for (const step of tr.steps) {
    const map = step.getMap();
    let outside = false;
    map.forEach((oldStart, oldEnd) => {
      if (oldStart < min || oldEnd > max) outside = true;
    });
    if (outside) return true;
  }
  return false;
}

function selectionInsideArmed(doc: ProseMirrorNode, armed: ScratchArmedRange): Selection | null {
  const inner = innerSelectionBounds(doc, armed);
  const textRange = TextSelection.between(doc.resolve(inner.from), doc.resolve(inner.to));
  if (textRange.from >= armed.from && textRange.to <= armed.to) {
    return textRange;
  }
  const firstNode = doc.nodeAt(armed.from);
  if (firstNode !== null && NodeSelection.isSelectable(firstNode)) {
    return NodeSelection.create(doc, armed.from);
  }
  const near = Selection.near(doc.resolve(armed.from), 1);
  return near.from >= armed.from && near.to <= armed.to ? near : null;
}

function clampSelectionIntoArmed(tr: Transaction, armed: ScratchArmedRange): void {
  const { doc, selection } = tr;
  const inner = innerSelectionBounds(doc, armed);
  if (selection instanceof NodeSelection) {
    if (selection.from >= armed.from && selection.to <= armed.to) return;
  }
  if (selection.from >= inner.from && selection.to <= inner.to) return;
  const from = Math.max(inner.from, Math.min(selection.from, inner.to));
  const to = Math.max(from, Math.min(selection.to, inner.to));
  const clampingFromEnd = selection.from > inner.to;
  if (from === to && clampingFromEnd) {
    const nodeBefore = doc.resolve(armed.to).nodeBefore;
    if (nodeBefore !== null && nodeBefore.isAtom && NodeSelection.isSelectable(nodeBefore)) {
      const atomPos = armed.to - nodeBefore.nodeSize;
      if (atomPos >= armed.from) {
        tr.setSelection(NodeSelection.create(doc, atomPos));
        return;
      }
    }
  }
  const next =
    from === to
      ? Selection.near(doc.resolve(from), clampingFromEnd ? -1 : 1)
      : TextSelection.between(doc.resolve(from), doc.resolve(to));
  if (next.from >= armed.from && next.to <= armed.to) {
    tr.setSelection(next);
    return;
  }
  const fallback = selectionInsideArmed(doc, armed);
  if (fallback !== null) {
    tr.setSelection(fallback);
  }
}

function collectArmedDecorations(
  container: ProseMirrorNode,
  contentStart: number,
  armed: ScratchArmedRange,
  decorations: Decoration[],
): void {
  container.forEach((node, offset) => {
    const from = contentStart + offset;
    const to = from + node.nodeSize;
    if (from >= armed.from && to <= armed.to) {
      decorations.push(Decoration.node(from, to, { class: "scratch-block-armed" }));
      return;
    }
    if (to <= armed.from || from >= armed.to) {
      decorations.push(Decoration.node(from, to, { class: "scratch-block-readonly" }));
      return;
    }
    if (LIST_NODE_NAMES.has(node.type.name) || LIST_ITEM_NODE_NAMES.has(node.type.name)) {
      collectArmedDecorations(node, from + 1, armed, decorations);
    }
  });
}

/** Decorations mark the armed chunk, dim everything outside it, or show the inactive caret. */
function scratchArmDecorations(state: ScratchArmPluginState, doc: ProseMirrorNode): DecorationSet {
  if (state.armed === null) {
    if (state.inactiveCaretPos === null || doc.content.size === 0) return DecorationSet.empty;
    const pos = Math.max(1, Math.min(state.inactiveCaretPos, doc.content.size));
    return DecorationSet.create(doc, [
      Decoration.widget(
        pos,
        () => {
          const caret = document.createElement("span");
          caret.className = "scratch-inactive-caret";
          caret.setAttribute("aria-hidden", "true");
          return caret;
        },
        { side: 1 },
      ),
    ]);
  }

  const decorations: Decoration[] = [];
  collectArmedDecorations(doc, 0, state.armed, decorations);
  return DecorationSet.create(doc, decorations);
}

export interface ScratchArmPluginOptions {
  readonly onArmedSend?: (mode: "foreground" | "background") => void;
  readonly onRelease?: () => void;
}

export function createScratchArmPlugin(options: ScratchArmPluginOptions = {}): Plugin {
  return new Plugin<ScratchArmPluginState>({
    key: scratchArmKey,
    state: {
      init: () => ({ armed: null, inactiveCaretPos: null }),
      apply(tr, value) {
        const meta = tr.getMeta(scratchArmKey) as ScratchArmMeta | undefined;
        if (meta !== undefined) {
          if (meta.type === "arm") {
            return { armed: meta.armed ?? null, inactiveCaretPos: null };
          }
          if (meta.type === "release") {
            return { ...value, armed: null };
          }
          return { ...value, inactiveCaretPos: meta.inactiveCaretPos ?? null };
        }
        if (!tr.docChanged) return value;
        const nextInactiveCaretPos =
          value.inactiveCaretPos === null
            ? null
            : Math.max(0, Math.min(tr.mapping.map(value.inactiveCaretPos), tr.doc.content.size));
        if (value.armed === null) {
          return { armed: null, inactiveCaretPos: nextInactiveCaretPos };
        }
        const from = Math.max(
          0,
          Math.min(tr.mapping.map(value.armed.from, -1), tr.doc.content.size),
        );
        const to = Math.max(from, Math.min(tr.mapping.map(value.armed.to, 1), tr.doc.content.size));
        return {
          armed: from >= to ? null : { from, to },
          inactiveCaretPos: nextInactiveCaretPos,
        };
      },
    },
    filterTransaction(tr, state) {
      const value = scratchArmKey.getState(state);
      const bypassed = tr.getMeta(SCRATCH_ARM_BYPASS_META) === true;
      if (value?.armed == null || bypassed || !tr.docChanged) return true;
      const { min, max } = editBounds(state.doc, value.armed);
      return !stepTouchesOutside(tr, min, max);
    },
    appendTransaction(_transactions, _oldState, newState) {
      const value = scratchArmKey.getState(newState);
      if (value?.armed == null) return null;
      const armed = value.armed;
      const inner = innerSelectionBounds(newState.doc, armed);
      const { selection } = newState;
      if (
        selection instanceof NodeSelection &&
        selection.from >= armed.from &&
        selection.to <= armed.to
      ) {
        return null;
      }
      if (selection.from >= inner.from && selection.to <= inner.to) return null;
      const tr = newState.tr;
      clampSelectionIntoArmed(tr, armed);
      return tr;
    },
    props: {
      decorations(state) {
        return scratchArmDecorations(scratchArmKey.getState(state)!, state.doc);
      },
      handleKeyDown(view: EditorView, event: KeyboardEvent) {
        const value = scratchArmKey.getState(view.state);
        if (value?.armed == null) return false;
        const armed = value.armed;
        const inner = innerSelectionBounds(view.state.doc, armed);
        const { selection } = view.state;
        const mod = event.metaKey || event.ctrlKey;

        if (event.key === "Escape") {
          releaseScratchArm(view);
          options.onRelease?.();
          return true;
        }
        if (event.key === "Enter" && !event.shiftKey && !mod && !event.altKey) {
          if (event.isComposing) return false;
          event.preventDefault();
          options.onArmedSend?.("foreground");
          return true;
        }
        if (event.key === "Enter" && event.shiftKey && !mod && !event.altKey) {
          if (event.isComposing) return false;
          if (selection.$from.parent.type.name === "codeBlock") {
            event.preventDefault();
            view.dispatch(view.state.tr.insertText("\n"));
            return true;
          }
          return false;
        }
        if (event.key.toLowerCase() === "a" && mod && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          const allInArmed = selectionInsideArmed(view.state.doc, armed);
          if (allInArmed !== null) {
            view.dispatch(view.state.tr.setSelection(allInArmed));
          }
          return true;
        }

        const atStart =
          selection.from <= inner.from ||
          (selection instanceof NodeSelection && selection.from <= armed.from);
        const atEnd =
          selection.to >= inner.to ||
          (selection instanceof NodeSelection && selection.to >= armed.to);
        if (selection.empty && atStart && event.key === "Backspace") return true;
        if (selection.empty && atEnd && event.key === "Delete") return true;

        const movingBack =
          event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home";
        const movingForward =
          event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "End";
        if (
          ((selection.empty || selection instanceof NodeSelection) && atStart && movingBack) ||
          ((selection.empty || selection instanceof NodeSelection) && atEnd && movingForward)
        ) {
          return true;
        }
        const headAtStart = selection.head <= inner.from;
        const headAtEnd = selection.head >= inner.to;
        if (event.shiftKey && ((headAtStart && movingBack) || (headAtEnd && movingForward))) {
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        mousedown(view, event) {
          const value = scratchArmKey.getState(view.state);
          if (value?.armed == null) return false;
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          if (pos === undefined) {
            event.preventDefault();
            return true;
          }
          if (pos < value.armed.from || pos > value.armed.to) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
  });
}

export function armScratchSelection(view: EditorView): ScratchArmedRange | null {
  const { from, to, head } = view.state.selection;
  if (from === to) return null;
  const armed = snapSelectionToBlocks(view.state.doc, from, to);
  if (armed === null) return null;

  const tr = view.state.tr
    .setMeta(scratchArmKey, { type: "arm", armed } satisfies ScratchArmMeta)
    .setMeta(SCRATCH_ARM_BYPASS_META, true);

  // Collapse cursor inside the armed chunk at the selection head so the user can immediately
  // edit or press Enter to send without accidentally overwriting the highlighted text.
  const firstNode = view.state.doc.nodeAt(armed.from);
  if (firstNode !== null && firstNode.isAtom && armed.from + firstNode.nodeSize === armed.to) {
    tr.setSelection(NodeSelection.create(view.state.doc, armed.from));
  } else {
    const inner = innerSelectionBounds(view.state.doc, armed);
    const caretPos = Math.max(inner.from, Math.min(head, inner.to));
    const nextSel = Selection.near(view.state.doc.resolve(caretPos), -1);
    if (nextSel.from >= armed.from && nextSel.to <= armed.to) {
      tr.setSelection(nextSel);
    }
  }

  view.dispatch(tr);
  return armed;
}

export function releaseScratchArm(view: EditorView): void {
  view.dispatch(
    view.state.tr
      .setMeta(scratchArmKey, { type: "release" } satisfies ScratchArmMeta)
      .setMeta(SCRATCH_ARM_BYPASS_META, true),
  );
}
