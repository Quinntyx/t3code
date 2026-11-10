import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTokenTrigger,
  detectComposerTrigger,
  parseSideChatCommand,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("keeps a slash in the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
  });

  it.each(["/Model opus", "/MODEL opus"])(
    "opens the model picker for capitalized %j the same as /model",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toMatchObject({
        kind: "slash-model",
        query: "opus",
      });
    },
  );

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "𑿝"])("detects %s skill prefixes and their source range", (prefix) => {
    const text = `Use ${prefix}review`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "skill",
      query: "review",
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each([
    "It costs $5",
    "is it $5?",
    "budget $9.99",
    "only $.99",
    "about €20",
    "raise $10k",
    "$1,000",
    "£2e6",
    "raise $10k.",
  ])("does not open the skill menu for the amount in %j", (text) =>
    expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "$1password", "$2fa"])("still detects the skill prefix %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toMatchObject({
      kind: "skill",
      query: text.slice(1),
    });
  });
  it.each(["Compare with %", "Compare with %auth"])("detects the thread trigger in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "thread",
      query: text.slice("Compare with %".length),
      rangeStart: "Compare with ".length,
      rangeEnd: text.length,
    });
  });

  it.each(["50%", "Open %APPDATA%", "Use %auth "])("does not open the thread menu for %j", (text) =>
    expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );
});

describe("detectComposerTokenTrigger", () => {
  it("reads only the word at the cursor, so /model arguments close the menu", () => {
    expect(detectComposerTokenTrigger("/model spark", "/model spark".length)).toBeNull();
    expect(detectComposerTokenTrigger("/model", "/model".length)).toEqual({
      kind: "slash-command",
      query: "model",
      rangeStart: 0,
      rangeEnd: "/model".length,
    });
  });

  it.each(["Use ", "Use\t", "Use\n  "])("detects inline slash skills after %j", (prefix) => {
    const text = `${prefix}/skill:review later`;
    const cursor = `${prefix}/skill:review`.length;
    expect(detectComposerTokenTrigger(text, cursor)).toEqual({
      kind: "slash-command",
      query: "skill:review",
      rangeStart: prefix.length,
      rangeEnd: cursor,
    });
  });

  it("detects a pull request number at a token boundary, not in headings or words", () => {
    const text = "Compare this with #8737";
    expect(detectComposerTokenTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "8737",
      rangeStart: "Compare this with ".length,
      rangeEnd: text.length,
    });
    expect(detectComposerTokenTrigger("# Heading", "# Heading".length)).toBeNull();
    expect(detectComposerTokenTrigger("issue#123", "issue#123".length)).toBeNull();
  });

  // regression: #936 @file autocomplete used the wrong cursor when typing mid-text
  it("detects @path trigger in the middle of existing text", () => {
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;
    expect(detectComposerTokenTrigger(text, cursorAfterAt)).toEqual({
      kind: "path",
      query: "",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterAt,
    });
  });
});

describe("serializeComposerFileLink", () => {
  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("parseSideChatCommand", () => {
  it("reads an optional prompt after /side or /btw", () => {
    expect(parseSideChatCommand("/side")).toEqual({ prompt: "" });
    expect(parseSideChatCommand("  /SIDE  why does this fail?\nline two ")).toEqual({
      prompt: "why does this fail?\nline two",
    });
    expect(parseSideChatCommand("/btw check @src/a.ts")).toEqual({ prompt: "check @src/a.ts" });
  });

  it("ignores other commands and inline mentions", () => {
    expect(parseSideChatCommand("/sidebar")).toBeNull();
    expect(parseSideChatCommand("/btwx")).toBeNull();
    expect(parseSideChatCommand("ask /side later")).toBeNull();
  });
});
