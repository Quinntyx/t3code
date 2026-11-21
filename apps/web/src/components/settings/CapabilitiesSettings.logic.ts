import { mcpServerIdFromName, type RegisteredMcpServerEntry } from "@t3tools/contracts";
import { isValidMcpToolName } from "@t3tools/shared/mcpRegistration";

/** The tool prefix a new server gets: its name, slugged, or the server's own when that is usable. */
export const defaultToolName = (name: string) => {
  const slug = mcpServerIdFromName(name).replaceAll("-", "_");
  return isValidMcpToolName(slug) ? slug : "mcp";
};

/** Everything wrong with a candidate entry, so the form can refuse to save it. */
export const validateEntry = (
  candidate: RegisteredMcpServerEntry,
  others: ReadonlyArray<RegisteredMcpServerEntry>,
): string | null => {
  if (!isValidMcpToolName(candidate.toolName)) {
    return "The tool name must start with a lowercase letter and use only a-z, 0-9, _ and -.";
  }
  if (others.some((entry) => entry.toolName === candidate.toolName)) {
    return "Another registered server already uses that tool name.";
  }
  if (others.some((entry) => entry.id === candidate.id)) {
    return "That server is already registered.";
  }
  return null;
};
