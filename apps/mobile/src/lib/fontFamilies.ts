export interface UiFontFaces {
  readonly regular: string;
  readonly medium: string;
  readonly bold: string;
  /** System families have no named bold face, so bold text must request the weight. */
  readonly boldByWeight: boolean;
}

export const FONT_FAMILIES: UiFontFaces = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
  boldByWeight: false,
};

export interface FontChoice<T> {
  readonly id: string;
  readonly label: string;
  readonly value: T;
}

type FontPlatform = "ios" | "android";

function systemFaces(regular: string, medium = regular): UiFontFaces {
  return { regular, medium, bold: regular, boldByWeight: true };
}

// Registered under these names on both platforms by app.config.ts.
const ATKINSON_HYPERLEGIBLE: FontChoice<UiFontFaces> = {
  id: "atkinson-hyperlegible",
  label: "Atkinson Hyperlegible",
  value: {
    regular: "AtkinsonHyperlegible-Regular",
    medium: "AtkinsonHyperlegible-Regular",
    bold: "AtkinsonHyperlegible-Bold",
    boldByWeight: false,
  },
};
const FIRA_CODE_NERD_FONT: FontChoice<string> = {
  id: "fira-code",
  label: "Fira Code Nerd Font",
  value: "FiraCode Nerd Font",
};

// Phones cannot enumerate installed fonts, so each list names faces the OS ships or the app bundles.
const UI_FONT_CHOICES: Record<FontPlatform, ReadonlyArray<FontChoice<UiFontFaces>>> = {
  ios: [
    ATKINSON_HYPERLEGIBLE,
    { id: "system", label: "System", value: systemFaces("System") },
    {
      id: "avenir-next",
      label: "Avenir Next",
      value: {
        regular: "AvenirNext-Regular",
        medium: "AvenirNext-Medium",
        bold: "AvenirNext-Bold",
        boldByWeight: false,
      },
    },
    {
      id: "helvetica-neue",
      label: "Helvetica Neue",
      value: {
        regular: "HelveticaNeue",
        medium: "HelveticaNeue-Medium",
        bold: "HelveticaNeue-Bold",
        boldByWeight: false,
      },
    },
    {
      id: "georgia",
      label: "Georgia",
      value: { regular: "Georgia", medium: "Georgia", bold: "Georgia-Bold", boldByWeight: false },
    },
  ],
  // React Native maps Android system families to NORMAL or BOLD only, so medium needs its own family.
  android: [
    ATKINSON_HYPERLEGIBLE,
    { id: "system", label: "System", value: systemFaces("sans-serif", "sans-serif-medium") },
    {
      id: "condensed",
      label: "System Condensed",
      value: systemFaces("sans-serif-condensed", "sans-serif-condensed-medium"),
    },
    { id: "serif", label: "System Serif", value: systemFaces("serif") },
  ],
};

const CODE_FONT_CHOICES: Record<FontPlatform, ReadonlyArray<FontChoice<string>>> = {
  ios: [
    FIRA_CODE_NERD_FONT,
    { id: "sf-mono", label: "SF Mono", value: "ui-monospace" },
    { id: "menlo", label: "Menlo", value: "Menlo" },
    { id: "courier-new", label: "Courier New", value: "Courier New" },
  ],
  // Android code surfaces already default to the system monospace family.
  android: [
    FIRA_CODE_NERD_FONT,
    { id: "serif-mono", label: "Serif Mono", value: "serif-monospace" },
  ],
};

// The iOS terminal resolves names through Ghostty, which matches family names, not PostScript names.
const TERMINAL_FONT_CHOICES: Record<FontPlatform, ReadonlyArray<FontChoice<string>>> = {
  ios: [
    FIRA_CODE_NERD_FONT,
    { id: "menlo", label: "Menlo", value: "Menlo" },
    { id: "courier-new", label: "Courier New", value: "Courier New" },
  ],
  android: [
    FIRA_CODE_NERD_FONT,
    { id: "system", label: "System Mono", value: "monospace" },
    { id: "serif-mono", label: "Serif Mono", value: "serif-monospace" },
  ],
};

const DEFAULT_FONT_LABELS: Record<"ui" | "code" | "terminal", Record<FontPlatform, string>> = {
  ui: { ios: "DM Sans", android: "DM Sans" },
  code: { ios: "Default", android: "Default" },
  terminal: { ios: "JetBrains Mono", android: "Meslo LG" },
};

function fontPlatform(platform: string): FontPlatform {
  return platform === "ios" ? "ios" : "android";
}

/** Matches `--font-mono` in global.css; the iOS keyword selects SF Mono. */
export function defaultCodeFontFamily(platform: string) {
  return fontPlatform(platform) === "ios" ? "ui-monospace" : "monospace";
}

export function uiFontChoices(platform: string) {
  return UI_FONT_CHOICES[fontPlatform(platform)];
}

export function codeFontChoices(platform: string) {
  return CODE_FONT_CHOICES[fontPlatform(platform)];
}

export function terminalFontChoices(platform: string) {
  return TERMINAL_FONT_CHOICES[fontPlatform(platform)];
}

export function defaultFontLabel(role: keyof typeof DEFAULT_FONT_LABELS, platform: string) {
  return DEFAULT_FONT_LABELS[role][fontPlatform(platform)];
}

/** Unknown ids, such as one saved on the other platform, fall back to the default. */
export function findFontChoice<T>(
  choices: ReadonlyArray<FontChoice<T>>,
  id: string | null | undefined,
): FontChoice<T> | null {
  if (typeof id !== "string") return null;
  return choices.find((choice) => choice.id === id) ?? null;
}
