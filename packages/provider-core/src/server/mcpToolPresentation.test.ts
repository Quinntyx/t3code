import { describe, expect, it } from "@effect/vitest";
import { mcpToolPresentation } from "./mcpToolPresentation.ts";

describe("mcpToolPresentation", () => {
  it.each([
    "javascript:alert(1)",
    "file:///tmp/logo.png",
    "not a URL",
    "https://example.com/" + "x".repeat(4096),
  ])("ignores an invalid logo %s", (iconUrl) => {
    expect(
      mcpToolPresentation({
        serverName: "weather",
        toolName: "get_weather",
        iconUrl,
        title: "x".repeat(161),
      }),
    ).toEqual({
      title: "get weather",
      toolSource: { key: "mcp:weather", name: "weather", kind: "integration" },
    });
  });

  it.each(["t3-code", "t3_code", "t3code", "t3-code-direct", "t3-code-thread_1"])(
    "brands fallback T3 Code MCP server %s as T3 Code",
    (serverName) => {
      expect(
        mcpToolPresentation({
          serverName,
          toolName: "--help",
        }),
      ).toEqual({
        title: "help",
        toolSource: { key: "mcp:t3-code", name: "T3 Code", kind: "integration" },
      });
    },
  );
});
