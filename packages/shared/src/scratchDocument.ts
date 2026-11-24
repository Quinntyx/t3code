/**
 * Pure markdown engine for the per-project scratch space. The stored format is canonical
 * markdown plus standalone image lines pointing at scratch attachments.
 */

const SCRATCH_IMAGE_SCHEME = "t3-scratch-image://";

const IMAGE_LINE_PATTERN =
  /^[ \t]*!\[((?:[^\]\\\n]|\\.)*)\]\(t3-scratch-image:\/\/([a-zA-Z0-9_-]+)\)[ \t]*$/;
const ANY_IMAGE_TOKEN_PATTERN = /!\[((?:[^\]\\\n]|\\.)*)\]\(t3-scratch-image:\/\/[a-zA-Z0-9_-]+\)/g;
const BARE_IMAGE_URL_PATTERN = /t3-scratch-image:\/\/[a-zA-Z0-9_-]*/g;
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM_START_PATTERN = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/;
const PREVIEW_MAX_CHARS = 80;

interface Fence {
  readonly marker: "`" | "~";
  readonly length: number;
}

interface SourceLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export type ScratchMarkdownBlock =
  | {
      readonly id: string;
      readonly kind: "text";
      readonly markdown: string;
      readonly startOffset: number;
      readonly endOffset: number;
    }
  | {
      readonly id: string;
      readonly kind: "image";
      readonly markdown: string;
      readonly attachmentId: string;
      readonly alt: string;
      readonly startOffset: number;
      readonly endOffset: number;
    };

function toLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      const textEnd = index > start && markdown[index - 1] === "\r" ? index - 1 : index;
      lines.push({ text: markdown.slice(start, textEnd), start, end: index });
      start = index + 1;
    }
  }
  const finalEnd =
    markdown.length > start && markdown[markdown.length - 1] === "\r"
      ? markdown.length - 1
      : markdown.length;
  lines.push({ text: markdown.slice(start, finalEnd), start, end: markdown.length });
  return lines;
}

function escapeImageAlt(alt: string): string {
  return alt
    .replace(/\r\n?|\n/g, " ")
    .replace(/[\\[\]]/g, (character) => `\\${character}`)
    .trim();
}

function unescapeImageAlt(alt: string): string {
  return alt.replace(/\\([\\[\]])/g, "$1");
}

function fenceOpeningOf(line: string): Fence | null {
  const match = FENCE_PATTERN.exec(line);
  if (match === null) return null;
  const fence = match[1]!;
  const marker = fence[0] as "`" | "~";
  // A backtick fence's info string cannot hold a backtick, so this line is inline code.
  if (marker === "`" && match[2]!.includes("`")) return null;
  return { marker, length: fence.length };
}

function isFenceClosing(line: string, fence: Fence): boolean {
  const match = FENCE_CLOSE_PATTERN.exec(line);
  return match !== null && match[1]![0] === fence.marker && match[1]!.length >= fence.length;
}

function clampOffset(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

export function formatScratchImageMarkdown(attachmentId: string, alt = ""): string {
  return `![${escapeImageAlt(alt)}](${SCRATCH_IMAGE_SCHEME}${attachmentId})`;
}

export function parseScratchImageLine(
  line: string,
): { readonly attachmentId: string; readonly alt: string } | null {
  const match = IMAGE_LINE_PATTERN.exec(line);
  if (match === null) return null;
  return { attachmentId: match[2]!, alt: unescapeImageAlt(match[1]!) };
}

export function extractScratchImageIds(markdown: string): ReadonlyArray<string> {
  const attachmentIds: string[] = [];
  const seen = new Set<string>();
  let fence: Fence | null = null;
  for (const line of toLines(markdown)) {
    if (fence !== null) {
      if (isFenceClosing(line.text, fence)) fence = null;
      continue;
    }
    const opening = fenceOpeningOf(line.text);
    if (opening !== null) {
      fence = opening;
      continue;
    }
    const image = parseScratchImageLine(line.text);
    if (image === null || seen.has(image.attachmentId)) continue;
    seen.add(image.attachmentId);
    attachmentIds.push(image.attachmentId);
  }
  return attachmentIds;
}

export function splitScratchMarkdownBlocks(markdown: string): ReadonlyArray<ScratchMarkdownBlock> {
  const lines = toLines(markdown);
  const blocks: ScratchMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.text.trim().length === 0) {
      index += 1;
      continue;
    }

    const image = parseScratchImageLine(line.text);
    if (image !== null) {
      blocks.push({
        id: `scratch-block-${blocks.length}`,
        kind: "image",
        markdown: markdown.slice(line.start, line.end),
        attachmentId: image.attachmentId,
        alt: image.alt,
        startOffset: line.start,
        endOffset: line.end,
      });
      index += 1;
      continue;
    }

    const fence = fenceOpeningOf(line.text);
    if (fence !== null) {
      let last = index;
      let cursor = index + 1;
      let closed = false;
      while (cursor < lines.length) {
        if (isFenceClosing(lines[cursor]!.text, fence)) {
          last = cursor;
          closed = true;
          cursor += 1;
          break;
        }
        last = cursor;
        cursor += 1;
      }
      const endLine = lines[last]!;
      blocks.push({
        id: `scratch-block-${blocks.length}`,
        kind: "text",
        markdown: markdown.slice(line.start, endLine.end),
        startOffset: line.start,
        endOffset: endLine.end,
      });
      index = closed ? cursor : lines.length;
      continue;
    }

    let last = index;
    let cursor = index + 1;
    const isListItem = LIST_ITEM_START_PATTERN.test(line.text);
    while (cursor < lines.length) {
      const next = lines[cursor]!;
      if (next.text.trim().length === 0) break;
      if (fenceOpeningOf(next.text) !== null || parseScratchImageLine(next.text) !== null) break;
      if (LIST_ITEM_START_PATTERN.test(next.text)) break;
      if (isListItem && !/^[ \t]+/.test(next.text)) break;
      last = cursor;
      cursor += 1;
    }
    const endLine = lines[last]!;
    blocks.push({
      id: `scratch-block-${blocks.length}`,
      kind: "text",
      markdown: markdown.slice(line.start, endLine.end),
      startOffset: line.start,
      endOffset: endLine.end,
    });
    index = cursor;
  }

  return blocks;
}

export function stripScratchImagesForPrompt(markdown: string): {
  readonly prompt: string;
  readonly attachmentIds: ReadonlyArray<string>;
} {
  const attachmentIds = extractScratchImageIds(markdown);
  const keptLines: string[] = [];
  let fence: Fence | null = null;

  for (const line of toLines(markdown)) {
    if (fence !== null) {
      if (isFenceClosing(line.text, fence)) fence = null;
      keptLines.push(line.text);
      continue;
    }
    const opening = fenceOpeningOf(line.text);
    if (opening !== null) {
      fence = opening;
      keptLines.push(line.text);
      continue;
    }
    // A blank placeholder keeps the surrounding paragraphs apart after the collapse below.
    if (parseScratchImageLine(line.text) !== null) {
      keptLines.push("");
    } else {
      keptLines.push(
        line.text
          .replace(ANY_IMAGE_TOKEN_PATTERN, (_match, alt: string) => unescapeImageAlt(alt))
          .replace(BARE_IMAGE_URL_PATTERN, ""),
      );
    }
  }

  const prompt = keptLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { prompt, attachmentIds };
}

function resolveInsertBelowOffset(markdown: string, cursorOffset: number): number {
  const containing = splitScratchMarkdownBlocks(markdown).find(
    (block) => cursorOffset >= block.startOffset && cursorOffset <= block.endOffset,
  );
  if (containing !== undefined) return containing.endOffset;
  const lineEnd = markdown.indexOf("\n", cursorOffset);
  return lineEnd === -1 ? markdown.length : lineEnd;
}

export function insertQuickDraftIntoScratch(input: {
  readonly markdown: string;
  readonly cursorOffset: number;
  readonly insertedMarkdown: string;
}): { readonly nextMarkdown: string; readonly nextCursorOffset: number } {
  const markdown = input.markdown;
  const cursorOffset = clampOffset(input.cursorOffset, 0, markdown.length);
  const inserted = input.insertedMarkdown.trim();
  if (inserted.length === 0) return { nextMarkdown: markdown, nextCursorOffset: cursorOffset };
  if (markdown.trim().length === 0) {
    return { nextMarkdown: inserted, nextCursorOffset: inserted.length };
  }

  const insertAt = resolveInsertBelowOffset(markdown, cursorOffset);
  const before = markdown.slice(0, insertAt).replace(/\s+$/, "");
  const after = markdown.slice(insertAt).replace(/^\s+/, "");
  const parts = [before, inserted, after].filter((part) => part.length > 0);

  return {
    nextMarkdown: parts.join("\n\n"),
    nextCursorOffset: (before.length > 0 ? before.length + 2 : 0) + inserted.length,
  };
}

export function removeScratchMarkdownRange(input: {
  readonly markdown: string;
  readonly startOffset: number;
  readonly endOffset: number;
}): { readonly nextMarkdown: string; readonly nextCursorOffset: number } {
  const length = input.markdown.length;
  const start = clampOffset(Math.min(input.startOffset, input.endOffset), 0, length);
  const end = clampOffset(Math.max(input.startOffset, input.endOffset), 0, length);
  if (start === end) return { nextMarkdown: input.markdown, nextCursorOffset: start };

  const dropDuplicateNewline =
    start > 0 && input.markdown[start - 1] === "\n" && end < length && input.markdown[end] === "\n";
  const joined = `${input.markdown.slice(0, start)}${input.markdown.slice(dropDuplicateNewline ? end + 1 : end)}`;
  const nextMarkdown = joined
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");

  return { nextMarkdown, nextCursorOffset: Math.min(start, nextMarkdown.length) };
}

function blockMarkdowns(markdown: string): ReadonlyArray<string> {
  return splitScratchMarkdownBlocks(markdown).map((block) => block.markdown);
}

function blocksEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) return false;
  return left.every((block, index) => block === right[index]);
}

const LCS_CELL_LIMIT = 4_000_000;

/** Maps each block index in `base` to the block index it was kept at in `other`. */
function commonBlockMatches(
  base: ReadonlyArray<string>,
  other: ReadonlyArray<string>,
): Map<number, number> | null {
  const rows = base.length + 1;
  const columns = other.length + 1;
  if (rows * columns > LCS_CELL_LIMIT) return null;

  const lengths = new Uint32Array(rows * columns);
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      lengths[row * columns + column] =
        base[row - 1] === other[column - 1]
          ? lengths[(row - 1) * columns + column - 1]! + 1
          : Math.max(lengths[(row - 1) * columns + column]!, lengths[row * columns + column - 1]!);
    }
  }

  const matches = new Map<number, number>();
  let row = base.length;
  let column = other.length;
  while (row > 0 && column > 0) {
    if (base[row - 1] === other[column - 1]) {
      matches.set(row - 1, column - 1);
      row -= 1;
      column -= 1;
    } else if (lengths[(row - 1) * columns + column]! >= lengths[row * columns + column - 1]!) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return matches;
}

function findBlockSubsequence(
  haystack: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

function mergeBlockSpan(
  result: string[],
  baseChunk: ReadonlyArray<string>,
  localChunk: ReadonlyArray<string>,
  remoteChunk: ReadonlyArray<string>,
): void {
  if (blocksEqual(localChunk, baseChunk)) {
    result.push(...remoteChunk);
    return;
  }
  if (blocksEqual(remoteChunk, baseChunk)) {
    result.push(...localChunk);
    return;
  }
  if (blocksEqual(localChunk, remoteChunk)) {
    result.push(...localChunk);
    return;
  }
  // If one side deleted the base span cleanly and the other kept it intact while inserting around it,
  // honor the deletion and keep the newly inserted blocks without resurrecting the deleted span.
  if (baseChunk.length > 0 && remoteChunk.length === 0) {
    const matchIndex = findBlockSubsequence(localChunk, baseChunk);
    if (matchIndex >= 0) {
      result.push(
        ...localChunk.slice(0, matchIndex),
        ...localChunk.slice(matchIndex + baseChunk.length),
      );
      return;
    }
  }
  if (baseChunk.length > 0 && localChunk.length === 0) {
    const matchIndex = findBlockSubsequence(remoteChunk, baseChunk);
    if (matchIndex >= 0) {
      result.push(
        ...remoteChunk.slice(0, matchIndex),
        ...remoteChunk.slice(matchIndex + baseChunk.length),
      );
      return;
    }
  }
  // Both sides rewrote this span, so keep both: losing user text is worse than a duplicate.
  result.push(...localChunk, ...remoteChunk);
}

function mergeBlocksByDiff3(
  base: ReadonlyArray<string>,
  local: ReadonlyArray<string>,
  remote: ReadonlyArray<string>,
): string[] {
  const toLocal = commonBlockMatches(base, local);
  const toRemote = commonBlockMatches(base, remote);
  if (toLocal === null || toRemote === null) return mergeBlocksBySharedEdges(base, local, remote);

  const result: string[] = [];
  let baseIndex = 0;
  let localIndex = 0;
  let remoteIndex = 0;

  while (baseIndex < base.length) {
    if (toLocal.get(baseIndex) === localIndex && toRemote.get(baseIndex) === remoteIndex) {
      result.push(base[baseIndex]!);
      baseIndex += 1;
      localIndex += 1;
      remoteIndex += 1;
      continue;
    }

    let spanEnd = baseIndex;
    while (spanEnd < base.length) {
      const localMatch = toLocal.get(spanEnd);
      const remoteMatch = toRemote.get(spanEnd);
      if (
        localMatch !== undefined &&
        remoteMatch !== undefined &&
        localMatch >= localIndex &&
        remoteMatch >= remoteIndex
      ) {
        break;
      }
      spanEnd += 1;
    }

    const localEnd = spanEnd === base.length ? local.length : toLocal.get(spanEnd)!;
    const remoteEnd = spanEnd === base.length ? remote.length : toRemote.get(spanEnd)!;
    mergeBlockSpan(
      result,
      base.slice(baseIndex, spanEnd),
      local.slice(localIndex, localEnd),
      remote.slice(remoteIndex, remoteEnd),
    );
    baseIndex = spanEnd;
    localIndex = localEnd;
    remoteIndex = remoteEnd;
  }

  mergeBlockSpan(result, [], local.slice(localIndex), remote.slice(remoteIndex));
  return result;
}

function commonPrefixLength(
  base: ReadonlyArray<string>,
  local: ReadonlyArray<string>,
  remote: ReadonlyArray<string>,
): number {
  const limit = Math.min(base.length, local.length, remote.length);
  let length = 0;
  while (length < limit && base[length] === local[length] && base[length] === remote[length]) {
    length += 1;
  }
  return length;
}

function commonSuffixLength(
  base: ReadonlyArray<string>,
  local: ReadonlyArray<string>,
  remote: ReadonlyArray<string>,
): number {
  const limit = Math.min(base.length, local.length, remote.length);
  let length = 0;
  while (
    length < limit &&
    base[base.length - 1 - length] === local[local.length - 1 - length] &&
    base[base.length - 1 - length] === remote[remote.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}

function mergeBlocksBySharedEdges(
  base: ReadonlyArray<string>,
  local: ReadonlyArray<string>,
  remote: ReadonlyArray<string>,
): string[] {
  const prefixLength = commonPrefixLength(base, local, remote);
  const suffixLimit = Math.min(base.length, local.length, remote.length);
  const suffixLength = Math.min(
    commonSuffixLength(
      base.slice(base.length - suffixLimit),
      local.slice(local.length - suffixLimit),
      remote.slice(remote.length - suffixLimit),
    ),
    suffixLimit - prefixLength,
  );
  const middleEnd = (blocks: ReadonlyArray<string>): number =>
    suffixLength === 0 ? blocks.length : blocks.length - suffixLength;

  const result = base.slice(0, prefixLength);
  mergeBlockSpan(
    result,
    base.slice(prefixLength, middleEnd(base)),
    local.slice(prefixLength, middleEnd(local)),
    remote.slice(prefixLength, middleEnd(remote)),
  );
  if (suffixLength > 0) {
    result.push(...base.slice(base.length - suffixLength));
  }
  return result;
}

function joinMergedBlocks(blocks: ReadonlyArray<string>): string {
  let output = "";
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    if (i > 0) {
      const prev = blocks[i - 1]!;
      output +=
        LIST_ITEM_START_PATTERN.test(prev) && LIST_ITEM_START_PATTERN.test(block) ? "\n" : "\n\n";
    }
    output += block;
  }
  return output;
}

/** Deterministic block merge: disjoint edits both survive, and overlapping edits keep both texts. */
export function mergeScratchMarkdown3Way(base: string, local: string, remote: string): string {
  if (local === base) return remote;
  if (remote === base) return local;
  if (local === remote) return local;

  return joinMergedBlocks(
    mergeBlocksByDiff3(blockMarkdowns(base), blockMarkdowns(local), blockMarkdowns(remote)),
  );
}

function stripMarkdownLinePrefix(line: string): string {
  let current = line;
  for (let pass = 0; pass < 6; pass += 1) {
    const stripped = current
      .replace(/^#{1,6}[ \t]+/, "")
      .replace(/^>[ \t]*/, "")
      .replace(/^[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/, "")
      .replace(/^\d+[.)][ \t]+/, "");
    if (stripped === current) break;
    current = stripped;
  }
  return current.trim();
}

function truncatePreview(line: string): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  const characters = Array.from(collapsed);
  if (characters.length <= PREVIEW_MAX_CHARS) return collapsed;
  return `${characters.slice(0, PREVIEW_MAX_CHARS).join("").trimEnd()}…`;
}

export function scratchChunkPreviewTitle(markdown: string, fallback = ""): string {
  for (const block of splitScratchMarkdownBlocks(markdown)) {
    if (block.kind !== "text") continue;
    const blockLines = block.markdown.split("\n");
    // A fenced block is code, never a title candidate.
    if (blockLines.length > 0 && fenceOpeningOf(blockLines[0]!) !== null) continue;
    for (const rawLine of blockLines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      if (FENCE_PATTERN.test(line) || FENCE_CLOSE_PATTERN.test(line)) continue;
      if (parseScratchImageLine(line) !== null) continue;
      const preview = stripMarkdownLinePrefix(line);
      if (preview.length === 0) continue;
      return truncatePreview(preview);
    }
  }
  return fallback;
}
