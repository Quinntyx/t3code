import { describe, expect, it } from "vite-plus/test";

import {
  extractScratchImageIds,
  formatScratchImageMarkdown,
  insertQuickDraftIntoScratch,
  mergeScratchMarkdown3Way,
  parseScratchImageLine,
  removeScratchMarkdownRange,
  scratchChunkPreviewTitle,
  splitScratchMarkdownBlocks,
  stripScratchImagesForPrompt,
} from "./scratchDocument.ts";

const image = (id: string, alt = "") => formatScratchImageMarkdown(id, alt);

describe("scratch image markdown", () => {
  it("round-trips an attachment id and alt text", () => {
    const markdown = formatScratchImageMarkdown("img_1", "a [bracketed] name");

    expect(markdown).toBe("![a \\[bracketed\\] name](t3-scratch-image://img_1)");
    expect(parseScratchImageLine(markdown)).toEqual({
      attachmentId: "img_1",
      alt: "a [bracketed] name",
    });
  });

  it("flattens newlines in alt text so the image stays one line", () => {
    const markdown = formatScratchImageMarkdown("img_1", "line one\nline two");

    expect(markdown).toBe("![line one line two](t3-scratch-image://img_1)");
    expect(parseScratchImageLine(markdown)?.alt).toBe("line one line two");
  });

  it("only matches a standalone image line", () => {
    expect(parseScratchImageLine("  ![alt](t3-scratch-image://abc-1)  ")).toEqual({
      attachmentId: "abc-1",
      alt: "alt",
    });
    expect(parseScratchImageLine("before ![alt](t3-scratch-image://abc-1)")).toBeNull();
    expect(parseScratchImageLine("![alt](https://example.com/a.png)")).toBeNull();
    expect(parseScratchImageLine("![alt](t3-scratch-image://abc 1)")).toBeNull();
  });
});

describe("extractScratchImageIds", () => {
  it("returns unique ids in document order", () => {
    const markdown = [
      image("first"),
      "",
      "Some prose.",
      "",
      image("second", "a picture"),
      image("first"),
    ].join("\n");

    expect(extractScratchImageIds(markdown)).toEqual(["first", "second"]);
  });

  it("ignores fenced code blocks and inline tokens", () => {
    const markdown = [
      image("real"),
      "",
      "```md",
      image("fenced"),
      "```",
      "",
      "~~~",
      image("tilde"),
      "~~~",
      "",
      `Inline ${image("inline")} inside a paragraph.`,
    ].join("\n");

    expect(extractScratchImageIds(markdown)).toEqual(["real"]);
  });
});

describe("splitScratchMarkdownBlocks", () => {
  const markdown = [
    "# Title",
    "",
    image("first"),
    "",
    "```ts",
    "const a = 1;",
    "",
    "```",
    "",
    "* one",
    "* two",
  ].join("\n");

  it("splits blocks with exact offsets into the markdown", () => {
    const blocks = splitScratchMarkdownBlocks(markdown);

    expect(
      blocks.map((block) =>
        block.kind === "image" ? `image:${block.attachmentId}` : block.markdown,
      ),
    ).toEqual(["# Title", "image:first", "```ts\nconst a = 1;\n\n```", "* one", "* two"]);
    for (const block of blocks) {
      expect(markdown.slice(block.startOffset, block.endOffset)).toBe(block.markdown);
      expect(block.id.startsWith("scratch-block-")).toBe(true);
    }
  });

  it("removes a single list item cleanly while keeping remaining items tight", () => {
    const list = "- first\n- second\n- third";
    const blocks = splitScratchMarkdownBlocks(list);
    expect(blocks.map((b) => b.markdown)).toEqual(["- first", "- second", "- third"]);
    const removed = removeScratchMarkdownRange({
      markdown: list,
      startOffset: blocks[1]!.startOffset,
      endOffset: blocks[1]!.endOffset,
    });
    expect(removed.nextMarkdown).toBe("- first\n- third");
  });

  it("keeps fenced code blocks intact and reports image alt text", () => {
    const blocks = splitScratchMarkdownBlocks(
      ["```", "", "# not a heading", "```", "", image("x", "cover")].join("\n"),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.markdown).toBe("```\n\n# not a heading\n```");
    expect(blocks[1]).toMatchObject({ kind: "image", attachmentId: "x", alt: "cover" });
  });

  it("reconstructs the document content by joining blocks", () => {
    const blocks = splitScratchMarkdownBlocks(markdown);
    const rebuilt = blocks.map((block) => block.markdown).join("\n\n");

    expect(rebuilt.replace(/\n{2,}/g, "\n")).toBe(markdown.replace(/\n{2,}/g, "\n"));
  });

  it("returns no blocks for an empty document", () => {
    expect(splitScratchMarkdownBlocks("")).toEqual([]);
    expect(splitScratchMarkdownBlocks("\n \n\n")).toEqual([]);
  });
});

describe("stripScratchImagesForPrompt", () => {
  it("removes image lines and keeps surrounding prose apart", () => {
    const markdown = [
      "First paragraph.",
      "",
      image("one", "diagram"),
      "",
      "Second paragraph.",
      "",
      image("two"),
    ].join("\n");

    expect(stripScratchImagesForPrompt(markdown)).toEqual({
      prompt: "First paragraph.\n\nSecond paragraph.",
      attachmentIds: ["one", "two"],
    });
  });

  it("returns an empty prompt for an image-only chunk", () => {
    expect(stripScratchImagesForPrompt(image("only"))).toEqual({
      prompt: "",
      attachmentIds: ["only"],
    });
  });

  it("strips non-fenced image tokens while preserving fenced code blocks verbatim", () => {
    const markdown = [
      "```ts",
      `// ${image("fenced")}`,
      "```",
      "",
      `Inline ${image("inline")}.`,
    ].join("\n");
    const { prompt, attachmentIds } = stripScratchImagesForPrompt(markdown);

    expect(prompt).toContain(`// ${image("fenced")}`);
    expect(prompt).not.toContain("t3-scratch-image://inline");
    expect(attachmentIds).toEqual([]);

    expect(stripScratchImagesForPrompt(`See ${image("inline-alt", "chart [1]")} now.`).prompt).toBe(
      "See chart [1] now.",
    );
  });
});

describe("insertQuickDraftIntoScratch", () => {
  it("places a quick draft in an empty document", () => {
    expect(
      insertQuickDraftIntoScratch({
        markdown: "  \n",
        cursorOffset: 2,
        insertedMarkdown: "  hello  ",
      }),
    ).toEqual({ nextMarkdown: "hello", nextCursorOffset: 5 });
  });

  it("inserts below the block holding the cursor instead of splitting the line", () => {
    const markdown = ["Line one.", "Line two.", "", "Last paragraph."].join("\n");
    const result = insertQuickDraftIntoScratch({
      markdown,
      cursorOffset: 12,
      insertedMarkdown: "Inserted.",
    });

    expect(result.nextMarkdown).toBe("Line one.\nLine two.\n\nInserted.\n\nLast paragraph.");
    expect(result.nextMarkdown.slice(0, result.nextCursorOffset).endsWith("Inserted.")).toBe(true);
  });

  it("appends after the last block when the cursor is at the end", () => {
    const result = insertQuickDraftIntoScratch({
      markdown: "Only paragraph.",
      cursorOffset: 999,
      insertedMarkdown: "New.",
    });

    expect(result).toEqual({
      nextMarkdown: "Only paragraph.\n\nNew.",
      nextCursorOffset: "Only paragraph.\n\nNew.".length,
    });
  });

  it("inserts below a whole code fence", () => {
    const markdown = ["```ts", "const a = 1;", "```"].join("\n");
    const result = insertQuickDraftIntoScratch({
      markdown,
      cursorOffset: 8,
      insertedMarkdown: "Note.",
    });

    expect(result.nextMarkdown).toBe("```ts\nconst a = 1;\n```\n\nNote.");
  });

  it("leaves the document untouched for blank input", () => {
    expect(
      insertQuickDraftIntoScratch({ markdown: "Text.", cursorOffset: 1, insertedMarkdown: "   " }),
    ).toEqual({ nextMarkdown: "Text.", nextCursorOffset: 1 });
  });
});

describe("removeScratchMarkdownRange", () => {
  it("removes a block and collapses the leftover blank lines", () => {
    const markdown = "Alpha.\n\nBeta.\n\nGamma.";
    const result = removeScratchMarkdownRange({
      markdown,
      startOffset: markdown.indexOf("Beta."),
      endOffset: markdown.indexOf("Beta.") + "Beta.".length,
    });

    expect(result).toEqual({ nextMarkdown: "Alpha.\n\nGamma.", nextCursorOffset: 8 });
  });

  it("returns the clamped cursor for an empty range", () => {
    expect(removeScratchMarkdownRange({ markdown: "abc", startOffset: 99, endOffset: 99 })).toEqual(
      {
        nextMarkdown: "abc",
        nextCursorOffset: 3,
      },
    );
  });

  it("handles a removal that empties the document", () => {
    expect(removeScratchMarkdownRange({ markdown: "Only.", startOffset: 0, endOffset: 5 })).toEqual(
      {
        nextMarkdown: "",
        nextCursorOffset: 0,
      },
    );
  });
});

describe("mergeScratchMarkdown3Way", () => {
  it("takes the side that changed", () => {
    expect(mergeScratchMarkdown3Way("base", "base", "remote")).toBe("remote");
    expect(mergeScratchMarkdown3Way("base", "local", "base")).toBe("local");
    expect(mergeScratchMarkdown3Way("base", "same", "same")).toBe("same");
  });

  it("keeps disjoint edits from both sides", () => {
    const base = ["# Plan", "Intro.", image("one")].join("\n\n");
    const local = ["# Plan", "Intro edited locally.", image("one")].join("\n\n");
    const remote = ["# Plan", "Intro.", image("one"), "Remote tail."].join("\n\n");

    expect(mergeScratchMarkdown3Way(base, local, remote)).toBe(
      ["# Plan", "Intro edited locally.", image("one"), "Remote tail."].join("\n\n"),
    );
  });

  it("preserves both texts when both sides rewrote the same span", () => {
    const base = ["Head", "Middle", "Tail"].join("\n\n");
    const merged = mergeScratchMarkdown3Way(
      base,
      ["Head", "Local", "Tail"].join("\n\n"),
      ["Head", "Remote", "Tail"].join("\n\n"),
    );

    expect(merged).toBe(["Head", "Local", "Remote", "Tail"].join("\n\n"));
  });

  it("keeps one copy when both sides made the same edit", () => {
    const base = ["Head", "Old", "Tail"].join("\n\n");
    const edited = ["Head", "New", "Tail"].join("\n\n");

    expect(mergeScratchMarkdown3Way(base, edited, edited)).toBe(edited);
  });

  it("keeps a local deletion and a remote append", () => {
    const base = ["Head", "Gone", "Tail"].join("\n\n");
    const local = ["Head", "Tail"].join("\n\n");
    const remote = ["Head", "Gone", "Tail", "Appendix"].join("\n\n");

    expect(mergeScratchMarkdown3Way(base, local, remote)).toBe(
      ["Head", "Tail", "Appendix"].join("\n\n"),
    );
  });

  it("does not duplicate an untouched anchor block on disjoint prepend and append", () => {
    expect(mergeScratchMarkdown3Way("A", "X\n\nA", "A\n\nY")).toBe("X\n\nA\n\nY");
    expect(mergeScratchMarkdown3Way("A\n\nB", "X\n\nA\n\nB", "A\n\nY\n\nB")).toBe(
      "X\n\nA\n\nY\n\nB",
    );
  });

  it("handles CRLF line endings for image extraction and fenced code blocks", () => {
    const crlf =
      "Intro\r\n\r\n![shot](t3-scratch-image://scratch-crlf)\r\n\r\n```ts\r\nconst x = 1;\r\n```\r\n\r\nAfter";
    expect(extractScratchImageIds(crlf)).toEqual(["scratch-crlf"]);
    const blocks = splitScratchMarkdownBlocks(crlf);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "image", "text", "text"]);
  });

  it("does not duplicate unchanged middle blocks in the large-document fallback", () => {
    // 2010 blocks => 2011 * 2011 = 4,044,121 > LCS_CELL_LIMIT (4,000,000), forcing mergeBlocksBySharedEdges.
    const baseBlocks = Array.from({ length: 2010 }, (_, i) => `Block ${i}`);
    const localBlocks = [...baseBlocks];
    localBlocks[1000] = "Block 1000 local";
    const remoteBlocks = [...baseBlocks];
    remoteBlocks[1000] = "Block 1000 local";
    remoteBlocks[1005] = "Block 1005 remote";

    // Identical middle change across both sides must not duplicate blocks.
    const sameEdit = mergeScratchMarkdown3Way(
      baseBlocks.join("\n\n"),
      localBlocks.join("\n\n"),
      localBlocks.join("\n\n"),
    );
    expect(sameEdit).toBe(localBlocks.join("\n\n"));

    // Only one side changed after shared prefix/suffix => no duplicate middle.
    const localOnlyDeleted = [...baseBlocks.slice(0, 500), ...baseBlocks.slice(501)];
    const mergedOneSided = mergeScratchMarkdown3Way(
      baseBlocks.join("\n\n"),
      localOnlyDeleted.join("\n\n"),
      remoteBlocks.join("\n\n"),
    );
    const mergedParts = mergedOneSided.split("\n\n");
    expect(mergedParts.filter((b) => b === "Block 0")).toHaveLength(1);
    expect(mergedParts.filter((b) => b === "Block 2009")).toHaveLength(1);
    expect(mergedOneSided).toContain("Block 1005 remote");
  });
});

describe("scratchChunkPreviewTitle", () => {
  it("uses the first text line without markdown markers", () => {
    expect(scratchChunkPreviewTitle(["## Design notes", "", "Body."].join("\n"))).toBe(
      "Design notes",
    );
    expect(scratchChunkPreviewTitle(["- [ ] Ship it", "", "Body."].join("\n"))).toBe("Ship it");
    expect(scratchChunkPreviewTitle(["> quoted idea"].join("\n"))).toBe("quoted idea");
    expect(scratchChunkPreviewTitle(["1. First step"].join("\n"))).toBe("First step");
  });

  it("skips image lines and code fences", () => {
    expect(scratchChunkPreviewTitle([image("only", "cover"), "", "Real text."].join("\n"))).toBe(
      "Real text.",
    );
    expect(
      scratchChunkPreviewTitle(["```", "code only", "```", "", "After fence."].join("\n")),
    ).toBe("After fence.");
  });

  it("truncates long lines and falls back for empty content", () => {
    const longLine = "x".repeat(200);
    const preview = scratchChunkPreviewTitle(longLine);

    expect(preview.length).toBe(81);
    expect(preview.endsWith("…")).toBe(true);
    expect(scratchChunkPreviewTitle(image("only"))).toBe("");
    expect(scratchChunkPreviewTitle("", "Untitled chunk")).toBe("Untitled chunk");
  });

  it("collapses whitespace inside the preview", () => {
    expect(scratchChunkPreviewTitle("  spaced    out   title  ")).toBe("spaced out title");
  });
});
