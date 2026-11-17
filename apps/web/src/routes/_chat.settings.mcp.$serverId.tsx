import { createFileRoute } from "@tanstack/react-router";
import { McpServerSettingsPanel } from "~/components/settings/McpServerSettingsPanel";

export const Route = createFileRoute("/_chat/settings/mcp/$serverId")({
  component: McpServerSettingsPanel,
});
