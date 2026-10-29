export const CONTEXT_LIMITS = {
  items: 20,
  previewChars: 1800,
  previewBytes: 3600,
  pageChars: 16000,
  pageBytes: 32000,
  memoryFiles: 128,
  memoryFileBytes: 262144,
} as const;
const marker = "\n[Preview; use full read for complete source.]";

export function preview(text: string) {
  let body = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (
      body.length + character.length > CONTEXT_LIMITS.previewChars ||
      bytes + size > CONTEXT_LIMITS.previewBytes
    )
      break;
    body += character;
    bytes += size;
  }
  const truncated = body.length !== text.length;
  return { text: truncated ? body + marker : body, truncated };
}

export function page<A>(items: ReadonlyArray<A>, limit: number = CONTEXT_LIMITS.items) {
  const selected: A[] = [];
  let chars = 2;
  let bytes = 2;
  for (const item of items) {
    const encoded = JSON.stringify(item);
    if (selected.length >= limit) break;
    if (
      chars + encoded.length + 1 > CONTEXT_LIMITS.pageChars ||
      bytes + Buffer.byteLength(encoded) + 1 > CONTEXT_LIMITS.pageBytes
    )
      continue;
    selected.push(item);
    chars += encoded.length + 1;
    bytes += Buffer.byteLength(encoded) + 1;
  }
  return { items: selected, omitted: items.length - selected.length };
}

export function lexicalScore(text: string, query: string) {
  const terms = [...new Set(query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  const haystack = text.toLocaleLowerCase("en-US");
  return terms.reduce((score, term) => score + Number(haystack.includes(term)), 0);
}
