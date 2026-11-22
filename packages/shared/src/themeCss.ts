import { THEME_LAYOUT_KEYS, THEME_LAYOUT_OPTIONS, type ThemeLayoutKey } from "@t3tools/contracts";

import { THEME_COLOR_ROLES } from "./themePalettes.ts";

const FETCHES_BY_STRING = /image-set\(|\bsrc\(/i;
// Only CSS whitespace may come first. \s also matches U+00A0, which makes the address relative.
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;
// Read tokens left to right, as CSS does: a url( or /* inside a string loads nothing, and a quote
// in an unquoted url( or after a backslash is not a string. A quoted url() that is not data: or #id
// keeps `url(` for the check.
const ESCAPE = String.raw`\\(?:(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{1,5}(?![0-9a-fA-F]))(?:\r\n|[\n\r\f])?|\r\n|[^0-9a-fA-F])`;
const STRING = String.raw`"(?:${ESCAPE}|[^"\\\n\r\f])*"|'(?:${ESCAPE}|[^'\\\n\r\f])*'`;
const URL_OR_STRING = String.raw`url\((?![ \t\n\f\r]*["'])([^)]*)|url\([ \t\n\f\r]*(${STRING})|${STRING}|${ESCAPE}`;
const CSS_TOKENS = new RegExp(String.raw`\/\*[\s\S]*?\*\/|${URL_OR_STRING}`, "gi");

/**
 * The code with its strings and comments removed, keeping `url(` where a quoted url() can load a
 * file. A declaration value keeps a comment or quoted url() that holds an escape. In a stylesheet
 * an unquoted url() is judged by its address too.
 */
function withoutStrings(code: string, stylesheet: boolean): string {
  return code.replace(CSS_TOKENS, (token, address?: string, urlString?: string) => {
    const url = stylesheet ? (address ?? urlString) : urlString;
    if (url !== undefined) {
      if (!stylesheet && url.includes("\\")) return token;
      return /^[ \t\n\f\r]*["']?(?:data:|#)/i.test(url) ? "" : "url(";
    }
    if (token.startsWith("/*")) {
      if (stylesheet) return "";
      return token.includes("\\") ? token : " ";
    }
    return /^["']/.test(token) ? "" : token;
  });
}

function fetchesOutsideStrings(code: string): boolean {
  return FETCHES_BY_STRING.test(code) || URL_NOT_LOCAL.test(code);
}

/**
 * Whether one declaration value can load a remote file. Clients drop those declarations.
 * Values with var() can keep escapes that spell `var` or `url`. Refuse escapes that survive
 * removing plain strings, including escapes in URL addresses.
 */
export function themeCssValueFetches(value: string): boolean {
  const code = withoutStrings(value, false);
  return code.includes("\\") || fetchesOutsideStrings(code);
}

/** A text check for early feedback. CSS escapes can dodge it; the client check is the guard. */
export function themeCssLoadsRemoteFiles(css: string): boolean {
  const code = withoutStrings(css, true);
  return /@import/i.test(code) || fetchesOutsideStrings(code);
}

/**
 * Selectors that theme CSS may rely on. Other class names are Tailwind utilities and change
 * between releases. themeCss.test.ts in apps/web fails when one of these leaves the source.
 */
export const THEME_CSS_HOOKS = [
  { selector: '[data-slot="sidebar"]', styles: "app sidebar" },
  { selector: '[data-slot="sidebar-inner"]', styles: "sidebar surface" },
  { selector: "[data-sidebar-control]", styles: "sidebar toggle container" },
  { selector: "[data-thread-item]", styles: "sidebar thread row" },
  {
    selector: '[data-slot="project-monogram"]',
    styles: "project icon with letters; its svg holds the tile",
  },
  { selector: "[data-chat-header]", styles: "chat header" },
  { selector: '[data-workspace-area="conversation"]', styles: "chat area, behind the messages" },
  { selector: ".messages-timeline-scroll", styles: "chat scroller" },
  { selector: "[data-timeline-row-kind]", styles: 'chat row, such as ="message" or ="work"' },
  { selector: '[data-message-role="user"]', styles: "user message row" },
  { selector: "[data-user-message-bubble]", styles: "user message bubble" },
  { selector: '[data-message-role="assistant"]', styles: "assistant message row" },
  { selector: ".chat-markdown", styles: "assistant text" },
  { selector: ".chat-markdown-codeblock", styles: "code block" },
  { selector: "[data-chat-composer-form]", styles: "composer" },
  { selector: '[data-slot="composer-shell"]', styles: "composer outer glass shell" },
  { selector: '[data-slot="composer-host"]', styles: "composer card" },
  { selector: '[data-slot="composer-context-strip"]', styles: "composer context strip" },
  { selector: ".composer-tiptap", styles: "composer text" },
  { selector: "[data-thread-details-card]", styles: "thread details card" },
  { selector: "[data-thread-terminal-drawer]", styles: "terminal drawer" },
  { selector: '[data-slot="preview-panel-shell"]', styles: "inline preview panel" },
  { selector: '[data-slot="floating-control-bubble"]', styles: "floating corner control bubble" },
  { selector: "[data-floating-panel-controls]", styles: "floating layout controls bubble" },
  { selector: "[data-settings-page-scroll]", styles: "settings page" },
  { selector: '[data-slot="button"]', styles: "button" },
  { selector: '[data-slot="input"]', styles: "text input" },
  { selector: '[data-slot="switch"]', styles: "switch" },
  { selector: '[data-slot="select-trigger"]', styles: "select" },
  { selector: '[data-slot="dialog-popup"]', styles: "dialog" },
  { selector: '[data-slot="popover-popup"]', styles: "popover" },
  { selector: '[data-slot="menu-popup"]', styles: "menu" },
  { selector: '[data-slot="tooltip-popup"]', styles: "tooltip" },
  { selector: '[data-slot="scroll-area-scrollbar"]', styles: "overlay scrollbar" },
  { selector: '[data-slot="scroll-area-thumb"]', styles: "overlay scrollbar thumb" },
  {
    selector: "[data-thread-find-bar]",
    styles: "find-in-thread bar; leaves with data-ending-style",
  },
  {
    selector: "[data-composer-banner-stack]",
    styles: "notice above the composer; leaves with data-ending-style",
  },
  {
    selector: "[data-thread-now-line]",
    styles: "status line at the end of the timeline; leaves with data-ending-style",
  },
  {
    selector: "[data-composer-sync-status]",
    styles: "sync status line at the end of the timeline; leaves with data-ending-style",
  },
] as const;

/** What each layout region's variants move, for the guide. The first variant is stock. */
const THEME_LAYOUT_GUIDE: Readonly<Record<ThemeLayoutKey, string>> = {
  composerControls:
    "the model, context and permission controls sit inside the composer card or in a row below it, leaving the prompt and send button in the card",
  composerMeter: "a context-window ring left of the model chip",
  runContext:
    "the machine, workspace and branch controls under the composer, or one chip whose popover holds them",
  workspaceActions:
    "Run, changed files and Commit & push live in the thread details card, or in the chat header with the PR beside the title; Open in editor then also sits on the changed-files card",
  threadDetails:
    "thread details as the always-open card, or a narrow rail of agent icons whose sections open cards on hover",
  panelControls:
    "the panel toggles in the title bar, or in bottom corner bubbles without floating the panels",
  sidebarSections:
    "Working, Snoozed and Settled as collapsible sections, or bottom tabs for Idle, Working and Snoozed with Recently settled behind a footer button",
  sidebarSearch: "the sidebar's search row, or hidden with its buttons moved beside the app name",
};

/** What an agent needs to restyle the app. `t3_theme_read` returns it. */
export const THEME_GUIDE = [
  "Themes restyle T3 Code on web and desktop. Mobile does not use them.",
  "",
  'Kinds: v1 (or omitted version) and v2 `kind: "palette"` define color palettes (plus optional `css`, `settings`, `effects`, `layout`, and background images). v2 `kind: "style"` overlays `css`, `settings`, `effects`, and `layout` on top of any palette without changing colors.',
  "Use `t3_theme_set` with `themeId` for palettes, `styleId` for styles (`null` clears the style; omitting preserves it), and `appearance` for light/dark/system mode.",
  "",
  "Colors: `canvas` and `accent` (hex) derive a full palette. `colors` overrides single roles, and `variants.light` or `variants.dark` does that for the other appearance. Prefer colors over CSS.",
  `Roles: ${THEME_COLOR_ROLES.join(", ")}.`,
  "",
  "Settings (v2): optional `settings` map keyed by `[a-zA-Z][a-zA-Z0-9_-]{0,31}` (up to 32 entries). Types: `boolean`, bounded `number` (`min`, `max`, optional `step`, `unit` in `px | % | rem | em | ms | s | deg`), `select` (`options: [{ id, label }]`), and hex `color`. Optional `description` and `when: { setting, equals }`. Controls render automatically in Settings -> Appearance.",
  "Resolved setting values are exposed on `:root` as `--theme-setting-<key>` (palette) and `--theme-style-setting-<key>` (style); booleans and selects also set `data-theme-setting-<key>` / `data-theme-style-setting-<key>`.",
  "",
  'Effects (v2): optional `effects` declares `liquidGlass` (`enabled`, plus optional `blur` 0..24, `centerBlur` 0..24, `saturation` 0..200, `refraction` 0..200, `dispersion` 0..2000, `glare` 0..200), `floatingPanels` (`enabled`, toggles `data-floating-panels` on `:root`), and `ambientShimmer` (`enabled`, toggles `data-ambient-shimmer` on `:root`). Any parameter can be a literal or `{ "setting": "<key>" }`. Active styles replace palette declarations per effect.',
  "",
  'Layout (v2): optional `layout` picks a variant per region. The first variant is the stock layout. A value is a literal or `{ "setting": "<key>" }` naming a `select` setting whose option ids are that region\'s variants, so users can switch it under Settings -> Appearance. An active style replaces the palette\'s choice per region. A non-stock variant sets `data-layout-<region>="<variant>"` on `:root` (region in kebab case) for CSS. Layout moves whole controls, so change one region at a time and ask the user.',
  ...THEME_LAYOUT_KEYS.map(
    (key) =>
      `- ${key} (${THEME_LAYOUT_OPTIONS[key].map((value) => `"${value}"`).join(" | ")}): ${THEME_LAYOUT_GUIDE[key]}.`,
  ),
  "",
  "CSS: `css` applies after the app's styles (palette CSS first, style CSS second). Use `.dark` or `:root:not(.dark)` for one appearance.",
  "It cannot load files: no @import, no image-set(), and url() only with data: or #id.",
  'For a palette background image, copy a JPEG, PNG, or WebP file of up to 16 MB to `<themesDir>/<themeId>.jpg` (or .png, .webp), beside the theme file. CSS shows it with `var(--theme-background-image)`, such as `[data-workspace-area="conversation"] { background: var(--theme-background-image) center / cover no-repeat; }`. Delete the file to remove it. Do not embed images in `css`: it holds 100,000 characters.',
  'Motion: popups (`[data-slot$="-popup"]`) and the surfaces marked below carry `data-side` (the side they open from) and `data-starting-style` while entering, `data-ending-style` while leaving. A leaving surface that starts an opacity transition under `[data-ending-style]` stays on screen until it ends, so `[data-ending-style] { opacity: 0; translate: 0 4px; }` with a `transition` fades it out. Keep motion short and never loop it.',
  "The app's own rules can be more specific. If a rule has no effect, add !important.",
  "It cannot reach the terminal text, the file tree, or diff internals. Use color roles for those.",
  "Native scrollbars take `::-webkit-scrollbar` and `::-webkit-scrollbar-thumb`.",
  "Icons are `svg.lucide`. stroke-width, stroke-linecap, and stroke-linejoin restyle them.",
  "",
  "Stable selectors (other class names change between releases, so do not use them):",
  ...THEME_CSS_HOOKS.map((hook) => `- ${hook.selector}: ${hook.styles}`),
  "",
  "You cannot see the result. Make small changes, then ask the user how it looks.",
  "To undo, set `t3-code`, the stock T3 Code theme, or another built-in theme, or pass `styleId: null` to clear the style. An empty `current` means the stock theme or no environment theme.",
].join("\n");
