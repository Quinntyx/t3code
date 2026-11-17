import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesSettingsPanel } from "../components/settings/CapabilitiesSettings";

export const Route = createFileRoute("/_chat/settings/capabilities")({
  component: CapabilitiesSettingsPanel,
});
