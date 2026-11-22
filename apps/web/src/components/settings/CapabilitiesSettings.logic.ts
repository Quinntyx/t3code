import {
  maxMcpToolPrefixLength,
  mcpServerIdFromName,
  type RegisteredMcpServerEntry,
} from "@t3tools/contracts";
import { isValidMcpToolName } from "@t3tools/shared/mcpRegistration";

import { msg } from "gt-react";
import { m } from "~/i18n/messages";

/**
 * The tool prefix a new server gets: its name slugged, without a registry name's reverse-DNS
 * namespace, which would spend most of a tool name's length (`io.github.acme/notes` is `notes`).
 */
export const defaultToolName = (name: string) => {
  const slug = mcpServerIdFromName(name.slice(name.lastIndexOf("/") + 1))
    .replaceAll("-", "_")
    .slice(0, maxMcpToolPrefixLength)
    .replace(/_+$/u, "");
  return isValidMcpToolName(slug) ? slug : "mcp";
};

/** Everything wrong with a candidate entry, so the form can refuse to save it. */
export const validateEntry = (
  candidate: RegisteredMcpServerEntry,
  others: ReadonlyArray<RegisteredMcpServerEntry>,
): string | null => {
  if (!isValidMcpToolName(candidate.toolName)) {
    return m(
      msg("The tool name must start with a lowercase letter and use only a-z, 0-9, _ and -."),
    );
  }
  if (others.some((entry) => entry.toolName === candidate.toolName)) {
    return m(msg("Another registered server already uses that tool name."));
  }
  if (others.some((entry) => entry.id === candidate.id)) {
    return m(msg("That server is already registered."));
  }
  return null;
};
