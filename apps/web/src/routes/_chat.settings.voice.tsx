import { createFileRoute } from "@tanstack/react-router";
import { VoiceSettings } from "../voice/VoiceSettings";

export const Route = createFileRoute("/_chat/settings/voice")({
  component: VoiceSettings,
});
