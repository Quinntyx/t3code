import {
  DefaultAppearancePreference,
  DefaultThemePreference,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  EnvironmentThemeKind,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as EnvironmentTheme from "../../../environmentTheme.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const Appearance = Schema.Literals(["light", "dark", "system"]);

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    EnvironmentTheme.EnvironmentThemeService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};

const ThemeReadTool = Tool.make("t3_theme_read", {
  ...shared,
  description:
    "Read T3 Code's own themes (palettes and overlay styles) and the guide to restyle it: color roles, CSS selectors, settings, visual effects, and layout. Call before `t3_theme_set`.",
  parameters: Schema.Struct({
    themeId: Schema.optionalKey(
      EnvironmentThemeId.annotate({ description: "Also return this published theme's file." }),
    ),
  }),
  success: Schema.Struct({
    current: DefaultThemePreference,
    currentAppearance: DefaultAppearancePreference,
    currentStyle: DefaultThemePreference,
    builtIn: Schema.Array(Schema.String),
    builtInStyles: Schema.Array(Schema.String),
    published: Schema.Array(
      Schema.Struct({
        id: EnvironmentThemeId,
        name: Schema.String,
        kind: EnvironmentThemeKind,
        hasCss: Schema.Boolean,
        hasEffects: Schema.Boolean,
        hasSettings: Schema.Boolean,
        hasLayout: Schema.Boolean,
        hasBackground: Schema.Boolean,
      }),
    ),
    theme: Schema.optionalKey(EnvironmentThemeFile),
    themesDir: Schema.String,
    guide: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThemeSetTool = Tool.make("t3_theme_set", {
  ...shared,
  description:
    "Restyle T3 Code itself, only when the user asks. With `theme`, publish it under `themeId` (palette) or `styleId` (style, `version: 2, kind: 'style'`) and switch this server's web app and this machine's desktop app to it, not remote desktop apps. Without `theme`, switch `themeId` (palette), `styleId` (overlay style, or `null` to clear it), and/or `appearance` (light, dark, or system). Live full-access or default caller thread only.",
  parameters: Schema.Struct({
    themeId: Schema.optionalKey(EnvironmentThemeId),
    styleId: Schema.optionalKey(Schema.NullOr(EnvironmentThemeId)),
    theme: Schema.optionalKey(EnvironmentThemeFile),
    appearance: Schema.optionalKey(Appearance),
  }),
  success: Schema.Struct({
    themeId: Schema.optionalKey(EnvironmentThemeId),
    styleId: Schema.optionalKey(Schema.NullOr(EnvironmentThemeId)),
    appearance: Schema.optionalKey(Appearance),
    published: Schema.Boolean,
  }),
}).annotate(Tool.Destructive, true);

export const ThemeToolkit = Toolkit.make(ThemeReadTool, ThemeSetTool);
