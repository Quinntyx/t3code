import { getSchemaByResolvedExtensions, resolveExtensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import { ComposerScratchImageExtension } from "~/composer-rich-text-doc";
import {
  createScratchArmPlugin,
  SCRATCH_ARM_BYPASS_META,
  scratchArmKey,
  snapSelectionToBlocks,
  type ScratchArmedRange,
} from "./ScratchArmPlugin";

const schema = getSchemaByResolvedExtensions(
  resolveExtensions([StarterKit, ComposerScratchImageExtension]),
);

function stateWith(markdown: string): EditorState {
  const paragraphs = markdown
    .split("\n\n")
    .map((text) => schema.node("paragraph", null, [schema.text(text)]));
  return EditorState.create({
    schema,
    doc: schema.node("doc", null, paragraphs),
    plugins: [createScratchArmPlugin()],
  });
}

function arm(
  state: EditorState,
  from: number,
  to: number,
): { state: EditorState; armed: ScratchArmedRange } {
  const armed = snapSelectionToBlocks(state.doc, from, to)!;
  return {
    armed,
    state: state.apply(
      state.tr
        .setMeta(scratchArmKey, { type: "arm", armed })
        .setMeta(SCRATCH_ARM_BYPASS_META, true),
    ),
  };
}

describe("snapSelectionToBlocks", () => {
  it("expands a partial selection to whole paragraphs", () => {
    const state = stateWith("alpha\n\nbeta");
    expect(snapSelectionToBlocks(state.doc, 2, 5)).toEqual({ from: 0, to: 7 });
  });

  it("excludes the block a triple-click lands on at offset zero", () => {
    const state = stateWith("alpha\n\nbeta");
    expect(snapSelectionToBlocks(state.doc, 1, 7)).toEqual({ from: 0, to: 7 });
  });

  it("snaps a NodeSelection on a standalone scratchImage atom block", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("before")]),
      schema.node("scratchImage", { attachmentId: "scratch-1", alt: "shot" }),
      schema.node("paragraph", null, [schema.text("after")]),
    ]);
    const selection = NodeSelection.create(doc, 8);
    expect(snapSelectionToBlocks(doc, selection.from, selection.to)).toEqual({ from: 8, to: 9 });
  });
});

describe("createScratchArmPlugin", () => {
  it("rejects document changes outside the armed chunk and across its outer boundary", () => {
    const armedState = arm(stateWith("alpha\n\nbeta"), 1, 6).state;
    const outsideInsert = armedState.tr.insertText("X", armedState.doc.content.size - 1);
    expect(armedState.apply(outsideInsert)).toBe(armedState);

    const mergeAcrossBoundary = armedState.tr.delete(6, 8);
    expect(armedState.apply(mergeAcrossBoundary)).toBe(armedState);
  });

  it("allows document changes inside the armed chunk and grows the armed range", () => {
    const armedState = arm(stateWith("alpha\n\nbeta"), 1, 6).state;
    const next = armedState.apply(armedState.tr.insertText("X", 2));
    expect(next.doc.textContent).toContain("aXlpha");
    expect(scratchArmKey.getState(next)?.armed).toEqual({ from: 0, to: 8 });
  });

  it("clamps a selection that tries to leave the armed chunk", () => {
    const { state, armed } = arm(stateWith("alpha\n\nbeta"), 1, 6);
    const next = state.applyTransaction(
      state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)),
    ).state;
    expect(next.selection.to).toBe(armed.to - 1);
  });

  it("maps inactive caret positions across edits and clears them when armed", () => {
    const base = stateWith("alpha\n\nbeta");
    const withCaret = base.apply(
      base.tr
        .setMeta(scratchArmKey, { type: "inactive-caret", inactiveCaretPos: 4 })
        .setMeta(SCRATCH_ARM_BYPASS_META, true),
    );
    const edited = withCaret.apply(withCaret.tr.insertText("12", 1));
    expect(scratchArmKey.getState(edited)?.inactiveCaretPos).toBe(6);

    const armed = arm(edited, 1, 5).state;
    expect(scratchArmKey.getState(armed)?.inactiveCaretPos).toBeNull();
  });

  it("allows editing inside a partially armed list item while blocking sibling list items", () => {
    const doc = schema.node("doc", null, [
      schema.node("bulletList", null, [
        schema.node("listItem", null, [schema.node("paragraph", null, [schema.text("first")])]),
        schema.node("listItem", null, [schema.node("paragraph", null, [schema.text("second")])]),
      ]),
    ]);
    const baseState = EditorState.create({
      schema,
      doc,
      plugins: [createScratchArmPlugin()],
    });
    // Positions inside "first": bulletList(0) -> listItem(1) -> paragraph(2) -> "first"(3..8)
    const { state: armedState, armed } = arm(baseState, 3, 6);
    expect(armed).toEqual({ from: 1, to: 10 });

    const insideEdit = armedState.apply(armedState.tr.insertText("!", 8));
    expect(insideEdit.doc.textContent).toContain("first!");
    expect(scratchArmKey.getState(insideEdit)?.armed).toEqual({ from: 1, to: 11 });

    // Positions inside "second": listItem(10) -> paragraph(11) -> "second"(12..18)
    const outsideEdit = armedState.apply(armedState.tr.insertText("!", 13));
    expect(outsideEdit).toBe(armedState);
  });

  it("snaps a selection spanning a parent list item and its nested sublist item to the parent list item", () => {
    const doc = schema.node("doc", null, [
      schema.node("bulletList", null, [
        schema.node("listItem", null, [
          schema.node("paragraph", null, [schema.text("parent")]),
          schema.node("bulletList", null, [
            schema.node("listItem", null, [schema.node("paragraph", null, [schema.text("child")])]),
          ]),
        ]),
        schema.node("listItem", null, [schema.node("paragraph", null, [schema.text("sibling")])]),
      ]),
    ]);
    const baseState = EditorState.create({
      schema,
      doc,
      plugins: [createScratchArmPlugin()],
    });
    const parentEnd = doc.firstChild!.firstChild!.nodeSize + 1;
    // Select from inside "parent" (pos 4) into inside "child" (pos 14).
    const { state: armedState, armed } = arm(baseState, 4, 14);
    expect(armed).toEqual({ from: 1, to: parentEnd });

    // Editing inside the armed nested sublist item succeeds; editing "sibling" is blocked.
    const nestedEdit = armedState.apply(armedState.tr.insertText("!", 14));
    expect(nestedEdit.doc.textContent).toContain("c!hild");

    const siblingPos = parentEnd + 3;
    const siblingEdit = armedState.apply(armedState.tr.insertText("!", siblingPos));
    expect(siblingEdit).toBe(armedState);
  });

  it("releases the arm on request", () => {
    const armedState = arm(stateWith("alpha\n\nbeta"), 1, 6).state;
    const released = armedState.apply(
      armedState.tr
        .setMeta(scratchArmKey, { type: "release" })
        .setMeta(SCRATCH_ARM_BYPASS_META, true),
    );
    expect(scratchArmKey.getState(released)?.armed).toBeNull();
  });

  it("keeps clamping past a trailing armed scratchImage on the image instead of selecting the whole chunk", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("alpha")]),
      schema.node("scratchImage", { attachmentId: "scratch-2", alt: "shot" }),
      schema.node("paragraph", null, [schema.text("outside")]),
    ]);
    const baseState = EditorState.create({
      schema,
      doc,
      plugins: [createScratchArmPlugin()],
    });
    // Arm [paragraph("alpha") (0..7), scratchImage (7..8)].
    const { state: armedState, armed } = arm(baseState, 1, 8);
    expect(armed).toEqual({ from: 0, to: 8 });

    // Stepping into "outside" (pos 10) clamps back onto the trailing scratchImage atom, not 1..8.
    const next = armedState.applyTransaction(
      armedState.tr.setSelection(TextSelection.create(armedState.doc, 10)),
    ).state;
    expect(next.selection).toBeInstanceOf(NodeSelection);
    expect(next.selection.from).toBe(7);
    expect(next.selection.to).toBe(8);
  });

  it("inserts a newline on Shift+Enter inside an armed codeBlock", () => {
    const doc = schema.node("doc", null, [
      schema.node("codeBlock", null, [schema.text("const a = 1;")]),
      schema.node("paragraph", null, [schema.text("after")]),
    ]);
    const plugin = createScratchArmPlugin();
    const baseState = EditorState.create({
      schema,
      doc,
      plugins: [plugin],
    });
    const { state: armedState } = arm(baseState, 1, 12);
    const positioned = armedState.apply(
      armedState.tr.setSelection(TextSelection.create(armedState.doc, 7)),
    );
    let dispatched: EditorState = positioned;
    const fakeView = {
      get state() {
        return dispatched;
      },
      dispatch(tr: EditorState["tr"]) {
        dispatched = dispatched.apply(tr);
      },
    } as never;
    const handled = plugin.props.handleKeyDown!.call(plugin, fakeView, {
      key: "Enter",
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      isComposing: false,
      preventDefault: () => {},
    } as KeyboardEvent);
    expect(handled).toBe(true);
    expect(dispatched.doc.firstChild?.textContent).toBe("const \na = 1;");
  });
});
