import { PreviewAutomationEvaluateInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

const decodeEvaluateInput = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);

describe("JPEG screenshot dimensions", () => {
  const encode = (bytes: number[]) => Buffer.from(bytes).toString("base64");
  const frame = [0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 24, 0, 32];

  it("reads valid dimensions and rejects invalid or incomplete frames", () => {
    expect(ServerBrowserPage.jpegSize(encode(frame))).toEqual({ width: 32, height: 24 });
    for (const bytes of [
      [],
      [0xff, 0xd8, 0xff, 0xe1, 0, 20, 1],
      frame.slice(0, -1),
      [...frame.slice(0, 7), 0, 0, 0, 32],
      [...frame.slice(0, 9), 0, 0],
    ]) {
      expect(() => ServerBrowserPage.jpegSize(encode(bytes))).toThrow("Invalid JPEG screenshot.");
    }
  });
});

describe("snapshot deadline diagnostics", () => {
  const never = () => new Promise<never>(() => {});
  const stalledSnapshot = async (options: {
    readonly stalled?: "metrics";
    readonly page?: Partial<Record<keyof Page, unknown>>;
    readonly advanceMs: number;
  }) => {
    vi.useFakeTimers();
    try {
      const frame = {};
      const page = {
        viewportSize: () => ({ width: 1280, height: 800 }),
        mainFrame: () => frame,
        frames: () => [frame],
        on: () => {},
        evaluate: async () => ({
          url: "about:blank",
          title: "",
          loading: false,
          visibleText: "",
          interactiveElements: [],
        }),
        ariaSnapshot: async () => "",
        ...options.page,
      } as unknown as Page;
      const cdp = {
        send: async (method: string) => {
          if (options.stalled === "metrics") return never();
          if (method === "Page.captureScreenshot") return { data: "" };
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
          if (method === "Runtime.evaluate") return { result: { value: [] } };
          throw new Error(`Unexpected command: ${method}`);
        },
      } as unknown as CDPSession;
      const captured = ServerBrowserPage.snapshot({
        page,
        cdp,
        renderScale: options.stalled === "metrics" ? "display" : 1,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(options.advanceMs);
      return await captured;
    } finally {
      vi.useRealTimers();
    }
  };

  it("identifies a stalled metrics read", async () => {
    expect(await stalledSnapshot({ stalled: "metrics", advanceMs: 10_000 })).toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { timeoutMs: 10_000, pendingStages: ["metrics"] },
    });
  });

  it("keeps an accessibility tree that hit its own timeout", async () => {
    const timedOut = Object.assign(new Error("Timeout exceeded"), { name: "TimeoutError" });
    const captured = await stalledSnapshot({
      page: { ariaSnapshot: () => Promise.reject(timedOut) },
      advanceMs: 0,
    });
    expect(captured).toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { timeoutMs: 10_000 },
    });
    expect((captured as ServerBrowserPage.ServerBrowserOperationError).detail).toMatchObject({
      pendingStages: expect.arrayContaining(["accessibility tree"]),
    });
  });

  it("omits a timed-out stage after it succeeds on retry", async () => {
    let attempts = 0;
    const timedOut = Object.assign(new Error("Timeout exceeded"), { name: "TimeoutError" });
    expect(
      await stalledSnapshot({
        page: {
          evaluate: never,
          ariaSnapshot: async () => {
            if (attempts++ === 0) throw timedOut;
            return "";
          },
        },
        advanceMs: 10_000,
      }),
    ).toMatchObject({ detail: { timeoutMs: 10_000, pendingStages: ["page state"] } });
  });

  it.each(["elementHandle", "contentFrame"] as const)(
    "identifies stalled iframe %s lookup",
    async (stage) => {
      const main = {};
      const child = { evaluate: never, parentFrame: () => main };
      const captured = await stalledSnapshot({
        page: {
          mainFrame: () => main,
          frames: () => [main, child],
          context: () => ({
            newCDPSession: () =>
              Promise.reject(new Error("Only this preview tab's page can be attached")),
          }),
          ariaSnapshot: async () => "- iframe [ref=f1]:\n  - text: inside",
          locator: () => ({
            elementHandle:
              stage === "elementHandle" ? never : async () => ({ contentFrame: never }),
          }),
        },
        advanceMs: 10_000,
      });
      expect(captured).toMatchObject({
        detail: { timeoutMs: 10_000, pendingStages: expect.arrayContaining(["frames"]) },
      });
    },
  );

  it("reports a frame that didn't answer as the frame's own timeout", async () => {
    const main = {};
    // A desktop tab refuses frame sessions, so the frame is read in its own world.
    const child = { evaluate: never, parentFrame: () => main };
    const captured = await stalledSnapshot({
      page: {
        mainFrame: () => main,
        frames: () => [main, child],
        context: () => ({
          newCDPSession: () =>
            Promise.reject(new Error("Only this preview tab's page can be attached")),
        }),
        ariaSnapshot: async () => "- iframe [ref=f1]:\n  - text: inside",
        locator: () => ({
          elementHandle: async () => ({ contentFrame: async () => child, dispose: async () => {} }),
        }),
      },
      // Both attempts wait out the frame; neither reaches the capture deadline.
      advanceMs: 2_000,
    });
    expect(captured).toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { timeoutMs: 1_000, pendingStages: ["frames"] },
    });
  });
});

describe("server browser capture deadlines", () => {
  it("releases control after an unanswered capture and ignores its late reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const captured = Promise.withResolvers<{ data: string }>();
      const send = vi.fn(async (method: string) =>
        method === "Page.captureScreenshot"
          ? captured.promise
          : { result: { value: "still responsive" } },
      );
      const cdp = { send } as unknown as CDPSession;
      const control = new SessionControl("agent");
      let outcome: unknown;
      const capture = control
        .agent("agent", () => ServerBrowserPage.captureViewport(cdp, { format: "png" }))
        .catch((cause: unknown) => {
          outcome = cause;
        });
      const evaluation = control.agent("agent", () =>
        ServerBrowserPage.evaluate(cdp, { expression: "document.title" }, 1_000),
      );

      await vi.advanceTimersByTimeAsync(3_000);
      expect(outcome).toMatchObject({
        tag: "PreviewAutomationExecutionError",
        message: expect.stringContaining("not producing screenshot frames"),
      });
      await capture;
      expect(await evaluation).toBe("still responsive");
      expect(vi.getTimerCount()).toBe(0);

      captured.resolve({ data: "late-frame" });
      await captured.promise;
      expect(outcome).toBeInstanceOf(ServerBrowserPage.ServerBrowserOperationError);
      expect(send.mock.calls.map(([method]) => method)).toEqual([
        "Page.captureScreenshot",
        "Runtime.evaluate",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser element refs", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = () =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]!, timeoutMs: 1_000 });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
      timeoutMs: 1_000,
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("tells a click target that matches nothing from one that never becomes clickable", async () => {
    await page.setContent(`<button hidden>hidden</button>`);
    const failure = (selector: string) =>
      ServerBrowserPage.click(page, { selector, timeoutMs: 500 }).then(
        () => expect.unreachable(),
        ServerBrowserPage.toOperationError,
      );

    const absent = await failure(".definitely-no-such-t3-target");
    expect(absent.tag).toBe("PreviewAutomationTimeoutError");
    expect(absent.message).toBe(
      'The click may have happened and removed its target or navigated; check the page before retrying. No element matches ".definitely-no-such-t3-target" after the timeout; take a fresh snapshot and use its locator.',
    );
    expect(absent.cause).toMatchObject({ name: "TimeoutError" });
    const hidden = await failure("button");
    expect(hidden.tag).toBe("PreviewAutomationTimeoutError");
    expect(hidden.message).toBe(
      'The click may have happened; check the page before retrying. "button" still matches an element after the timeout. Playwright last saw: element is not visible.',
    );
  });

  it("gives a late target only the click's remaining time, not a fresh timeout", async () => {
    await page.setContent(`<script>
      setTimeout(() => document.body.insertAdjacentHTML("beforeend",
        '<button id="save" disabled onclick="document.body.dataset.clicked = 1">Save</button>'), 1000);
      setTimeout(() => document.querySelector("#save").disabled = false, 2500);
    </script>`);
    await expect(
      ServerBrowserPage.click(page, { selector: "#save", timeoutMs: 2_000 }),
    ).rejects.toThrow();
    expect(await page.locator("body").getAttribute("data-clicked")).toBeNull();
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("types after a click by coordinates into a shadow-root field, and refuses a field inside an editable frame", async () => {
    await page.setContent(
      `<div id="host"></div><div contenteditable="true"><iframe srcdoc="<input id=inner>"></iframe></div><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML = "<input id=field>";</script>`,
    );
    const field = page.locator("#host #field");
    const box = (await field.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await ServerBrowserPage.type(page, { text: "shadow" });
    expect(await field.inputValue()).toBe("shadow");

    // Refused for now: focus inside a frame cannot be checked from the top document.
    const inner = page.frameLocator("iframe").locator("#inner");
    await inner.click();
    await expect(ServerBrowserPage.type(page, { text: "frame" })).rejects.toMatchObject({
      tag: "PreviewAutomationTargetNotEditableError",
    });
    expect(await inner.inputValue()).toBe("");
  });

  it("shows dotted fields as dots wherever their value appears, keeping text values and refs", async () => {
    await page.setContent(`
      <table><tr><td>password:</td><td><input id="pw" type="password" aria-label="Password"></td></tr></table>
      <input aria-label="Username" value="maria">
      <input type="password" aria-label='saved" [ref=e2]: x' placeholder="hint" value="saved-pass">
      <input type="password" role="combobox" aria-label="Code" value="role-pass">
      <input aria-label="PIN" style="-webkit-text-security: disc" value="styled-pass">
      <div contenteditable style="-webkit-text-security: disc">editable-pass</div>
      <iframe srcdoc="<input type=password aria-label=child value=frame-pass>"></iframe>
      <iframe id="blank" src="javascript:false"></iframe>
      <p>Order styled-pass-2</p>
      <script>
        // A frame that never commits a document, filled by its parent.
        blank.contentDocument.body.innerHTML = "<input type=password aria-label=blank value=blank-pass>";
        // Page script can't change the value the snapshot sees.
        Object.defineProperty(HTMLInputElement.prototype, "value", { get: () => "" });
      </script>`);
    await page.frameLocator("iframe[srcdoc]").getByRole("textbox").waitFor();
    await ServerBrowserPage.type(page, { locator: "#pw", text: "typed-pass" });
    const result = await takeSnapshot();
    const tree = String(result.accessibilityTree);
    expect(tree).toContain('textbox "blank"');
    expect(tree).not.toMatch(
      /typed-pass|saved-pass|role-pass|styled-pass|editable-pass|frame-pass|blank-pass/,
    );
    expect(result.visibleText).not.toContain("editable-pass");
    expect(result.visibleText).toContain("Order ••••••••-2");
    expect(tree).toMatch(/textbox "Username" [^\n]*: maria$/m);
    const line = tree.split("\n").find((line) => line.includes('textbox "Password"'));
    expect(line).toMatch(/: •+$/);
    await ServerBrowserPage.type(page, { locator: locators(line)[0]!, text: "next", clear: true });
    expect(await page.locator("#pw").inputValue()).toBe("next");
  });

  it("masks dotted values in page text next to punctuation, with odd spaces, and at the cut", async () => {
    await page.setContent(`
      <input type="password" aria-label="PIN" value="123">
      <input type="password" aria-label="Phrase" value="open&nbsp;sesame">
      <p>PIN: 123. Code (123) id 1234</p>
      <p>open&nbsp;sesame</p>`);
    const text = (await takeSnapshot()).visibleText;
    expect(text).toContain("PIN: ••••••••. Code (••••••••) id 1234");
    expect(text).not.toMatch(/open|sesame/);
    await page.setContent(`
      <p>${"x".repeat(19_995)}long-secret</p>
      <input type="password" aria-label="Long" value="long-secret">`);
    const cut = (await takeSnapshot()).visibleText;
    expect(cut.length).toBe(20_000);
    expect(cut.slice(-8)).toBe("xxx•••••");
  });

  it("shows a data: link or blocked data: navigation by media type only", async () => {
    // Chromium keeps raw spaces and quotes in both, so a payload can't be cut at either.
    await page.setContent(`
      <a download href="data:text/plain;charset=&quot;a,b&quot;,head PAYLOAD'tail">Key</a>
      <a href="https://example.com/data:report,2026">Report</a>
      <a href="#">data:text/plain,label</a>
      <a href='"data:text/plain,relative'>Relative</a>
      <a href=" data:text/plain,PAYLOAD">Spaced</a>
      <a href="da&#9;ta:text/plain,PAYLOAD">Tabbed</a>
      <a href="data:text/plain,head&#x2028;PAYLOAD">Separated</a>
      <a href="data:PAYLOAD,x">Typeless</a>
      <a href="&#11;data:text/plain,PAYLOAD">Vertical tab</a>
      <a href="&#8;data:text/plain,PAYLOAD">Backspace</a>
      <a id="controlled">Controlled</a>
      <a id="escaped">Escaped</a>
      <script>
        controlled.href = "\\x01data:text/plain,PAYLOAD";
        escaped.href = "\\x02da\\tta:text/plain,PAYLOAD";
      </script>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree.match(/\/url: data:text\/plain,…$/gm)).toHaveLength(8);
    expect(tree).toContain("/url: data:,…");
    expect(tree).toContain("/url: https://example.com/data:report,2026");
    expect(tree).toMatch(/link "data:text\/plain,label" \[ref=t3-/);
    expect(tree).not.toMatch(/PAYLOAD|tail|charset|\u2028/);
    expect(tree).toContain('/url: "\\"data:text/plain,relative"');
  });

  it("redacts a data: link whose scheme a password value would mask", async () => {
    await page.setContent(`
      <input type="password" aria-label="Scheme" value="data">
      <a download href="data:text/plain,PAYLOAD">Key</a>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree).toContain("/url: ••••••••:text/plain,…");
    expect(tree).not.toContain("PAYLOAD");
  });

  it("shows a data: page's own URL by media type only", async () => {
    await page.goto("data:text/html,<title>Key</title>PAYLOAD");
    expect((await takeSnapshot()).url).toBe("data:text/html,…");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("evaluates top-level await and returns the last expression's value", async () => {
    await page.setContent("<title>Ready</title>");
    const result = await ServerBrowserPage.evaluate(
      cdp,
      { expression: "await Promise.resolve(); document.title" },
      5_000,
    );
    expect(result).toBe("Ready");
  });

  it("returns object contents even when a legacy caller asks for a remote reference", async () => {
    const input = decodeEvaluateInput({
      expression: "({ answer: 42, nested: { ready: true } })",
      returnByValue: false,
    });
    const result = await ServerBrowserPage.evaluate(cdp, input, 5_000);
    expect(result).toEqual({ answer: 42, nested: { ready: true } });
  });

  it("still awaits the promise an async function returns", async () => {
    const result = await ServerBrowserPage.evaluate(
      cdp,
      { expression: "(async () => { await 0; return 1 })()" },
      5_000,
    );
    expect(result).toBe(1);
  });

  it("does not rerun an expression whose SyntaxError is thrown at runtime", async () => {
    const evaluation = ServerBrowserPage.evaluate(
      cdp,
      { expression: "window.runs = (window.runs ?? 0) + 1; new Function('await 0')" },
      5_000,
    );
    await expect(evaluation).rejects.toThrow("await is only valid");
    expect(await page.evaluate("window.runs")).toBe(1);
  });

  it("does not rerun an expression whose awaited browser call rejects with a SyntaxError", async () => {
    let posts = 0;
    await page.route("http://preview.test/**", (route) => {
      if (route.request().method() === "POST") posts++;
      return route.fulfill({ contentType: "text/html", body: "<title>Ready</title>" });
    });
    await page.goto("http://preview.test/");
    const evaluation = ServerBrowserPage.evaluate(
      cdp,
      {
        expression:
          "(async () => { const r = await fetch('/api', { method: 'POST' }); return r.json() })()",
      },
      5_000,
    );
    await expect(evaluation).rejects.toThrow("is not valid JSON");
    expect(posts).toBe(1);
  });

  it("returns the result of a top-level await expression that reloads the page", async () => {
    await page.route("http://preview.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Ready</title>" }),
    );
    await page.goto("http://preview.test/");
    const result = await ServerBrowserPage.evaluate(
      cdp,
      { expression: "await 0; location.reload(); ({ clicked: true })" },
      5_000,
    );
    expect(result).toEqual({ clicked: true });
  });
});

describe("server browser snapshot screenshot", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    // ServerBrowserContexts launches with these, and the capture scale depends on them.
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--force-device-scale-factor=2"],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
  });
  afterEach(async () => {
    await context.close();
  });

  // Blue on the left half and red on the right, so a mirrored left half shows up on the right.
  const halves = (overlay: string) => `
    <style>
      body { margin: 0; background: white; }
      .half { position: absolute; top: 0; width: 640px; height: 800px; }
      .overlay { position: fixed; inset: 0; ${overlay} }
    </style>
    <div class="half" style="left: 0; background: #2563eb"></div>
    <div class="half" style="left: 640px; background: #ef4444"></div>
    <div class="overlay"></div>`;

  const screenshotOf = async (html: string) => {
    const page = await context.newPage();
    await page.setContent(html);
    const input = {
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      fullScreenshot: true,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    };
    const { screenshot, fullScreenshot } = await ServerBrowserPage.snapshot(input);
    // The server has no DOM types, so the decoder runs as page source.
    const points = [
      [0.15, 0.75],
      [0.85, 0.25],
      [0.85, 0.75],
    ];
    const pixels = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(screenshot.data)}), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return ${JSON.stringify(points)}.map(([x, y]) =>
        Array.from(context.getImageData(x * bitmap.width, y * bitmap.height, 1, 1).data),
      );
    })()`)) as Array<[number, number, number, number]>;
    return { screenshot, fullScreenshot, pixels, input };
  };
  const colorOf = ([red, green, blue]: readonly [number, number, number, number]) =>
    blue - red > 100 ? "blue" : red - blue > 100 ? "red" : `rgb(${red}, ${green}, ${blue})`;

  it("captures a blurred backdrop-filter page as rendered, not mirrored", async () => {
    const { screenshot, pixels } = await screenshotOf(halves("backdrop-filter: blur(4px);"));

    expect({
      size: [screenshot.width, screenshot.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], colors: ["blue", "red", "red"] });
  });

  it("captures a plain page at the shrunk size with its content in place", async () => {
    const { screenshot, fullScreenshot, pixels, input } = await screenshotOf(halves(""));
    const metadata = await ServerBrowserPage.snapshotMetadata(input);

    expect({
      size: [screenshot.width, screenshot.height],
      fullSize: [fullScreenshot?.width, fullScreenshot?.height],
      metadataSize: metadata.screenshot,
      colors: pixels.map(colorOf),
    }).toEqual({
      size: [1280, 800],
      fullSize: [2560, 1600],
      metadataSize: { width: 1280, height: 800 },
      colors: ["blue", "red", "red"],
    });
  });

  it("records the destination of a finite entrance animation without waiting on infinite ones", async () => {
    const page = await context.newPage();
    await page.setContent(`
      <style>
        body { margin: 0; background: #2563eb; }
        @keyframes enter { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { from { opacity: 0.5; } to { opacity: 1; } }
        button { animation: pulse 2s infinite; }
        #paused { animation: enter 2s paused; }
        #overlay { display: none; position: fixed; inset: 0; background: #ef4444; }
        #overlay.open { display: block; animation: enter 200ms both; }
      </style>
      <button onclick="document.querySelector('#overlay').classList.add('open')">Open</button>
      <div id="paused"></div>
      <div id="overlay"></div>
    `);
    await page.getByRole("button", { name: "Open" }).click();
    const frame = await ServerBrowserPage.captureFinalRecordingFrame(
      await context.newCDPSession(page),
      80,
    );
    expect(frame).toBeDefined();
    const pixel = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(frame)}), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return Array.from(context.getImageData(bitmap.width / 2, bitmap.height / 2, 1, 1).data);
    })()`)) as [number, number, number, number];
    expect(colorOf(pixel)).toBe("red");
  });

  it("shrinks the screenshot of an XML document, whose createElement makes no canvas", async () => {
    const page = await context.newPage();
    await page.goto("data:text/xml,<a/>");
    const { screenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });

    expect([screenshot.width, screenshot.height]).toEqual([1280, 800]);
  });
});

describe("server browser drag", () => {
  it("fails the drag, not the server, when it times out while the cursor is still moving", async () => {
    const timedOut = new Error("locator.dragTo: Timeout 30000ms exceeded.");
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const targetBox = Promise.withResolvers<typeof box>();
    const page = {
      locator: (selector: string) =>
        selector === "#card"
          ? {
              scrollIntoViewIfNeeded: async () => {},
              boundingBox: async () => box,
              dragTo: () => Promise.reject(timedOut),
            }
          : { boundingBox: () => targetBox.promise },
    } as unknown as Page;
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const settled = ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }).then(
        () => null,
        (error: unknown) => error,
      );
      void settled.then(() => (finished = true));
      // Two macrotask turns: Node reports a rejection nobody observed after the first.
      for (let turn = 0; turn < 2; turn++) {
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node emits unhandledRejection only between macrotasks; no promise can mark that point.
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(finished).toBe(false);
      targetBox.resolve(box);

      expect(await settled).toBe(timedOut);
      expect(unobserved).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("moves the mouse after dragstart, so pages that track a drag with mousemove see it", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div style="display:flex;gap:40px">
          <div id="source" draggable="true" style="width:200px;height:120px">source</div>
          <div id="target" style="width:200px;height:120px">target</div>
        </div>
        <script>
          window.events = [];
          let dragging = false;
          source.addEventListener("dragstart", (event) => {
            event.preventDefault();
            dragging = true;
            events.push("dragstart");
          });
          addEventListener("mousemove", () => dragging && events.push("mousemove"));
          addEventListener("mouseup", () => events.push("mouseup"));
        </script>`);

      await ServerBrowserPage.drag(page, { source: "#source", target: "#target" });

      const events = (await page.evaluate("window.events")) as Array<string>;
      expect(events.slice(0, 2)).toEqual(["dragstart", "mousemove"]);
      expect(events.at(-1)).toBe("mouseup");
    } finally {
      await browser.close();
    }
  });
});

describe("server browser action timeout", () => {
  type StepOptions = { readonly timeout?: number };
  it.each([
    {
      action: "hover",
      act: (page: Page) => ServerBrowserPage.hover(page, { selector: "#a", timeoutMs: 9_000 }),
      last: ["#a.hover 1"],
    },
    {
      action: "drag",
      act: (page: Page) =>
        ServerBrowserPage.drag(page, { source: "#a", target: "#b", timeoutMs: 9_000 }),
      last: ["#a.dragTo 1", "#b.boundingBox 1"],
    },
  ])("gives the $action's steps one shared timeout", async ({ act, last }) => {
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    const steps: Array<string> = [];
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const page = {
      locator: (selector: string) => {
        const record = (step: string, options: StepOptions) =>
          steps.push(`${selector}.${step} ${options.timeout}`);
        return {
          // Each step that finds the target takes 5 of the 9 seconds.
          scrollIntoViewIfNeeded: async (options: StepOptions) => {
            record("scrollIntoViewIfNeeded", options);
            now += 5_000;
          },
          boundingBox: async (options: StepOptions) => {
            record("boundingBox", options);
            now += 5_000;
            return box;
          },
          hover: async (options: StepOptions) => record("hover", options),
          dragTo: async (_target: unknown, options: StepOptions) => record("dragTo", options),
        };
      },
    } as unknown as Page;

    await act(page);

    expect(steps).toEqual(["#a.scrollIntoViewIfNeeded 9000", "#a.boundingBox 4000", ...last]);
  });
});

describe("server browser click", () => {
  it("clicks a target the page replaced while it was being scrolled into view", async () => {
    let scrolls = 0;
    const clicks: Array<unknown> = [];
    const page = {
      locator: () => ({
        // Playwright resolves the node once; a page re-rendering it detaches that node.
        scrollIntoViewIfNeeded: async () => {
          if (scrolls++ === 0) {
            throw new Error("locator.scrollIntoViewIfNeeded: Element is not attached to the DOM");
          }
        },
        boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 20 }),
        click: async (options: unknown) => {
          clicks.push(options);
        },
        count: async () => 1,
      }),
      once: () => {},
      off: () => {},
    } as unknown as Page;

    await expect(ServerBrowserPage.click(page, { selector: "#save" })).resolves.toEqual({
      x: 10,
      y: 10,
    });
    expect(clicks).toHaveLength(1);
  });

  it("retries a replaced target only within the action's timeout", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: Array<number | undefined> = [];
      const clicks: Array<unknown> = [];
      const detached = new Error(
        "locator.scrollIntoViewIfNeeded: Element is not attached to the DOM",
      );
      const page = {
        locator: () => ({
          scrollIntoViewIfNeeded: async (options?: { timeout?: number }) => {
            timeouts.push(options?.timeout);
            vi.advanceTimersByTime(60);
            throw detached;
          },
          click: async (options: unknown) => {
            clicks.push(options);
          },
        }),
      } as unknown as Page;

      await expect(
        ServerBrowserPage.click(page, { selector: "#save", timeoutMs: 100 }),
      ).rejects.toBe(detached);
      expect(timeouts).toEqual([100, 40]);
      expect(clicks).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser evaluate", () => {
  it("does not retry a parse error that arrives after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const classic = Promise.withResolvers<unknown>();
      const send = vi.fn((method: string) =>
        method === "Runtime.evaluate" ? classic.promise : Promise.resolve({}),
      );
      const cdp = { send } as unknown as CDPSession;
      const evaluation = ServerBrowserPage.evaluate(cdp, { expression: "await 0; 1" }, 10);
      const rejected = expect(evaluation).rejects.toMatchObject({
        tag: "PreviewAutomationTimeoutError",
      });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      classic.resolve({
        result: { type: "object" },
        exceptionDetails: {
          text: "Uncaught",
          scriptId: "4",
          exception: { type: "object", className: "SyntaxError" },
        },
      });
      await classic.promise;
      expect(send.mock.calls.map(([method]) => method)).toEqual([
        "Runtime.evaluate",
        "Runtime.terminateExecution",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser type", () => {
  // As on a desktop tab whose Playwright utility world never answers.
  const stalledPage = (focusAnswer: () => Promise<unknown>, typed: string[]) =>
    ({
      locator: () => ({ last: () => ({ count: () => new Promise<number>(() => {}) }) }),
      evaluate: focusAnswer,
      keyboard: { insertText: async (text: string) => void typed.push(text) },
    }) as unknown as Page;

  it("types into the focused field when Playwright's utility world never answers", async () => {
    vi.useFakeTimers();
    try {
      const typed: string[] = [];
      let outcome: unknown = "pending";
      const page = stalledPage(async () => true, typed);
      void ServerBrowserPage.type(page, { text: "hello", timeoutMs: 300 }).then(
        () => (outcome = "typed"),
        (error: unknown) => (outcome = error),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(outcome).toBe("typed");
      expect(typed).toEqual(["hello"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at its timeout without typing when the page never answers", async () => {
    vi.useFakeTimers();
    try {
      const typed: string[] = [];
      let outcome: unknown = "pending";
      const page = stalledPage(() => new Promise(() => {}), typed);
      void ServerBrowserPage.type(page, { text: "hello", timeoutMs: 300 }).then(
        () => (outcome = "typed"),
        (error: unknown) => (outcome = error),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(outcome).toMatchObject({
        tag: "PreviewAutomationTimeoutError",
        detail: { timeoutMs: 300 },
      });
      expect(typed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser unresponsive script", () => {
  it("leaves a page that answers alone", async () => {
    const send = vi.fn(async (_method: string) => ({}));
    await ServerBrowserPage.stopUnresponsiveScript({ send } as unknown as CDPSession);
    expect(send.mock.calls.map(([method]) => method)).toEqual(["Runtime.evaluate"]);
  });
});

describe("server browser wait", () => {
  it("ends at its timeout when a check never answers", async () => {
    // As on a desktop tab whose Playwright utility world never answers.
    const page = {
      locator: () => ({ count: () => new Promise<number>(() => {}) }),
    } as unknown as Page;
    vi.useFakeTimers();
    try {
      let failure: unknown;
      void ServerBrowserPage.waitFor(page, { selector: "button", timeoutMs: 300 }).catch(
        (error: unknown) => (failure = error),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(failure).toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser net errors", () => {
  it.each([
    ["net::ERR_CONNECTION_REFUSED", "ERR_CONNECTION_REFUSED", -102],
    [
      "page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://localhost:5173/",
      "ERR_HTTP2_PROTOCOL_ERROR",
      -2,
    ],
    ["net::ERR_TLS13_DOWNGRADE_DETECTED", "ERR_TLS13_DOWNGRADE_DETECTED", -2],
  ])("reads the whole error name from %j", (errorText, description, code) => {
    expect(ServerBrowserPage.parseNetError(errorText)).toEqual({ description, code });
  });
});

/**
 * A real headless Chromium driven through the same scripts the server installs. Packets are
 * decoded back to PCM and measured, so a test can tell silence from sound rather than only
 * counting packets.
 */
describe("server browser audio capture", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    // pull_request runs Playwright's defaults, including the headless shell's --mute-audio,
    // which silences the browser's own output while capture still sees the page's audio.
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const BINDING = "__t3AudioTest";

  /**
   * Opus holds 60 ms of lookahead at 20 ms a frame, so a mix that goes silent still emits the
   * three frames in flight plus the one the flush is draining. Anything past that means the
   * tap is still feeding the encoder.
   */
  const ENCODER_TAIL_PACKETS = 4;

  /** Everything the server installs with a tab, then a capture only when it is asked for. */
  const installTab = async () => {
    const packets: Array<{ data: Uint8Array; timestampMicros: number }> = [];
    const captures: Array<{ run: string; available: boolean }> = [];
    const waiters: Array<{ count: number; resolve: () => void }> = [];
    const announceWaiters: Array<{ count: number; resolve: () => void }> = [];
    const arrived = () => {
      for (const waiter of waiters.filter((waiter) => packets.length >= waiter.count)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    };
    cdp.on("Runtime.bindingCalled", (event) => {
      if (event.name !== BINDING) return;
      const message = ServerBrowserPage.parseAudioTapMessage(event.payload);
      if (message.run !== null && message.available !== null) {
        captures.push({ run: message.run, available: message.available });
        // The capture's own announcement is the completion signal for installing it.
        for (const waiter of announceWaiters.filter((waiter) => captures.length >= waiter.count)) {
          announceWaiters.splice(announceWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      if (message.chunk === null) return;
      packets.push(message.chunk);
      arrived();
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Runtime.addBinding", { name: BINDING });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: ServerBrowserPage.audioTrackerScript,
      runImmediately: true,
    });
    // Test-only observation: the capture flushes its encoder when the mix goes silent, which
    // marks the moment every frame buffered before that silence has been sent. Silence itself
    // produces no packets, so a count alone cannot say when it started.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const flush = AudioEncoder.prototype.flush;
        AudioEncoder.prototype.flush = function (...args) {
          globalThis.__t3Flushes = (globalThis.__t3Flushes ?? 0) + 1;
          return flush.apply(this, args);
        };
      })()`,
      runImmediately: true,
    });
    const capture = async () => {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: ServerBrowserPage.audioCaptureScript(BINDING),
        runImmediately: true,
      });
    };
    /** Resolves once this many packets have arrived in total, like the server's binding. */
    const reach = (count: number) =>
      new Promise<void>((resolve) =>
        packets.length >= count ? resolve() : waiters.push({ count, resolve }),
      );
    /** Resolves once this many captures have announced themselves, so one is installed. */
    const captured = (count: number) =>
      new Promise<void>((resolve) =>
        captures.length >= count ? resolve() : announceWaiters.push({ count, resolve }),
      );
    /**
     * Arms the silence marker, which the capture trips once it has flushed every frame it
     * buffered before the mix went quiet. Call it before causing silence, then `drained`.
     */
    const armSilence = () => page.evaluate("globalThis.__t3Flushes = 0");
    const drained = () =>
      expect.poll(() => page.evaluate("globalThis.__t3Flushes ?? 0")).toBeGreaterThan(0);
    return {
      packets,
      captures,
      capture,
      captured,
      reach,
      armSilence,
      drained,
      arrivals: () => packets.length,
    };
  };

  /** The loudest sample across the decoded packets, in one Opus timeline. Page code as source. */
  const loudest = async (packets: ReadonlyArray<{ data: Uint8Array }>) =>
    page.evaluate(`(async (encoded) => {
      const peaks = [];
      const decoder = new AudioDecoder({
        output: (data) => {
          const pcm = new Float32Array(data.numberOfFrames);
          data.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
          data.close();
          let peak = 0;
          for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
          peaks.push(peak);
        },
        error: () => undefined,
      });
      decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
      for (const entry of encoded)
        decoder.decode(new EncodedAudioChunk({
          type: "key",
          timestamp: 0,
          data: Uint8Array.from(atob(entry), (char) => char.charCodeAt(0)),
        }));
      await decoder.flush();
      decoder.close();
      return Math.max(0, ...peaks);
    })(${JSON.stringify(packets.map((packet) => base64(packet.data)))})`) as Promise<number>;

  const base64 = (bytes: Uint8Array) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  };

  const toneWav = () => {
    const rate = 48_000;
    const samples = rate;
    const views = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1)
        views.setUint8(offset + index, value.charCodeAt(index));
    };
    text(0, "RIFF");
    views.setUint32(4, 36 + samples * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    views.setUint32(16, 16, true);
    views.setUint16(20, 1, true);
    views.setUint16(22, 1, true);
    views.setUint32(24, rate, true);
    views.setUint32(28, rate * 2, true);
    views.setUint16(32, 2, true);
    views.setUint16(34, 16, true);
    text(36, "data");
    views.setUint32(40, samples * 2, true);
    for (let index = 0; index < samples; index += 1)
      views.setInt16(
        44 + index * 2,
        Math.round(Math.sin((2 * Math.PI * 1000 * index) / rate) * 12_000),
        true,
      );
    let binary = "";
    const bytes = new Uint8Array(views.buffer);
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return `data:audio/wav;base64,${btoa(binary)}`;
  };

  /** A page script that starts a clean 0.3-amplitude oscillator on the page's own clock. */
  const pageTone = (gain = 0.3) => `const context = new AudioContext();
    const oscillator = context.createOscillator();
    const amp = context.createGain();
    amp.gain.value = ${gain};
    oscillator.connect(amp).connect(context.destination);
    oscillator.start();
    addEventListener("click", () => context.resume());`;

  /**
   * The gesture that activates a page, which is what lets its audio graph run. `userGesture`
   * marks it as user-initiated, the way a real viewer's first click would be.
   */
  const gesture = () =>
    cdp.send("Runtime.evaluate", {
      expression: "document.body?.dispatchEvent(new MouseEvent('click', { bubbles: true }))",
      userGesture: true,
    });

  const serve = (body: string) =>
    page.route("https://audio.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html>${body}` }),
    );

  it("captures a graph that started before a viewer attached", async () => {
    // The page builds and starts its graph at document start, with no viewer and no gesture.
    await serve(`<script>${pageTone()}</script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await gesture();
    await audio.capture();

    await audio.reach(10);
    expect(await loudest(audio.packets)).toBeGreaterThan(0.05);
  });

  it("captures right-channel-only audio through a real mono downmix", async () => {
    await serve(`<script>
      const context = new AudioContext();
      const merger = context.createChannelMerger(2);
      const silence = context.createConstantSource();
      silence.offset.value = 0;
      const tone = context.createConstantSource();
      tone.offset.value = 0.4;
      // Output index 1 is the right channel; the left stays silent.
      silence.connect(merger, 0, 0);
      tone.connect(merger, 0, 1);
      merger.connect(context.destination);
      silence.start();
      tone.start();
      addEventListener("click", () => context.resume());
    </script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await gesture();

    await audio.capture();
    await audio.reach(10);
    // A left-channel-only copy of this page decodes to digital silence.
    expect(await loudest(audio.packets)).toBeGreaterThan(0.05);
  });

  it("leaves a muted media element silent, and follows its volume", async () => {
    await serve(`<audio loop></audio>`);
    const audio = await installTab();
    const src = toneWav();
    await page.goto("https://audio.test/");
    await page.evaluate(`(async (url) => {
      const element = document.querySelector("audio");
      element.src = url;
      await element.play();
    })(${JSON.stringify(src)})`);

    await audio.capture();
    await audio.reach(10);
    expect(await loudest(audio.packets)).toBeGreaterThan(0.05);

    // The element's own mute does not reach a captured track, so the capture applies it.
    await audio.armSilence();
    const mutedAt = audio.packets.length;
    await page.evaluate(`document.querySelector("audio").muted = true`);
    // The mute emptied the mix: the capture flushes only when it sees silence, so the flush
    // is the page going quiet, and nothing but the already buffered frames arrived.
    await audio.drained();
    expect(audio.packets.length - mutedAt).toBeLessThanOrEqual(ENCODER_TAIL_PACKETS);

    // Unmuting at a low volume is quiet but not silent.
    await page.evaluate(`(() => {
      const element = document.querySelector("audio");
      element.volume = 0.2;
      element.muted = false;
    })()`);
    const restoredAt = audio.packets.length;
    await audio.reach(restoredAt + 20);
    // Measured once the elements the mute left buffered are behind us: at 0.2 volume the tone
    // peaks near a fifth of its unattenuated 0.37.
    const peak = await loudest(audio.packets.slice(-10));
    expect(peak).toBeGreaterThan(0.005);
    expect(peak).toBeLessThan(0.1);
  });

  it("captures a media element the page routes through Web Audio exactly once", async () => {
    await serve(`<audio loop></audio>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    // The page owns the element's source; a second capture would double the amplitude.
    await page.evaluate(`(async (url) => {
      const element = document.querySelector("audio");
      const context = new AudioContext();
      const gain = (window.gain = context.createGain());
      gain.gain.value = 0.2;
      context.createMediaElementSource(element).connect(gain).connect(context.destination);
      element.src = url;
      await element.play();
      await context.resume();
    })(${JSON.stringify(toneWav())})`);

    await audio.capture();
    await audio.reach(20);
    // Start-up transients belong to the tap joining late, so measure once playback is steady.
    const peak = await loudest(audio.packets.slice(3, 20));
    // The page's gain is 0.2, so one copy of the tone peaks near 0.075. Capturing the element
    // as well as its graph would add a second copy, landing near twice that.
    expect(peak).toBeGreaterThan(0.02);
    expect(peak).toBeLessThan(0.12);

    // The page's own gain then silences it, with no change to the element at all.
    await audio.armSilence();
    const beforeGain = audio.packets.length;
    await page.evaluate("window.gain.gain.value = 0");
    // The page's own gain emptied the mix, which the capture follows to the silence flush.
    await audio.drained();
    expect(audio.packets.length - beforeGain).toBeLessThanOrEqual(ENCODER_TAIL_PACKETS);
  });

  it("captures a detached new Audio() the page never inserts", async () => {
    await serve(`<script>window.src = ${JSON.stringify(toneWav())}</script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await page.evaluate(`(async () => {
      const element = new Audio(window.src);
      // Nothing appends it, so only a playback hook can find it.
      await element.play();
    })()`);

    await audio.capture();
    await audio.reach(10);
    expect(await loudest(audio.packets)).toBeGreaterThan(0.05);
  });

  /**
   * The play() hook runs before playback has given the element a stream track, and the tracker
   * reports each element only once, so the capture must keep watching until the track arrives.
   */
  it("captures a detached new Audio() created after capture, once its track exists", async () => {
    await serve(`<script>window.src = ${JSON.stringify(toneWav())}</script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await gesture();
    await audio.capture();

    await page.evaluate(`(async () => {
      // A page keeps the element it plays; the capture holds it only weakly.
      window.element = new Audio(window.src);
      window.element.loop = true;
      await window.element.play();
    })()`);
    await audio.reach(10);
    expect(await loudest(audio.packets)).toBeGreaterThan(0.05);
  });

  /**
   * The page must still be able to take its element's media source after capture started: that
   * source is the page's, and a capture that consumed it would break an EQ or analyser.
   */
  it("lets the page route an element capture already tapped, and follows its gain", async () => {
    await serve(`<audio loop></audio>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await page.evaluate(`(async (url) => {
      const element = document.querySelector("audio");
      element.src = url;
      await element.play();
    })(${JSON.stringify(toneWav())})`);
    await audio.capture();
    await audio.reach(10);

    // After capture claimed the element, the page's own call still succeeds.
    const routed = await page.evaluate(`(async () => {
      const element = document.querySelector("audio");
      const context = new AudioContext();
      window.routed = context;
      window.gain = context.createGain();
      window.gain.gain.value = 0.2;
      try {
        context.createMediaElementSource(element).connect(window.gain).connect(context.destination);
      } catch (error) {
        return String(error);
      }
      await context.resume();
      return "ok";
    })()`);
    expect(routed).toBe("ok");

    // Once the page's graph carries the element, the capture takes it from there: one copy,
    // not two, and the page's own gain is authoritative. The first packets still carry the
    // element tap the page's source displaced, so measure once the graph alone is playing.
    const routedAt = audio.packets.length;
    await audio.reach(routedAt + 20);
    const peak = await loudest(audio.packets.slice(-10));
    expect(peak).toBeGreaterThan(0.02);
    expect(peak).toBeLessThan(0.12);

    await audio.armSilence();
    const beforeGain = audio.packets.length;
    await page.evaluate("window.gain.gain.value = 0");
    // The page's own gain emptied the mix, which the capture follows to the silence flush.
    await audio.drained();
    expect(audio.packets.length - beforeGain).toBeLessThanOrEqual(ENCODER_TAIL_PACKETS);
  });

  it("stops capturing when the page disconnects its graph from its destination", async () => {
    await serve(`<script>
      window.graph = new AudioContext();
      const oscillator = graph.createOscillator();
      const amp = graph.createGain();
      amp.gain.value = 0.3;
      oscillator.connect(amp);
      window.edge = amp;
      amp.connect(graph.destination);
      oscillator.start();
      addEventListener("click", () => graph.resume());
    </script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await gesture();
    await audio.capture();
    await audio.reach(10);

    // The page disconnects the node it had feeding its own speakers; capture must follow, so
    // the tap goes quiet with it.
    await audio.armSilence();
    const beforeDisconnect = audio.packets.length;
    await page.evaluate("window.edge.disconnect()");
    await audio.drained();
    expect(audio.packets.length - beforeDisconnect).toBeLessThanOrEqual(ENCODER_TAIL_PACKETS);
  });

  it("tracks a disconnect by output index as well as by destination", async () => {
    await serve(`<script>
      window.graph = new AudioContext();
      const tone = graph.createConstantSource();
      tone.offset.value = 0.3;
      window.edge = tone;
      tone.connect(graph.destination, 0);
      tone.start();
      addEventListener("click", () => graph.resume());
    </script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await gesture();
    await audio.capture();
    await audio.reach(10);

    // The output-only overload leaves nothing on the destination, so capture must stop.
    await audio.armSilence();
    await page.evaluate("window.edge.disconnect(0)");
    await audio.drained();

    // Reconnecting brings it back, so the tracker followed the removal rather than the node.
    await page.evaluate("window.edge.connect(window.graph.destination, 0)");
    const reconnectedAt = audio.arrivals();
    await audio.reach(reconnectedAt + 10);
    expect(await loudest(audio.packets.slice(reconnectedAt))).toBeGreaterThan(0.02);
  });

  it("finds a node reconnected after a capture pruned it", async () => {
    await serve(`<script>
      window.graph = new AudioContext();
      const tone = graph.createConstantSource();
      tone.offset.value = 0.3;
      window.edge = tone;
      tone.connect(graph.destination, 0);
      tone.start();
      addEventListener("click", () => graph.resume());
    </script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await gesture();
    await audio.capture();
    await audio.reach(10);

    // A capture that runs while the node is disconnected finds no edge and prunes it. Once it
    // announces itself, that capture has read the graph.
    await page.evaluate("window.edge.disconnect(0)");
    await page.evaluate("window.__t3AudioTap?.stop()");
    await audio.capture();
    await audio.captured(2);
    await page.evaluate("window.__t3AudioTap?.stop()");
    // With no viewer watching, the page reconnects it. A pruned node that could not register
    // again would stay invisible to the next capture even though it is playing.
    await page.evaluate("window.edge.connect(window.graph.destination, 0)");
    await audio.capture();
    const restartedAt = audio.arrivals();
    await audio.reach(restartedAt + 10);
    expect(await loudest(audio.packets.slice(restartedAt))).toBeGreaterThan(0.02);
  });

  // A detached element's own playing event never reaches the document.
  it.each([
    ["an attached", `document.querySelector("audio")`],
    ["a detached", `(window.element ??= Object.assign(new Audio(), { loop: true }))`],
  ])("re-taps %s media element whose src is replaced while it plays", async (_, element) => {
    await serve(`<audio loop></audio>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    const start = (url: string) =>
      page.evaluate(`(async (url) => {
        const element = ${element};
        element.src = url;
        await element.play();
      })(${JSON.stringify(url)})`);
    await start(toneWav());
    await audio.capture();
    await audio.reach(10);

    // A new src ends the captured track, so only a re-tap keeps the next item audible.
    await audio.armSilence();
    await start(toneWav());
    const replacedAt = audio.packets.length;
    await audio.reach(replacedAt + 10);
    expect(await loudest(audio.packets.slice(replacedAt))).toBeGreaterThan(0.05);
  });

  it("stops and reinstalls a capture without losing the media it had already tapped", async () => {
    await serve(`<audio loop></audio>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await page.evaluate(`(async (url) => {
      const element = document.querySelector("audio");
      element.src = url;
      await element.play();
    })(${JSON.stringify(toneWav())})`);
    await audio.capture();
    await audio.reach(10);

    await page.evaluate("window.__t3AudioTap?.stop()");
    const stoppedAt = audio.arrivals();

    await audio.capture();
    await audio.reach(stoppedAt + 10);
    expect(await loudest(audio.packets.slice(stoppedAt))).toBeGreaterThan(0.05);
  });

  it("never captures a child frame, and stops the main frame on teardown", async () => {
    // A same-origin child frame, with an oscillator of its own, is not the tab's own page.
    await serve(`<script>${pageTone()}</script><iframe id="child"></iframe>
      <script>
        const frame = document.getElementById("child");
        frame.srcdoc = "<script>" + ${JSON.stringify(pageTone())} + "<\\/script>";
      </script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await expect.poll(() => page.frames().length).toBe(2);
    const frame = page.frames()[1]!;
    await frame.waitForFunction("true");

    // Gesture both documents, so a frame that captured would be running.
    await gesture();
    await frame.evaluate("document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))");
    await audio.capture();
    await audio.reach(10);

    // Neither the tracker nor a capture exists in the frame, so it can never encode into the
    // tab's stream, at any point.
    expect(await frame.evaluate("window.__t3AudioTrack === undefined")).toBe(true);
    expect(await frame.evaluate("window.__t3AudioTap === undefined")).toBe(true);
    expect(await page.evaluate("typeof window.__t3AudioTap?.stop")).toBe("function");

    // Teardown stops the main frame's tap, which is the whole tab's capture: nothing is left
    // to keep encoding into the binding the server is about to remove.
    await page.evaluate("window.__t3AudioTap?.stop()");
    expect(await page.evaluate("window.__t3AudioTap === undefined")).toBe(true);
  });

  it("keeps working across a navigation", async () => {
    await serve(`<script>${pageTone()}</script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await gesture();
    await audio.capture();
    await audio.reach(10);

    const before = audio.arrivals();
    // The scripts are replayed into the new document, so capture comes back with it.
    await page.reload();
    await gesture();
    await audio.reach(before + 10);
    expect(await loudest(audio.packets.slice(before))).toBeGreaterThan(0.05);
  });

  it("reports an insecure origin's missing encoder instead of capturing", async () => {
    const stripping = await context.newCDPSession(page);
    await stripping.send("Page.enable");
    // Plain-HTTP pages lose WebCodecs; the capture must say so rather than fail silently.
    await stripping.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "delete globalThis.AudioEncoder;",
      runImmediately: true,
    });
    await serve(`<script>${pageTone()}</script>`);
    const audio = await installTab();
    await page.goto("https://audio.test/");
    await gesture();
    await audio.capture();
    await audio.captured(1);
    expect(audio.captures.at(-1)).toMatchObject({ available: false });
    expect(audio.packets).toHaveLength(0);
  });

  it("creates no AudioContext in a page nobody listens to", async () => {
    await serve(`<script>
      window.contexts = [];
      const create = window.AudioContext;
      window.AudioContext = function (...args) {
        window.contexts.push(args);
        return new create(...args);
      };
      window.AudioContext.prototype = create.prototype;
    </script>`);
    await installTab();
    await page.goto("https://audio.test/");
    await gesture();
    // The tracker only records; a mixer waits for a viewer.
    expect(await page.evaluate("window.contexts.length")).toBe(0);
    expect(await page.evaluate("window.__t3AudioTrack !== undefined")).toBe(true);
  });
});
