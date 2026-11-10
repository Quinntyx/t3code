import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Kbd } from "../components/ui/kbd";
import {
  SettingsPageContainer,
  SettingsSection,
  SettingsRow,
} from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { primaryServerKeybindingsAtom } from "../state/server";
import { shortcutLabelForCommand } from "../keybindings";
import { voiceStorage, disconnectVoice, reloadVoice } from "./controller";

const shortcuts = [
  ["voice.toggle", "Toggle Voice"],
  ["voice.connect", "Connect microphone"],
  ["voice.mute", "Mute / unmute"],
  ["voice.disconnect", "Disconnect"],
] as const;

export function VoiceSettings() {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(voiceStorage.model.read);
  const [status, setStatus] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const saveKey = async (value: string) => {
    try {
      disconnectVoice();
      await voiceStorage.key.write(value);
      setKey("");
      // Refresh credentials without reopening a collapsed panel over Settings.
      await reloadVoice();
      setStatus(value ? "Key saved on this device." : "Device key removed. Voice is off.");
    } catch {
      setStatus(
        "Could not save the device key. Check browser storage or unlock your desktop keyring.",
      );
    }
  };
  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice">
        <SettingsRow
          {...searchableSetting("voice-key")}
          title="Device Gemini API key"
          description={
            <>
              Stored only on this device
              {window.desktopBridge
                ? ", encrypted by the operating system keyring"
                : " in browser storage"}
              . Never sent to a T3 server. Gemini receives conversation and tool results directly.
              Connecting with a saved key may incur charges.
            </>
          }
        >
          <div className="space-y-3">
            <Input
              type="password"
              autoComplete="off"
              aria-label="Device Gemini API key"
              placeholder="Gemini API key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!key.trim()}
                onClick={() => {
                  void saveKey(key);
                }}
              >
                Save device key
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void saveKey("");
                }}
              >
                Remove key
              </Button>
            </div>
          </div>
        </SettingsRow>
        <SettingsRow
          {...searchableSetting("voice-model")}
          title="Live model"
          description="Used on the next connection. Clear to restore the default native-audio model."
        >
          <div className="space-y-3">
            <Input
              aria-label="Live model"
              autoComplete="off"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                try {
                  voiceStorage.model.write(model);
                  setModel(voiceStorage.model.read());
                  setStatus("Device model saved. Used on the next connection.");
                } catch {
                  setStatus("Could not save the device model. Check browser storage.");
                }
              }}
            >
              Save model
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          {...searchableSetting("voice-shortcuts")}
          title="Shortcuts"
          description={
            <Link to="/settings/keybindings">Customize Voice shortcuts in Keybindings.</Link>
          }
        >
          <dl className="space-y-2 text-sm">
            {shortcuts.map(([command, label]) => (
              <div key={command} className="flex items-center justify-between gap-4">
                <dt>{label}</dt>
                <dd>
                  <Kbd>{shortcutLabelForCommand(keybindings, command) ?? "Not assigned"}</Kbd>
                </dd>
              </div>
            ))}
          </dl>
        </SettingsRow>
      </SettingsSection>
      <div className="flex items-center justify-between gap-3 px-4">
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      </div>
    </SettingsPageContainer>
  );
}
