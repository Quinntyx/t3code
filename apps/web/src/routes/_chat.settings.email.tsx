import { createFileRoute } from "@tanstack/react-router";
import { EmailSettingsPanel } from "../components/settings/EmailSettings";

export const Route = createFileRoute("/_chat/settings/email")({
  component: EmailSettingsPanel,
});
