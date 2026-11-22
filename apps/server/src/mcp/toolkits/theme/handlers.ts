import {
  type EnvironmentTheme as PublishedEnvironmentTheme,
  type EnvironmentThemeFile,
  OrchestratorMcpFailure,
  environmentThemeKind,
} from "@t3tools/contracts";
import { THEME_GUIDE } from "@t3tools/shared/themeCss";
import { BUILT_IN_STYLE_IDS, MOBILE_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Effect from "effect/Effect";
import * as EnvironmentTheme from "../../../environmentTheme.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { ThemeToolkit } from "./tools.ts";

function stripPublishedThemeFields(theme: PublishedEnvironmentTheme): EnvironmentThemeFile {
  const { id: _id, ...rest } = theme;
  if ("background" in rest) {
    const { background: _background, ...palette } = rest;
    return palette as EnvironmentThemeFile;
  }
  return rest as EnvironmentThemeFile;
}

export const layer = McpToolAccess.toLayer(ThemeToolkit, {
  t3_theme_read: McpToolAccess.reads(({ themeId }) =>
    Effect.gen(function* () {
      const themes = yield* EnvironmentTheme.EnvironmentThemeService;
      const {
        current,
        currentAppearance,
        currentStyle,
        themesDir,
        themes: published,
        theme,
      } = yield* themes.read(themeId).pipe(
        Effect.catchTags({
          EnvironmentThemeRefusedError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
            ),
          ServerSettingsError: () => Effect.fail(unavailable()),
        }),
      );
      return {
        current,
        currentAppearance,
        currentStyle,
        builtIn: MOBILE_THEME_IDS,
        builtInStyles: BUILT_IN_STYLE_IDS,
        published: published.map((entry) => ({
          id: entry.id,
          name: entry.name,
          kind: environmentThemeKind(entry),
          hasCss: Boolean(entry.css),
          hasEffects:
            "effects" in entry &&
            entry.effects !== undefined &&
            Object.keys(entry.effects).length > 0,
          hasSettings:
            "settings" in entry &&
            entry.settings !== undefined &&
            Object.keys(entry.settings).length > 0,
          hasLayout:
            "layout" in entry && entry.layout !== undefined && Object.keys(entry.layout).length > 0,
          hasBackground: "background" in entry && entry.background !== undefined,
        })),
        ...(theme === undefined ? {} : { theme: stripPublishedThemeFields(theme) }),
        themesDir,
        guide: THEME_GUIDE,
      };
    }),
  ),
  t3_theme_set: McpToolAccess.writesEnvironment(({ themeId, styleId, theme, appearance }, check) =>
    Effect.gen(function* () {
      const hasTarget = themeId !== undefined || styleId !== undefined || appearance !== undefined;
      const themeMissingId =
        theme !== undefined &&
        (environmentThemeKind(theme) === "style"
          ? (styleId === undefined || styleId === null) && themeId === undefined
          : themeId === undefined);
      if (!hasTarget || themeMissingId) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Give `themeId`, `styleId`, `appearance`, or a combination. Publishing `theme` requires `themeId` (or `styleId` for a style).",
        });
      }
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const themes = yield* EnvironmentTheme.EnvironmentThemeService;
      const set = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        yield* themes.apply({ themeId, styleId, theme, appearance }).pipe(
          Effect.catchTags({
            EnvironmentThemeRefusedError: (error) =>
              Effect.fail(
                new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
              ),
            EnvironmentThemeNotSelectedError: () => Effect.fail(unavailable()),
          }),
        );
        const resolvedStyleId =
          theme !== undefined && environmentThemeKind(theme) === "style"
            ? (styleId ?? themeId)
            : styleId;
        const resolvedThemeId =
          theme !== undefined && environmentThemeKind(theme) === "style" ? undefined : themeId;
        return {
          ...(resolvedThemeId === undefined ? {} : { themeId: resolvedThemeId }),
          ...(resolvedStyleId === undefined ? {} : { styleId: resolvedStyleId }),
          ...(appearance === undefined ? {} : { appearance }),
          published: theme !== undefined,
        };
      });
      return yield* scope.thread === undefined
        ? set
        : executor.withLock(scope.thread.threadId, set);
    }),
  ),
});
