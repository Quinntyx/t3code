// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.

import {
  type BrowserRecordingFrameRate,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationClickInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationPressInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as Schema from "effect/Schema";
import type { CDPSession, ConsoleMessage, Frame, Locator, Page } from "playwright-core";
import * as NodeCrypto from "node:crypto";
import { BrowserControlInterrupted } from "./SessionControl.ts";

const isBrowserControlInterrupted = Schema.is(BrowserControlInterrupted);

const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_SCREENSHOT_WIDTH = 1280;
const WAIT_POLL_MS = 100;
export const DIAGNOSTIC_BUFFER_LIMIT = 200;

export class ServerBrowserOperationError extends Schema.TaggedError<ServerBrowserOperationError>()(
  "ServerBrowserOperationError",
  {
    tag: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isServerBrowserOperationError = Schema.is(ServerBrowserOperationError);

export const toOperationError = (
  cause: unknown,
  timeoutMs?: number,
): ServerBrowserOperationError => {
  if (isBrowserControlInterrupted(cause))
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationControlInterruptedError",
      message: cause.message,
      detail: cause.reason,
    });
  if (isServerBrowserOperationError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const firstLine = message.split("\n")[0] ?? message;
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationTimeoutError",
      message: firstLine,
      detail: timeoutMs === undefined ? undefined : { timeoutMs },
    });
  }
  if (
    /while parsing selector|Unknown engine|Unexpected token|strict mode violation/i.test(message)
  ) {
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationInvalidSelectorError",
      message: firstLine,
    });
  }
  if (/not an <input>|not editable|not an editable/i.test(message)) {
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: firstLine,
    });
  }
  return new ServerBrowserOperationError({
    tag: "PreviewAutomationExecutionError",
    message: firstLine,
  });
};

const DEFAULT_TIMEOUT_MS = 15_000;
const TARGET_COUNT_MS = 250;
const MAX_TARGET_CHARS = 200;

const pageRefs = new WeakMap<Page, { generation: string; refs: Map<string, string> }>();
// A compact runtime namespace prevents old refs from aliasing after a server restart.
const refNamespace = NodeCrypto.randomUUID().slice(0, 8);
let snapshotSequence = 0;
const nextRefGeneration = () => `${refNamespace}-${(++snapshotSequence).toString(36)}`;

/** A takeover revokes previously issued refs even when the document stays unchanged. */
export const invalidateRefs = (page: Page) => {
  const state = pageRefs.get(page);
  if (state) {
    state.generation = nextRefGeneration();
    state.refs.clear();
  }
};

const refsFor = (page: Page) => {
  let state = pageRefs.get(page);
  if (!state) {
    state = { generation: nextRefGeneration(), refs: new Map<string, string>() };
    pageRefs.set(page, state);
    page.on("framenavigated", () => invalidateRefs(page));
    page.on("framedetached", () => invalidateRefs(page));
  }
  return state;
};

const targetLocator = (
  page: Page,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
): Locator | null => {
  const selector = input.locator ?? input.selector;
  if (selector === undefined) return null;
  const engines = selector.replace(
    /\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  if (/(?:^|>>)\s*\*?aria-ref\s*=/.test(engines)) {
    const ref = /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(selector)?.[1];
    const nativeRef = ref === undefined ? undefined : pageRefs.get(page)?.refs.get(ref);
    if (nativeRef === undefined) {
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationInvalidSelectorError",
        message:
          "This element ref is stale or belongs to another tab. Take a fresh snapshot and use its locator.",
        detail: { staleRef: true },
      });
    }
    return page.locator(`aria-ref=${nativeRef}`);
  }
  // Playwright's strict locators reject ambiguous controls rather than acting on row one.
  return page.locator(selector);
};

export type PointerReporter = (
  point: { readonly x: number; readonly y: number },
  phase: "move" | "click",
) => Promise<void>;
const noPointer: PointerReporter = async () => {};

const targetPoint = async (
  page: Page,
  locator: Locator | null,
  input: { readonly x?: number | undefined; readonly y?: number | undefined },
  timeout: number,
) => {
  if (locator === null) return { x: input.x ?? 0, y: input.y ?? 0 };
  await locator.scrollIntoViewIfNeeded({ timeout });
  const box = await locator.boundingBox({ timeout });
  if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const viewport = page.viewportSize();
  return { x: (viewport?.width ?? 0) / 2, y: (viewport?.height ?? 0) / 2 };
};

const SNAPSHOT_SCRIPT = `(() => {
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: document.body?.innerText || "",
    interactiveElements: [],
  };
})()`;

const MASKED_VALUE = "••••••••";

/**
 * A `data:` URL carries its content, which can be a whole file, and URLs and diagnostics
 * reach tool results and provider logs. Keeps only the media type: the payload can hold any
 * character and parameters are page-chosen too.
 */
export const withoutDataPayload = (url: string) => {
  // Read the scheme as a browser would: it ignores leading controls and spaces, and tabs and
  // newlines anywhere. A snapshot's YAML value may be quoted and escaped; an escape that isn't a
  // tab or newline still decodes to something that can't start a scheme.
  const value = url
    .replace(/^["']/, "")
    .replace(/\\(x[\da-f]{2}|u[\da-f]{4}|.)/gi, (_escape, code: string) =>
      code.length > 1
        ? String.fromCharCode(Number.parseInt(code.slice(1), 16))
        : ({ t: "\t", n: "\n", r: "\r", '"': '"', "\\": "\\" }[code] ?? "\u0001"),
    )
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000-\u0020]+/, "");
  const parsed = /^data:([^,;]*)/i.exec(value);
  if (!parsed) return url;
  const type = parsed[1]!.trim();
  const mediaType = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(type) ? type : "";
  return `data:${mediaType},…`;
};

/**
 * Chromium's own console messages, which carry no arguments, quote `data:` URLs whole, as in a
 * blocked navigation or a CSP violation. Everything after the first one goes, since Chromium
 * accepts any type and a payload can hold any character. What a page logs itself is its own
 * text, like anything else it shows, so it stays.
 */
export const consoleText = (message: ConsoleMessage) =>
  message.args().length > 0
    ? message.text()
    : message.text().replace(/(?<![a-z\d])data:[^,;]*[,;][\s\S]*/i, withoutDataPayload);

// Split on LF alone: a value keeps any U+2028 that a multiline regex would treat as a line end.
const withoutTreeDataPayloads = (tree: string) =>
  tree
    .split("\n")
    .map((line) => {
      const url = /^(\s*- \/url: )(.*)$/s.exec(line);
      return url ? url[1] + withoutDataPayload(url[2]!) : line;
    })
    .join("\n");

// The broker waits 15s for the host; a snapshot, retry included, answers well before.
const SNAPSHOT_TIMEOUT_MS = 10_000;
const FRAME_ANSWER_MS = 1_000;

// Include password and CSS-masked text in open shadow roots, normalized like accessible text.
const DOTTED_SCRIPT = `(() => {
  const values = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const field = element.localName === "input" || element.localName === "textarea";
      if (!field && !element.isContentEditable) continue;
      const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security");
      if (element.type !== "password" && (dots === "none" || dots === "")) continue;
      // Raw as page text shows it, and normalized as the tree does.
      for (const value of field ? [element.value, element.defaultValue] : [element.textContent ?? ""])
        values.push(value, value.replace(/[\\u200b\\u00ad]/g, "").trim().replace(/\\s+/g, " "));
    }
  };
  visit(document);
  return [...new Set(values.filter((value) => value.trim()))];
})()`;

const pageChanged = () =>
  new ServerBrowserOperationError({
    tag: "PreviewAutomationExecutionError",
    message: "The page changed while capturing its snapshot. Take another snapshot.",
  });

const tooBusy = () =>
  new ServerBrowserOperationError({
    tag: "PreviewAutomationTimeoutError",
    message:
      "The page was too busy to capture a snapshot in time. Wait for it to settle and take another snapshot.",
  });

const VALUE_TOO_LONG = "A password field holds a value too long to hide, so no snapshot was taken.";

/** Reuse one CDP session per out-of-process frame across snapshots. */
const frameSessions = new WeakMap<Frame, Promise<CDPSession>>();

/** Returns undefined on failure or frame timeout. */
const answered = <A>(promise: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), FRAME_ANSWER_MS);
  });
  return Promise.race([promise.catch(() => undefined), late]).finally(() => clearTimeout(timer));
};

/** Isolated worlds prevent spoofing; desktop out-of-process frames use page worlds. Missing own-frame reads or changed frames fail; other missing reads return undefined. */
const openReaders = async (page: Page, cdp: CDPSession) => {
  const frames = page.frames();
  const owners = new Map<Frame, CDPSession | null | undefined>(
    await Promise.all(
      frames.map(async (frame) => {
        if (frame === page.mainFrame()) return [frame, cdp] as const;
        const session = frameSessions.get(frame) ?? page.context().newCDPSession(frame);
        frameSessions.set(frame, session);
        try {
          return [frame, await session] as const;
        } catch (cause) {
          frameSessions.delete(frame);
          // CdpRelay supports only the page; other refusals fall back to the parent session, failing if the frame is absent.
          const desktop = String(cause).includes("Only this preview tab's page can be attached");
          return [frame, desktop ? null : undefined] as const;
        }
      }),
    ),
  );
  const ownerOf = (frame: Frame): CDPSession | null => {
    const owner = owners.get(frame);
    if (owner !== undefined) return owner;
    const parent = frame.parentFrame();
    return parent ? ownerOf(parent) : null;
  };
  const sessionReader = (frame: Frame, session: CDPSession) => {
    const owned = frames.filter((each) => ownerOf(each) === session);
    const open = async () => {
      const { frameTree } = await session.send("Page.getFrameTree");
      const ids = (node: typeof frameTree): Array<string> => [
        node.frame.id,
        ...(node.childFrames ?? []).flatMap(ids),
      ];
      // A frame Playwright knows but this session doesn't would go unread.
      if (ids(frameTree).length !== owned.length) throw pageChanged();
      return Promise.all(
        ids(frameTree).map(async (frameId) => {
          const world = await session.send("Page.createIsolatedWorld", {
            frameId,
            worldName: "t3-preview",
          });
          return world.executionContextId;
        }),
      );
    };
    let contexts: ReturnType<typeof open> | undefined;
    const read = async () => {
      const values = (contexts ??= open()).then((ids) =>
        Promise.all(
          ids.map(async (contextId) => {
            const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
              contextId,
              expression: DOTTED_SCRIPT,
              returnByValue: true,
            });
            if (exceptionDetails) throw pageChanged();
            return result.value as Array<string>;
          }),
        ),
      );
      try {
        return (await values).flat();
      } catch (cause) {
        // The frame may have moved to another process; the next snapshot opens a new session.
        if (session !== cdp) {
          frameSessions.delete(frame);
          void session.detach().catch(constVoid);
        }
        throw cause;
      }
    };
    return { frames: owned, read };
  };
  const readers = [
    sessionReader(page.mainFrame(), cdp),
    ...frames.flatMap((frame) => {
      const owner = owners.get(frame);
      if (owner) return owner === cdp ? [] : [sessionReader(frame, owner)];
      const own = () => frame.evaluate(DOTTED_SCRIPT) as Promise<Array<string>>;
      return ownerOf(frame) === null ? [{ frames: [frame], read: own }] : [];
    }),
  ];
  return {
    readers,
    read: async (before?: ReadonlyArray<unknown>) => {
      const now = page.frames();
      if (now.length !== frames.length || now.some((frame, i) => frame !== frames[i])) {
        throw pageChanged();
      }
      return Promise.all(
        readers.map((reader, i) => {
          if (i === 0) return reader.read().catch(() => Promise.reject(pageChanged()));
          return before && !before[i] ? undefined : answered(reader.read());
        }),
      );
    },
  };
};

/** Short values need word boundaries to avoid masking unrelated text. */
const dottedPattern = (values: ReadonlyArray<string>) => {
  const sources = values
    .flatMap((value) => {
      const json = JSON.stringify(value).slice(1, -1);
      // Playwright writes control characters like JSON does, with \xNN for the unnamed ones.
      const quoted = value.replace(/[\\"\p{Cc}]/gu, (char) =>
        '\\"\b\f\n\r\t'.includes(char)
          ? JSON.stringify(char).slice(1, -1)
          : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
      const forms = [value, json, quoted].flatMap((form) => [form, form.replaceAll("'", "''")]);
      return [...new Set(forms)].map((form) => ({ form, word: value.length < 4 }));
    })
    // Longest first, so a form inside another never leaves the rest showing.
    .toSorted((a, b) => b.form.length - a.form.length)
    .map(({ form, word }) => {
      const literal = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return word ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
    });
  if (sources.length === 0) return undefined;
  const pattern = new RegExp(sources.join("|"), "gu");
  try {
    // Force regex compilation for one-byte and two-byte strings now; size errors name every value.
    pattern.test("");
    pattern.test("\u2022");
  } catch {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: VALUE_TOO_LONG,
    });
  }
  return pattern;
};

// Playwright single-quotes keys containing ': ' and leaves /.../ names unquoted. Recognize only its attributes so name text cannot spoof them.
const TREE_LINE =
  /^(\s*- '?[^\s"':]+)( "(?:[^"\\]|\\.)*"| \/(?:.*?\/)?)?((?: \[(?:active|checked(?:=mixed)?|disabled|expanded|level=\d+|pressed(?:=mixed)?|selected|ref=(?:f\d+)?e\d+|cursor=pointer|box=-?\d+,-?\d+,\d+,\d+)\])*'?)(:.*)?$/;

/** Preserve roles and attributes so refs work; unquoted /.../ names can make matches cross boundaries. */
const maskTree = (tree: string, dotted: RegExp) =>
  tree
    .split("\n")
    .map((line) => {
      const node = TREE_LINE.exec(line);
      const name = node?.[1]?.length ?? 0;
      const attributes = name + (node?.[2]?.length ?? 0);
      const end = attributes + (node?.[3]?.length ?? 0);
      const kept = (from: number, to: number) => to <= name || (from >= attributes && to <= end);
      return line.replace(dotted, (match: string, offset: number) =>
        kept(offset, offset + match.length) ? match : MASKED_VALUE,
      );
    })
    .join("\n");

/** Chromium sizes the capture, so the reported size is read from the PNG header. */
const pngSize = (base64: string) => {
  const header = Buffer.from(base64.slice(0, 32), "base64");
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
};

/**
 * A page's display ratio and CSS viewport, read in an isolated world since page script can
 * reassign `devicePixelRatio`, `innerWidth`, and `innerHeight` in its own, and its page zoom.
 */
const readPageMetrics = async (cdp: CDPSession) => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "t3-preview-metrics",
  });
  let { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics");
  // Desktop zoom applies asynchronously; bracket the CSS metrics to reject a torn read.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const zoom = cssVisualViewport.zoom ?? 1;
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "({ ratio: devicePixelRatio, width: innerWidth, height: innerHeight })",
      contextId: executionContextId,
      returnByValue: true,
    });
    ({ cssVisualViewport } = await cdp.send("Page.getLayoutMetrics"));
    if ((cssVisualViewport.zoom ?? 1) === zoom) {
      const { ratio, width, height } = result.value as {
        readonly ratio: number;
        readonly width: number;
        readonly height: number;
      };
      return { ratio, width, height, zoom };
    }
  }
  throw new Error(
    "The page's zoom kept changing while the snapshot read its size. Try the snapshot again.",
  );
};

// Never pass a clip scale: Chromium mirrors the top-left of the page into a `backdrop-filter`
// in any capture it shrinks.
export const captureViewport = async (
  cdp: CDPSession,
  options: { readonly format: "png" | "jpeg"; readonly quality?: number },
) => {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: options.format,
    ...(options.quality === undefined ? {} : { quality: options.quality }),
  });
  return data;
};

/** Runs in the page's own isolated world, as the server has no image library. */
const SHRINK_PNG = `async function (png, width, height) {
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  // Namespaced, as an XML document's createElement makes a plain element with no getContext.
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}`;

const shrinkPng = async (cdp: CDPSession, png: string, scale: number) => {
  const size = pngSize(png);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "t3-preview-screenshot",
  });
  const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
    functionDeclaration: SHRINK_PNG,
    executionContextId,
    arguments: [
      { value: png },
      { value: Math.round(size.width * scale) },
      { value: Math.round(size.height * scale) },
    ],
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error("The snapshot could not shrink its screenshot.");
  return result.value as string;
};

type SnapshotInput = {
  readonly page: Page;
  readonly cdp: CDPSession;
  /** Headless pages render at the scale the server set; a desktop page at its display's. */
  readonly renderScale: number | "display";
  readonly fullScreenshot?: boolean | undefined;
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: PreviewAutomationSnapshot["actionTimeline"];
};

/** The scale a page renders at and its viewport in device-independent pixels. */
const renderingOf = async (input: SnapshotInput) => {
  if (input.renderScale !== "display") {
    const viewport = input.page.viewportSize() ?? { width: 1280, height: 800 };
    return { renderScale: input.renderScale, viewport };
  }
  // The display ratio a desktop page reports includes its page zoom, and its sizes are CSS pixels.
  const page = await readPageMetrics(input.cdp);
  return {
    renderScale: page.ratio / page.zoom,
    viewport: {
      width: Math.round(page.width * page.zoom),
      height: Math.round(page.height * page.zoom),
    },
  };
};

const capture = async (
  input: SnapshotInput,
  deadline: number,
): Promise<PreviewAutomationSnapshot> => {
  const { renderScale, viewport } = await renderingOf(input);
  // A late metrics reply must not begin a capture after viewers have resumed.
  if (Date.now() >= deadline) throw tooBusy();
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (viewport.width * renderScale));
  const state = refsFor(input.page);
  invalidateRefs(input.page);
  const generation = state.generation;
  const { readers, read } = await openReaders(input.page, input.cdp);
  const before = await read();
  // Bracket the tree with value reads to detect changes; await tree completion before retrying failed captures.
  const pageAndScreenshot = Promise.all([
    input.page.evaluate(SNAPSHOT_SCRIPT) as Promise<
      Pick<
        PreviewAutomationSnapshot,
        "url" | "title" | "loading" | "visibleText" | "interactiveElements"
      >
    >,
    captureViewport(input.cdp, { format: "png" }).then(async (full) =>
      scale < 1
        ? {
            data: await shrinkPng(input.cdp, full, scale),
            full: input.fullScreenshot ? full : undefined,
          }
        : { data: full, full: undefined },
    ),
  ]);
  void pageAndScreenshot.catch(constVoid);
  // Leaves time for the second read; a frame that never loads holds the tree until then.
  const tree = await input.page.ariaSnapshot({
    mode: "ai",
    boxes: true,
    timeout: Math.max(1, deadline - Date.now() - 2_000),
  });
  const after = await read(before);
  // A value that changed meanwhile may be in the tree under neither reading.
  if (after.some((values, i) => values && JSON.stringify(values) !== JSON.stringify(before[i])))
    throw pageChanged();
  const dotted = dottedPattern(after.flatMap((values) => values ?? []));
  // Unread frames can expose values only if their content appears in the tree.
  const unread = readers.flatMap((reader, i) => (after[i] ? [] : reader.frames));
  const filled = /^\s*- iframe (?:\[active\] )?\[ref=(\S+?)\].*:$/gm;
  for (const [, ref] of unread.length ? tree.matchAll(filled) : []) {
    const iframe = await input.page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 2_000 });
    if (!iframe) throw pageChanged();
    const frame = await iframe.contentFrame();
    void iframe.dispose().catch(constVoid);
    if (frame && unread.includes(frame)) throw tooBusy();
  }
  const [page, { full, data }] = await pageAndScreenshot;
  if (state.generation !== generation) throw pageChanged();
  const mask = (text: string) => (dotted ? text.replace(dotted, MASKED_VALUE) : text);
  // Redacted before the cut, so a payload crossing it can't leave its start showing, and before
  // masking, which could hide the `data:` scheme behind a password value's dots.
  const redacted = withoutTreeDataPayloads(tree);
  const accessibilityTree = (dotted ? maskTree(redacted, dotted) : redacted)
    .slice(0, MAX_VISIBLE_TEXT_LENGTH)
    .replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_match, nativeRef: string) => {
      const ref = `t3-${generation}-${nativeRef}`;
      state.refs.set(ref, nativeRef);
      return `[ref=${ref}]`;
    });
  return {
    ...page,
    url: withoutDataPayload(page.url),
    // Mask text before truncating so a value crossing the cut cannot leak its prefix.
    visibleText: mask(page.visibleText).slice(0, MAX_VISIBLE_TEXT_LENGTH),
    accessibilityTree,
    consoleEntries: [...input.consoleEntries],
    networkEntries: [...input.networkEntries],
    actionTimeline: [...input.actionTimeline],
    screenshot: {
      mimeType: "image/png",
      data,
      ...pngSize(data),
    },
    ...(full !== undefined ? { fullScreenshot: { data: full, ...pngSize(full) } } : {}),
  };
};

/** Snapshots begun per page; observers' snapshots aren't queued, so two can overlap. */
const snapshotTurns = new WeakMap<Page, number>();

export const snapshot = async (input: SnapshotInput): Promise<PreviewAutomationSnapshot> => {
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(tooBusy()), SNAPSHOT_TIMEOUT_MS);
  });
  const turn = (snapshotTurns.get(input.page) ?? 0) + 1;
  snapshotTurns.set(input.page, turn);
  // Retry only before the deadline and the next snapshot, whose refs a later retry would revoke.
  const captured = capture(input, deadline).catch((cause: unknown) =>
    Date.now() < deadline &&
    snapshotTurns.get(input.page) === turn &&
    !(cause instanceof Error && cause.message === VALUE_TOO_LONG)
      ? capture(input, deadline)
      : Promise.reject(cause),
  );
  try {
    return await Promise.race([captured, expired]);
  } catch (cause) {
    throw cause instanceof Error && cause.name === "TimeoutError" ? tooBusy() : cause;
  } finally {
    clearTimeout(timer);
  }
};

/** Return when a dialog opens; waiting for the action to finish would block until dialog resolution. */
export const click = async (
  page: Page,
  input: PreviewAutomationClickInput,
  pointer: PointerReporter = noPointer,
): Promise<{ readonly x: number; readonly y: number }> => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  try {
    return await clickTarget(page, locator, input, timeout, pointer);
  } catch (cause) {
    throw locator === null ? cause : await namedTargetTimeout(locator, input, cause);
  }
};

/**
 * Playwright's timeout names neither the target nor why it waited. Counting only after the
 * wait failed keeps auto-wait intact, but the count describes the page after the timeout, not
 * what the click did: Playwright can dispatch the click and then time out waiting for the
 * navigation it started.
 */
const namedTargetTimeout = async (
  locator: Locator,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
  cause: unknown,
) => {
  if (!(cause instanceof Error && cause.name === "TimeoutError")) return cause;
  const selector = JSON.stringify(input.locator ?? input.selector);
  // The warning leads and the target is capped, so a reply cut short still carries the warning.
  const target =
    selector.length > MAX_TARGET_CHARS ? `${selector.slice(0, MAX_TARGET_CHARS)}...` : selector;
  // The host's reply must still beat the broker's short grace after the operation timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const matches = await Promise.race([
    locator.count().catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), TARGET_COUNT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const reason =
    matches === undefined
      ? `The click may have happened; check the page before retrying. Whether ${target} still matches an element is unknown.`
      : matches === 0
        ? `The click may have happened and removed its target or navigated; check the page before retrying. No element matches ${target} after the timeout; take a fresh snapshot and use its locator.`
        : `The click may have happened; check the page before retrying. ${target} still matches an element after the timeout.`;
  return new ServerBrowserOperationError({
    tag: "PreviewAutomationTimeoutError",
    message: reason,
    detail: { reason },
    cause,
  });
};

const clickTarget = async (
  page: Page,
  locator: Locator | null,
  input: PreviewAutomationClickInput,
  timeout: number,
  pointer: PointerReporter,
) => {
  const point = await targetPoint(page, locator, input, timeout);
  await pointer(point, "click");
  const options = { button: input.button ?? "left", clickCount: input.clickCount ?? 1 } as const;
  const clicked =
    locator === null
      ? page.mouse.click(point.x, point.y, options)
      : locator.click({ ...options, timeout });
  let onDialog = constVoid;
  const dialogOpened = new Promise<"dialog">((resolve) => {
    onDialog = () => resolve("dialog");
    page.once("dialog", onDialog);
  });
  try {
    if ((await Promise.race([clicked, dialogOpened])) === "dialog") void clicked.catch(constVoid);
  } finally {
    page.off("dialog", onDialog);
  }
  return point;
};

export const type = async (page: Page, input: PreviewAutomationTypeInput) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  if (locator !== null && input.clear) {
    await locator.fill(input.text, { timeout });
    return;
  }
  // A shadow host also matches :focus; use its innermost focused descendant.
  const target = locator ?? page.locator("*:focus").last();
  const focused =
    (locator !== null || (await target.count()) > 0) &&
    (await target.evaluate(
      (element) => {
        // Require an enabled, focused text target to avoid losing input or sending it to the previous field.
        const control = element as unknown as {
          readonly type?: string;
          readonly disabled?: boolean;
          readonly readOnly?: boolean;
          readonly isContentEditable?: boolean;
          readonly focus?: () => void;
        };
        const nonText = [
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ];
        const textControl =
          element.tagName === "TEXTAREA" ||
          (element.tagName === "INPUT" && !nonText.includes(control.type ?? "text"));
        if (!(textControl || control.isContentEditable) || control.disabled || control.readOnly) {
          return false;
        }
        control.focus?.();
        const root = element.getRootNode() as { readonly activeElement?: typeof element | null };
        const active = root.activeElement;
        return active != null && (active === element || element.contains(active));
      },
      undefined,
      { timeout },
    ));
  if (focused !== true) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: "The target is not an enabled text field, so no text was typed.",
    });
  }
  if (input.clear) {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
  }
  await page.keyboard.insertText(input.text);
};

export const hover = async (
  page: Page,
  input: PreviewAutomationHoverInput,
  pointer: PointerReporter = noPointer,
) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  await pointer(await targetPoint(page, locator, input, timeout), "move");
  if (locator === null) {
    await page.mouse.move(input.x ?? 0, input.y ?? 0);
    return;
  }
  await locator.hover({ timeout });
};

export const select = async (
  page: Page,
  input: PreviewAutomationSelectInput,
): Promise<PreviewAutomationSelectResult> => {
  const locator = targetLocator(page, input)!;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const options = await locator.evaluate(
    (element) =>
      element.tagName === "SELECT"
        ? Array.from(
            (element as unknown as { options: ArrayLike<{ value: string; label: string }> })
              .options,
            ({ value, label }) => ({ value, label: label.trim() }),
          )
        : null,
    undefined,
    { timeout },
  );
  const values =
    options &&
    input.values.map(
      (entry) =>
        (
          options.find((option) => option.value === entry) ??
          options.find((option) => option.label === entry.trim())
        )?.value ?? entry,
    );
  if (values === null)
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: "This element is not a <select>. Click a custom dropdown, then click its option.",
    });
  return { selected: await locator.selectOption(values, { timeout }) };
};

export const drag = async (
  page: Page,
  input: PreviewAutomationDragInput,
  pointer: PointerReporter = noPointer,
) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const source = targetLocator(page, { locator: input.source })!;
  const target = targetLocator(page, { locator: input.target })!;
  await pointer(await targetPoint(page, source, {}, timeout), "move");
  // Observe drag rejection immediately; an unhandled rejection during cursor movement exits the server.
  const dragFailure = source.dragTo(target, { timeout }).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  const end = await target.boundingBox({ timeout }).catch(() => null);
  if (end) await pointer({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, "move");
  const failure = await dragFailure;
  if (failure) throw failure.error;
};

export const setInputFiles = async (page: Page, input: PreviewAutomationUploadInput) => {
  const locator = targetLocator(page, input);
  if (locator === null) return false;
  await locator.setInputFiles([...input.paths], { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  return true;
};

export const press = async (page: Page, input: PreviewAutomationPressInput) => {
  await page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
};

export const scroll = async (page: Page, input: PreviewAutomationScrollInput) => {
  const delta = [input.deltaX ?? 0, input.deltaY ?? 0] as const;
  const locator = targetLocator(page, input);
  if (locator === null) {
    // Page-side code is passed as source: the server compiles without DOM types.
    await page.evaluate(`scrollBy(${delta[0]}, ${delta[1]})`);
    return;
  }
  await locator.evaluate((element, [x, y]) => element.scrollBy(x, y), delta);
};

/** Terminate expired page scripts so a hung expression cannot block the tab's control queue. */
export const evaluate = async (
  cdp: CDPSession,
  input: PreviewAutomationEvaluateInput,
  timeoutMs: number,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Stops a busy script; an awaited promise is abandoned and settles unread.
      void cdp.send("Runtime.terminateExecution").catch(constVoid);
      reject(
        new ServerBrowserOperationError({
          tag: "PreviewAutomationTimeoutError",
          message: `Evaluation did not finish within ${timeoutMs}ms and was stopped.`,
        }),
      );
    }, timeoutMs);
  });
  const params = {
    expression: input.expression,
    awaitPromise: input.awaitPromise ?? true,
    returnByValue: input.returnByValue ?? true,
  };
  // The devtools console's replMode allows top-level await but returns a trailing promise unawaited,
  // so it only retries what the page's parser rejected. A parse error has a scriptId but no stack and
  // ran nothing; a browser-internal rejection has neither.
  const evaluation = cdp.send("Runtime.evaluate", params).then((classic) => {
    const failure = classic.exceptionDetails;
    const unparsed =
      failure?.exception?.className === "SyntaxError" &&
      failure.scriptId !== undefined &&
      failure.stackTrace === undefined;
    return unparsed && !timedOut && input.expression.includes("await")
      ? cdp.send("Runtime.evaluate", { ...params, replMode: true })
      : classic;
  });
  void evaluation.catch(constVoid);
  const result = await Promise.race([evaluation, expired]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    });
  }
  const value =
    "value" in result.result ? result.result.value : (result.result.description ?? null);
  const actualBytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (actualBytes > MAX_EVALUATION_BYTES) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationResultTooLargeError",
      message: `Evaluation result is ${actualBytes} bytes; the limit is ${MAX_EVALUATION_BYTES}.`,
      detail: { maximumBytes: MAX_EVALUATION_BYTES },
    });
  }
  return value;
};

export const waitFor = async (page: Page, input: PreviewAutomationWaitForInput) => {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const locator = targetLocator(page, input);
  const { text, urlIncludes } = input;
  const checks: Array<() => Promise<boolean>> = [];
  if (locator !== null) checks.push(async () => (await locator.count()) > 0);
  if (text !== undefined) {
    // A navigation can destroy the context mid-check; that counts as not yet.
    checks.push(() =>
      page
        .evaluate(`(document.body?.innerText ?? "").includes(${JSON.stringify(text)})`)
        .then((found) => found === true)
        .catch(() => false),
    );
  }
  if (urlIncludes !== undefined) checks.push(async () => page.url().includes(urlIncludes));
  for (;;) {
    const results = await Promise.all(checks.map((check) => check()));
    if (results.every(Boolean)) return;
    if (Date.now() >= deadline) {
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationTimeoutError",
        message: `Waited ${timeoutMs}ms without every condition holding.`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
};

const NET_ERROR_CODES: Readonly<Record<string, number>> = {
  ERR_FAILED: -2,
  ERR_TIMED_OUT: -7,
  ERR_CONNECTION_CLOSED: -100,
  ERR_CONNECTION_RESET: -101,
  ERR_CONNECTION_REFUSED: -102,
  ERR_NAME_NOT_RESOLVED: -105,
  ERR_INTERNET_DISCONNECTED: -106,
  ERR_ADDRESS_UNREACHABLE: -109,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_EMPTY_RESPONSE: -324,
};

export const parseNetError = (errorText: string) => {
  // Names can hold digits, as in ERR_HTTP2_PROTOCOL_ERROR.
  const description = /ERR_[A-Z\d_]+/.exec(errorText)?.[0] ?? errorText;
  return { description, code: NET_ERROR_CODES[description] ?? -2 };
};

export interface VideoEncoderWindow {
  __t3Video: {
    pick(codecs: ReadonlyArray<string>): Promise<string | null>;
    requestKeyFrame(): void;
    encode(jpeg: string): Promise<{
      key: boolean;
      data: string;
      width: number;
      height: number;
    } | null>;
  };
}

// WebCodecs only exists in secure contexts, and a scratch page starts on about:blank.
export const VIDEO_ENCODER_URL = "https://video-encoder.t3.invalid/";

/** Re-encodes a viewer's JPEG screencast as video; resolves null when rate control drops a frame. */
export const videoEncoderScript = `(() => {
  let encoder = null;
  let size = null;
  let key = true;
  let sink = null;
  let codec = null;
  const configFor = (codec, width, height) => ({
    codec,
    width,
    height,
    bitrate: Math.round(Math.min(12e6, Math.max(2e6, width * height * 2))),
    framerate: 30,
    latencyMode: "realtime",
    ...(codec.startsWith("avc1") ? { avc: { format: "annexb" } } : {}),
  });
  window.__t3Video = {
    async pick(codecs) {
      for (const candidate of codecs) {
        const support = await VideoEncoder.isConfigSupported(configFor(candidate, 1280, 720)).catch(() => null);
        if (support && support.supported) return (codec = candidate);
      }
      return null;
    },
    requestKeyFrame() {
      key = true;
    },
    async encode(jpeg) {
      const decoder = new ImageDecoder({ data: Uint8Array.fromBase64(jpeg), type: "image/jpeg" });
      const { image } = await decoder.decode().finally(() => decoder.close());
      // 4:2:0 video needs even dimensions; the odd edge pixel is dropped.
      const width = image.displayWidth & ~1;
      const height = image.displayHeight & ~1;
      try {
        if (!encoder || encoder.state === "closed" || size.width !== width || size.height !== height) {
          if (encoder && encoder.state !== "closed") encoder.close();
          encoder = new VideoEncoder({ output: (chunk) => sink && sink.push(chunk), error: () => {} });
          encoder.configure(configFor(codec, width, height));
          size = { width, height };
          key = true;
        }
        const chunks = [];
        sink = chunks;
        const frame = new VideoFrame(image, {
          timestamp: Math.round(performance.now() * 1000),
          visibleRect: { x: 0, y: 0, width, height },
        });
        encoder.encode(frame, { keyFrame: key });
        frame.close();
        await encoder.flush();
        sink = null;
        if (chunks.length === 0) return null;
        key = false;
        const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          chunk.copyTo(bytes.subarray(offset));
          offset += chunk.byteLength;
        }
        return { key: chunks[0].type === "key", data: bytes.toBase64(), width, height };
      } finally {
        image.close();
      }
    },
  };
})()`;

export const recordingEncoderScript = (frameRate: BrowserRecordingFrameRate) => `(() => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const chunks = [];
  let recorder = null;
  let started = null;
  let stopped = null;
  let sizeBytes = 0;
  let tooLarge = false;
  let frame = null;
  let cursor = null;
  let ring = null;
  const AGENT_CURSOR_PATH = new Path2D("M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z");
  let ringTimer = null;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  const paint = () => {
    if (!frame) return;
    const fit = Math.min(canvas.width / frame.width, canvas.height / frame.height);
    const width = frame.width * fit;
    const height = frame.height * fit;
    offsetX = (canvas.width - width) / 2;
    offsetY = (canvas.height - height) / 2;
    if (width < canvas.width || height < canvas.height) {
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(frame, offsetX, offsetY, width, height);
    scale = (width / frame.width) * frame.cssScale;
    if (ring) {
      const age = (performance.now() - ring.at) / 400;
      if (age < 1) {
        context.beginPath();
        context.arc(offsetX + ring.x * scale, offsetY + ring.y * scale, (8 + 18 * age) * scale, 0, Math.PI * 2);
        context.strokeStyle = "rgba(59,130,246," + (0.9 * (1 - age)) + ")";
        context.lineWidth = 3 * scale;
        context.stroke();
      }
    }
    if (cursor) {
      // The agent cursor (lucide MousePointer2, as in the live panel), never the human arrow.
      const s = 20 / 24 * scale;
      context.save();
      context.translate(offsetX + cursor.x * scale - 2 * scale, offsetY + cursor.y * scale - 2 * scale);
      context.scale(s, s);
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.fillStyle = "#fff";
      context.strokeStyle = "#2563eb";
      context.shadowColor = "rgba(0,0,0,0.25)";
      context.shadowBlur = 2;
      context.fill(AGENT_CURSOR_PATH);
      context.shadowColor = "transparent";
      context.stroke(AGENT_CURSOR_PATH);
      context.restore();
    }
  };
  window.__t3Recorder = {
    async frame(base64, cssWidth) {
      if (tooLarge) return false;
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      if (tooLarge) { bitmap.close(); return false; }
      if (!recorder) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const mimeType = ["video/mp4;codecs=avc1.640033", "video/webm;codecs=vp9", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
        const bitsPerSecond = Math.min(50e6, Math.max(2.5e6, bitmap.width * bitmap.height * ${frameRate} * 0.05));
        recorder = new MediaRecorder(canvas.captureStream(${frameRate}), { mimeType, videoBitsPerSecond: bitsPerSecond });
        started = new Promise((resolve, reject) => {
          recorder.onstart = resolve;
          recorder.onerror = (event) => reject(event.error);
        });
        stopped = new Promise((resolve) => { recorder.onstop = resolve; });
        recorder.ondataavailable = (event) => {
          if (tooLarge || event.data.size === 0) return;
          sizeBytes += event.data.size;
          if (sizeBytes > ${PROVIDER_SEND_TURN_MAX_FILE_BYTES}) {
            tooLarge = true;
            chunks.length = 0;
            clearInterval(ringTimer);
            frame?.close();
            frame = null;
            if (recorder.state !== "inactive") recorder.stop();
            for (const track of recorder.stream.getTracks()) track.stop();
            return;
          }
          chunks.push(event.data);
        };
        recorder.start(1000);
      }
      // Frame px per page CSS px, before fitting into the canvas.
      bitmap.cssScale = bitmap.width / cssWidth;
      frame?.close();
      frame = bitmap;
      paint();
      await started;
      return true;
    },
    cursor(x, y, click) {
      if (tooLarge) return;
      cursor = { x, y };
      if (click) {
        ring = { x, y, at: performance.now() };
        clearInterval(ringTimer);
        ringTimer = setInterval(() => {
          paint();
          if (performance.now() - ring.at > 400) { ring = null; clearInterval(ringTimer); paint(); }
        }, 33);
      }
      paint();
    },
    async stop() {
      if (!recorder) return { mimeType: null, count: 0, bytes: 0 };
      if (recorder.state !== "inactive") {
        // Consume the cached frame, then wait for the final paint to reach the
        // capture stream. Animation ticks alone can stop before it is delivered.
        const video = document.createElement("video");
        video.muted = true;
        video.srcObject = recorder.stream;
        const nextFrame = () => Promise.race([
          new Promise(resolve => video.requestVideoFrameCallback(resolve)),
          stopped,
        ]);
        const initial = nextFrame();
        void video.play().catch(() => {});
        await initial;
        if (recorder.state !== "inactive") {
          const delivered = nextFrame();
          recorder.stream.getVideoTracks()[0].requestFrame();
          paint();
          await delivered;
        }
        video.pause();
        video.srcObject = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      await stopped;
      return { mimeType: recorder.mimeType, count: chunks.length, bytes: sizeBytes };
    },
    async chunk(index) {
      const bytes = new Uint8Array(await chunks[index].arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    },
  };
})()`;

/**
 * Installed with every tab, before page scripts run, and never removed: a graph or a media
 * element that started before a viewer asked for sound is still known when capture turns on.
 * It only records, and only weakly, so a page that builds and drops graphs is not retained.
 */
export const audioTrackerScript = `(() => {
  if (window !== window.top) return;
  if (window.__t3AudioTrack) return;
  const edges = new WeakMap();
  const traced = new Set();
  const tracedSeen = new WeakSet();
  const routed = new WeakSet();
  const mediaSeen = new WeakSet();
  const mediaListened = new WeakSet();
  const media = new Set();
  let listeners = [];
  const notify = (change) => {
    for (const listener of listeners) {
      try { listener(change); } catch {}
    }
  };
  const outputsOf = (node) => {
    let outputs = edges.get(node);
    if (!outputs) edges.set(node, (outputs = new Set()));
    return outputs;
  };
  const remember = (node) => {
    if (tracedSeen.has(node)) return;
    tracedSeen.add(node);
    traced.add(new WeakRef(node));
  };
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (...args) {
    // Recorded only after the native call accepts the edge.
    const result = connect.apply(this, args);
    if (args[0] instanceof AudioDestinationNode) {
      outputsOf(this).add(typeof args[1] === "number" ? args[1] : 0);
      remember(this);
      notify({ type: "destination", node: this });
    }
    return result;
  };
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function (...args) {
    // The native call throws for a bad target, so a failed removal records nothing.
    const result = disconnect.apply(this, args);
    const outputs = edges.get(this);
    if (outputs) {
      const target = args[0];
      if (target === undefined) outputs.clear();
      else if (target instanceof AudioDestinationNode) {
        if (typeof args[1] === "number") outputs.delete(args[1]);
        else outputs.clear();
      } else if (typeof target === "number") outputs.delete(target);
      if (outputs.size === 0) edges.delete(this);
    }
    notify({ type: "destination", node: this });
    return result;
  };
  const createMediaElementSource = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (element) {
    // A media element has one media source for its whole life. Once the page's own call has
    // taken it, a capture must let go rather than hold it.
    const node = createMediaElementSource.call(this, element);
    if (element instanceof HTMLMediaElement) {
      routed.add(element);
      notify({ type: "routed", element });
    }
    return node;
  };
  const forget = (element) => {
    if (!mediaSeen.delete(element)) return;
    notify({ type: "media", element, gone: true });
  };
  const heard = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    if (!mediaListened.has(element)) {
      mediaListened.add(element);
      // A finished or reset element is not playing until it starts again. Its own playing
      // event finds it then, since a detached element's events never reach the document.
      element.addEventListener("playing", () => heard(element));
      element.addEventListener("ended", () => forget(element));
      element.addEventListener("emptied", () => forget(element));
    }
    if (mediaSeen.has(element)) return;
    mediaSeen.add(element);
    media.add(new WeakRef(element));
    notify({ type: "media", element });
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    // A detached new Audio() never reaches the DOM, so a playing event alone cannot find it.
    // It also arrives here before playback has given it a track; a capture then waits for one.
    heard(this);
    return play.apply(this, args);
  };
  document.addEventListener("playing", (event) => heard(event.target), true);
  for (const element of document.querySelectorAll("audio,video")) {
    if (!element.paused) heard(element);
  }
  window.__t3AudioTrack = {
    isRouted: (element) => routed.has(element),
    destinationEdges: (node) => edges.get(node) ?? new Set(),
    nodes: () => {
      const live = [];
      for (const ref of traced) {
        const node = ref.deref();
        // A node with no destination edges is pruned so it can register again if reconnected.
        if (!node || !edges.get(node)?.size) { traced.delete(ref); if (node) tracedSeen.delete(node); continue; }
        live.push(node);
      }
      return live;
    },
    media: () => {
      const live = [];
      for (const ref of media) {
        const element = ref.deref();
        // An element heard again after it reset may hold a second ref here.
        if (!element || !mediaSeen.has(element) || live.includes(element)) { media.delete(ref); continue; }
        live.push(element);
      }
      return live;
    },
    subscribe: (listener) => { listeners.push(listener); },
    unsubscribe: (listener) => { listeners = listeners.filter((each) => each !== listener); },
  };
})()`;

/** One Opus packet, tagged with the source clock it was captured at. */
export interface AudioPacket {
  readonly data: Uint8Array;
  readonly timestampMicros: number;
}

export interface ParsedAudioTapMessage {
  readonly chunk: AudioPacket | null;
  /** Set when a document's capture announces itself: its identity and whether it can encode. */
  readonly run: string | null;
  readonly available: boolean | null;
}

const NO_AUDIO_TAP_MESSAGE: ParsedAudioTapMessage = {
  chunk: null,
  run: null,
  available: null,
};

/** Reads one tap message from `Runtime.bindingCalled`; anything else is a page's own binding. */
export const parseAudioTapMessage = (payload: string): ParsedAudioTapMessage => {
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return NO_AUDIO_TAP_MESSAGE;
  }
  if (typeof message !== "object" || message === null) return NO_AUDIO_TAP_MESSAGE;
  const { type, data, timestamp, available, run } = message as {
    readonly type?: unknown;
    readonly data?: unknown;
    readonly timestamp?: unknown;
    readonly available?: unknown;
    readonly run?: unknown;
  };
  // Each document's capture announces itself, so the server can tell one document's packets
  // from the last one's and restart the timeline when the encoder does.
  if (type === "capture" && typeof run === "string")
    return { chunk: null, run, available: available === true };
  if (type !== "chunk" || typeof data !== "string" || typeof timestamp !== "number")
    return NO_AUDIO_TAP_MESSAGE;
  try {
    return {
      chunk: { data: new Uint8Array(Buffer.from(data, "base64")), timestampMicros: timestamp },
      run: typeof run === "string" ? run : null,
      available: null,
    };
  } catch {
    return NO_AUDIO_TAP_MESSAGE;
  }
};

/**
 * Feeds one Opus encoder while a viewer listens. Both kinds of source reach one 48 kHz mono
 * destination, so the encoder sees a real downmix and one timeline. The mixer lives no longer
 * than the capture: a document with no listener pays nothing.
 */
export const audioCaptureScript = (binding: string) => `(() => {
  if (window !== window.top) return;
  const tracker = window.__t3AudioTrack;
  const send = window[${JSON.stringify(binding)}];
  if (!tracker || typeof send !== "function") return;
  // A capture from before this run outlived its binding; its stop can only scratch.
  try { window.__t3AudioTap?.stop(); } catch {}
  // Insecure origins (plain http on a LAN host) have no WebCodecs, so nothing can encode here.
  const encoderAvailable =
    typeof AudioEncoder !== "undefined" && typeof MediaStreamTrackProcessor !== "undefined";
  // This document's own identity: a new document restarts the encoder clock, so its packets
  // must reach viewers under a new run rather than continuing the last document's timeline.
  const run = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { send(JSON.stringify({ type: "capture", run, available: encoderAvailable })); } catch {}
  if (!encoderAvailable) return;
  const FRAME = 960;
  const GESTURES = ["click", "pointerdown", "keydown", "pointerup", "touchend"];
  let stopped = false;
  let encoder = null;
  let pending = new Float32Array(0);
  let pendingFrom = 0;
  let buffered = false;
  const readers = new Set();
  const taps = new Map();
  const awaiting = new Map();
  const graphs = new Map();
  const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  const mix = context.createMediaStreamDestination();
  // A real mono downmix, or a right-only source would be dropped with the left channel.
  mix.channelCount = 1;
  mix.channelCountMode = "explicit";
  let gestures = false;
  const release = () => {
    if (!gestures) return;
    gestures = false;
    for (const type of GESTURES) removeEventListener(type, resume, { capture: true });
  };
  const resume = () => {
    void context.resume().then(
      () => { if (context.state === "running") release(); },
      () => {},
    );
  };
  context.onstatechange = () => { if (context.state === "running") release(); };
  // A document with sticky activation allows this immediately; one without waits for a gesture.
  resume();
  if (context.state !== "running") {
    gestures = true;
    for (const type of GESTURES) addEventListener(type, resume, { capture: true, passive: true });
  }
  const sendChunk = (packet) => {
    const bytes = new Uint8Array(packet.byteLength);
    packet.copyTo(bytes);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    try {
      send(JSON.stringify({ type: "chunk", run, data: btoa(binary), timestamp: Math.round(packet.timestamp) }));
    } catch {}
  };
  /*
   * Silence costs a packet a viewer would only skip, so it is not encoded; its timestamp still
   * moves the clock on. Leaving it out means the encoder's delayed frames would stay buffered
   * until more audio arrived, so the first silent frame flushes instead.
   */
  const flush = (pcm) => {
    const merged = new Float32Array(pending.length + pcm.length);
    merged.set(pending);
    merged.set(pcm, pending.length);
    pending = merged;
    while (pending.length >= FRAME) {
      const frame = pending.slice(0, FRAME);
      pending = pending.slice(FRAME);
      // The source clock at this frame's first sample, before its own samples advance it.
      const timestamp = Math.round((pendingFrom / 48000) * 1e6);
      pendingFrom += FRAME;
      let peak = 0;
      for (const sample of frame) peak = Math.max(peak, Math.abs(sample));
      if (peak === 0) {
        if (buffered) {
          buffered = false;
          void encoder?.flush().catch(() => stop());
        }
        continue;
      }
      const data = new AudioData({
        format: "f32-planar", sampleRate: 48000, numberOfFrames: FRAME,
        numberOfChannels: 1, timestamp, data: frame,
      });
      buffered = true;
      encoder.encode(data);
      data.close();
    }
  };
  const pump = async (track) => {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    readers.add(reader);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) { value?.close(); return; }
        const pcm = new Float32Array(value.numberOfFrames);
        value.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
        value.close();
        flush(pcm);
      }
    } catch {}
  };
  const include = (stream) => {
    if (stopped) return;
    try { context.createMediaStreamSource(stream).connect(mix); } catch {}
  };
  /*
   * A page graph is captured by mirroring each node's destination edges onto one tap belonging
   * to that graph, so the page's own gain, mute and volume apply and a node it disconnects from
   * its speakers stops playing into the tap too.
   */
  const tapGraph = (graphContext) => {
    if (stopped || graphs.has(graphContext)) return;
    let tap;
    try { tap = graphContext.createMediaStreamDestination(); } catch { return; }
    const injected = new Map();
    const mirror = (node) => {
      if (stopped || node.context !== graphContext) return;
      const outputs = tracker.destinationEdges(node);
      const held = injected.get(node) ?? new Set();
      for (const output of [...held]) {
        if (outputs.has(output)) continue;
        try { node.disconnect(tap, output); } catch {}
        held.delete(output);
      }
      for (const output of outputs) {
        if (held.has(output)) continue;
        try { node.connect(tap, output); held.add(output); } catch {}
      }
      if (held.size === 0) injected.delete(node);
      else injected.set(node, held);
    };
    const onChange = (change) => {
      if (change?.node?.context === graphContext) mirror(change.node);
    };
    for (const node of tracker.nodes()) mirror(node);
    tracker.subscribe(onChange);
    include(tap.stream);
    graphs.set(graphContext, () => {
      tracker.unsubscribe(onChange);
      for (const node of injected.keys()) {
        try { node.disconnect(tap); } catch {}
      }
      for (const track of tap.stream.getTracks()) track.stop();
    });
  };
  /*
   * A media element is captured from its own stream rather than from its media source: that
   * source is the page's to take once, and capture must not consume it. The element's muted and
   * volume do not reach a captured track, so a gain applies them and follows volumechange.
   */
  const untap = (element) => {
    untrack(element);
    const tap = taps.get(element);
    if (!tap) return;
    taps.delete(element);
    element.removeEventListener("volumechange", tap.apply);
    element.removeEventListener("playing", tap.retap);
    element.removeEventListener("loadstart", tap.retap);
    try { tap.source.disconnect(); } catch {}
    try { tap.gain.disconnect(); } catch {}
    for (const track of tap.stream.getTracks()) track.stop();
  };
  /*
   * A play() hook sees an element before playback has given its stream an audio track, and the
   * tracker reports each element only once. Chromium adds the track to that same stream later,
   * so the capture waits on the stream rather than asking an event that may precede it.
   */
  const awaitTrack = (element, stream) => {
    if (awaiting.has(element)) return;
    const onAddTrack = () => {
      const [track] = stream.getAudioTracks();
      if (!track) return;
      untrack(element);
      tapTrack(element, stream, track);
    };
    // A new src replaces the stream this wait belongs to, so the next one is asked for instead.
    const replace = () => {
      untrack(element);
      tapElement(element);
    };
    stream.addEventListener("addtrack", onAddTrack);
    element.addEventListener("loadstart", replace);
    awaiting.set(element, { stream, onAddTrack, replace });
  };
  const untrack = (element) => {
    const waited = awaiting.get(element);
    if (!waited) return;
    awaiting.delete(element);
    waited.stream.removeEventListener("addtrack", waited.onAddTrack);
    element.removeEventListener("loadstart", waited.replace);
  };
  const tapTrack = (element, stream, track) => {
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const gain = context.createGain();
    const apply = () => { gain.gain.value = element.muted ? 0 : element.volume; };
    apply();
    const retap = () => tapElement(element);
    element.addEventListener("volumechange", apply);
    // A new src or a finished stream ends the captured track; the next playback taps again.
    element.addEventListener("playing", retap);
    element.addEventListener("loadstart", retap);
    source.connect(gain);
    gain.connect(mix);
    taps.set(element, { stream, source, gain, apply, retap, track });
  };
  const tapElement = (element) => {
    if (stopped || tracker.isRouted(element) || typeof element.captureStream !== "function") {
      untrack(element);
      return;
    }
    const held = taps.get(element);
    // A captured track follows its element until the element's source is replaced.
    if (held && held.track.readyState === "live") { untrack(element); return; }
    if (held) untap(element);
    if (awaiting.has(element)) return;
    let stream;
    try { stream = element.captureStream(); } catch { return; }
    const [track] = stream.getAudioTracks();
    if (!track) { awaitTrack(element, stream); return; }
    untrack(element);
    tapTrack(element, stream, track);
  };
  const onChange = (change) => {
    if (change?.type === "media") {
      if (!(change.element instanceof HTMLMediaElement)) return;
      if (change.gone) untap(change.element);
      else tapElement(change.element);
      return;
    }
    // A routed element's own source would be a second copy of the sound the page's graph
    // already carries, so its tap is dropped as soon as that graph takes it.
    if (change?.type === "routed") {
      if (change.element instanceof HTMLMediaElement) untap(change.element);
      return;
    }
    if (change?.node?.context instanceof AudioContext) tapGraph(change.node.context);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    tracker.unsubscribe(onChange);
    for (const stopGraph of graphs.values()) stopGraph();
    graphs.clear();
    for (const element of [...taps.keys()]) untap(element);
    for (const element of [...awaiting.keys()]) untrack(element);
    for (const reader of readers) void reader.cancel().catch(() => {});
    release();
    try { encoder?.close(); } catch {}
    encoder = null;
    for (const track of mix.stream.getTracks()) track.stop();
    void context.close().catch(() => {});
    if (window.__t3AudioTap?.stop === stop) window.__t3AudioTap = undefined;
  };
  encoder = new AudioEncoder({ output: sendChunk, error: () => stop() });
  encoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 });
  tracker.subscribe(onChange);
  void pump(mix.stream.getAudioTracks()[0]);
  for (const node of tracker.nodes()) tapGraph(node.context);
  for (const element of tracker.media()) tapElement(element);
  window.__t3AudioTap = { stop };
})()`;
