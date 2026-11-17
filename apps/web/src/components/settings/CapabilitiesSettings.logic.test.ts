import { describe, expect, it } from "vite-plus/test";
import type { RegisteredMcpServerEntry } from "@t3tools/contracts";

import { defaultToolName, validateEntry } from "./CapabilitiesSettings.logic";

const entry = (overrides: Partial<RegisteredMcpServerEntry> = {}): RegisteredMcpServerEntry => ({
  id: "notes-a",
  name: "Notes A",
  toolName: "notes_a",
  enabled: true,
  source: { kind: "server.json", document: {} },
  config: {},
  ...overrides,
});

describe("defaultToolName", () => {
  it("slugs a name into a usable tool prefix", () => {
    expect(defaultToolName("Notes A")).toBe("notes_a");
    expect(defaultToolName("   ")).toBe("mcp_server");
  });
});

describe("validateEntry", () => {
  it("refuses a server whose name becomes an id another server already has", () => {
    expect(validateEntry(entry(), [])).toBeNull();
    // Both names slug to `notes-a`, so the second registration would replace the first's page.
    expect(validateEntry(entry({ name: "Notes-A", toolName: "notes_dash" }), [entry()])).toBe(
      "A server whose name becomes that same id is already registered. Choose another name.",
    );
  });

  it("reports the other reasons a registration is refused", () => {
    expect(validateEntry(entry({ toolName: "Notes" }), [])).toContain("lowercase letter");
    expect(validateEntry(entry({ toolName: "taken" }), [entry({ toolName: "taken" })])).toBe(
      "Another registered server already uses that tool name.",
    );
    expect(
      validateEntry(entry({ name: "Notes A", toolName: "notes_again" }), [entry({ id: "other" })]),
    ).toBe("A server with that name is already registered.");
  });
});
