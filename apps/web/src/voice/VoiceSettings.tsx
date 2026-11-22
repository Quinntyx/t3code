import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Kbd } from "../components/ui/kbd";
import { SettingsSection, SettingsRow } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { primaryServerKeybindingsAtom } from "../state/server";
import { shortcutLabelForCommand } from "../keybindings";
import { voiceStorage, voiceSession, disconnectVoice } from "./controller";

const shortcuts = [
  ["voice.toggle", msg("Toggle Voice")],
  ["voice.connect", msg("Connect microphone")],
  ["voice.mute", msg("Mute / unmute")],
  ["voice.disconnect", msg("Disconnect")],
] as const;

/** The Voice panel's device-only setup, shown on the Voice settings page beside dictation. */
export function VoicePanelSettings() {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(voiceStorage.model.read);
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const saveKey = async (value: string) => {
    try {
      disconnectVoice();
      await voiceStorage.key.write(value);
      setKey("");
      if (voiceSession.getSnapshot().open) {
        // Refresh credentials without reopening a collapsed panel over Settings.
        await voiceSession.open();
      }
      setKeyStatus(
        value ? gt("Key saved on this device.") : gt("Device key removed. Voice is off."),
      );
    } catch {
      setKeyStatus(
        gt("Could not save the device key. Check browser storage or unlock your desktop keyring."),
      );
    }
  };
  return (
    <SettingsSection id="voice-panel" title={gt("Voice panel")}>
      <SettingsRow
        {...searchableSetting("voice-key")}
        title={gt("Device Gemini API key")}
        description={
          window.desktopBridge ? (
            <T>
              Stored only on this device, encrypted by the operating system keyring. Never sent to a
              T3 server. Gemini receives conversation and tool results directly. Connecting with a
              saved key may incur charges.
            </T>
          ) : (
            <T>
              Stored only on this device in browser storage. Never sent to a T3 server. Gemini
              receives conversation and tool results directly. Connecting with a saved key may incur
              charges.
            </T>
          )
        }
        status={keyStatus ? <span role="status">{keyStatus}</span> : null}
      >
        <div className="space-y-3">
          <Input
            type="password"
            autoComplete="off"
            aria-label={gt("Device Gemini API key")}
            placeholder={gt("Gemini API key")}
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
              <T>Save device key</T>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void saveKey("");
              }}
            >
              <T>Remove key</T>
            </Button>
          </div>
        </div>
      </SettingsRow>
      <SettingsRow
        {...searchableSetting("voice-model")}
        title={gt("Live model")}
        description={gt(
          "Used on the next connection. Clear to restore the default native-audio model.",
        )}
        status={modelStatus ? <span role="status">{modelStatus}</span> : null}
      >
        <div className="space-y-3">
          <Input
            aria-label={gt("Live model")}
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
                setModelStatus(gt("Device model saved. Used on the next connection."));
              } catch {
                setModelStatus(gt("Could not save the device model. Check browser storage."));
              }
            }}
          >
            <T>Save model</T>
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        {...searchableSetting("voice-shortcuts")}
        title={gt("Shortcuts")}
        description={
          <Link to="/settings/keybindings">
            <T>Customize Voice shortcuts in Keybindings.</T>
          </Link>
        }
      >
        <dl className="space-y-2 text-sm">
          {shortcuts.map(([command, label]) => (
            <div key={command} className="flex items-center justify-between gap-4">
              <dt>{m(label)}</dt>
              <dd>
                <Kbd>{shortcutLabelForCommand(keybindings, command) ?? gt("Not assigned")}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
      </SettingsRow>
    </SettingsSection>
  );
}
