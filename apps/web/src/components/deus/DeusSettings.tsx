import { useAtomValue } from "@effect/atom-react";
import { sameDeusScope } from "@t3tools/client-runtime/state/deus";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type DeusConfiguration, type DeusScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { useDeusPanelStore } from "../../deusPanelStore";
import { useProjects } from "../../state/entities";
import { deusEnvironment } from "../../state/deus";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "../settings/settingsLayout";
import { ProjectDeusEntry } from "./ProjectDeusEntry";

function DeusVoiceActions({ target }: { target: DeusScope }) {
  const voice = useDeusPanelStore((state) => state.voice);
  const canAttach = useAtomValue(deusEnvironment.attach.permissionAtom(target.environmentId));
  const canControl = useAtomValue(
    deusEnvironment.mediaControl.permissionAtom(target.environmentId),
  );
  const controls = voice && sameDeusScope(voice.target, target) ? voice.controls : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!controls?.ready || controls.active || !canAttach}
          onClick={() => controls?.connect()}
        >
          Connect voice
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!controls?.active}
          onClick={() => controls?.disconnect()}
        >
          Disconnect voice
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!controls?.active || !canControl}
          onClick={() => controls?.toggleMute()}
        >
          {controls?.muted ? "Resume microphone" : "Mute microphone"}
        </Button>
      </div>
      {!controls ? (
        <p className="text-xs text-muted-foreground">
          Open Deus at this destination before connecting voice. Opening never captures the
          microphone.
        </p>
      ) : null}
    </div>
  );
}
export function DeusSettings({ target }: { target: DeusScope }) {
  const allowed = useAtomValue(deusEnvironment.getSettings.permissionAtom(target.environmentId));
  const writable = useAtomValue(
    deusEnvironment.updateSettings.permissionAtom(target.environmentId),
  );
  const get = useAtomCommand(deusEnvironment.getSettings, { reportFailure: false });
  const update = useAtomCommand(deusEnvironment.updateSettings, { reportFailure: false });
  const [configuration, setConfiguration] = useState<DeusConfiguration | null>(null);
  const [draft, setDraft] = useState({ textModel: "", liveModel: "", voice: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await get({ environmentId: target.environmentId, input: target });
      if (result._tag === "Success") {
        setConfiguration(result.value);
        const { textModel, liveModel, voice } = result.value.settings;
        setDraft({ textModel: textModel ?? "", liveModel: liveModel ?? "", voice: voice ?? "" });
      } else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Settings unavailable.");
      }
    } finally {
      setBusy(false);
    }
  };
  const save = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await update({
        environmentId: target.environmentId,
        input: {
          ...target,
          patch: {
            enabled,
            textModel: draft.textModel.trim() || null,
            liveModel: draft.liveModel.trim() || null,
            voice: draft.voice.trim() || null,
          },
        },
      });
      if (result._tag === "Success") setConfiguration(result.value);
      else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Settings update failed.");
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title="Deus">
      <div className="space-y-3">
        <p className="break-all text-xs text-muted-foreground">
          Destination {target.environmentId} / {target.projectId}. Voice models and credential
          readiness belong to this environment, not this client.
        </p>
        <ProjectDeusEntry projectRefs={[target]} />
        <DeusVoiceActions target={target} />
        <Button size="sm" variant="outline" disabled={!allowed || busy} onClick={() => void load()}>
          Load Deus settings
        </Button>
        {error ? <p role="alert">{error}</p> : null}
        {configuration ? (
          <>
            <p role="status">
              Credential {configuration.credentialConfigured ? "configured" : "not configured"} ·
              Deus {configuration.settings.enabled ? "enabled" : "disabled"}
            </p>
            {(["textModel", "liveModel", "voice"] as const).map((key) => (
              <label key={key} className="block space-y-1">
                <span>
                  {key === "textModel"
                    ? "Text model"
                    : key === "liveModel"
                      ? "Live model"
                      : "Voice"}
                </span>
                <Input
                  value={draft[key]}
                  disabled={!writable || busy}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                />
              </label>
            ))}
            <div className="flex gap-2">
              <Button size="sm" disabled={!writable || busy} onClick={() => void save(true)}>
                Save and enable Deus
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!writable || busy}
                onClick={() => void save(false)}
              >
                Save and disable Deus
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}
export function DeusProviderSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [selected, setSelected] = useState("");
  const project = projects.find((item) => item.id === selected) ?? projects[0];
  if (!project)
    return (
      <p className="text-sm text-muted-foreground">
        Add a project on this environment to configure Deus.
      </p>
    );
  return (
    <div className="space-y-3">
      <label>
        Deus project destination{" "}
        <select
          aria-label="Deus project destination"
          value={project.id}
          onChange={(event) => setSelected(event.target.value)}
        >
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </label>
      <DeusSettings
        key={`${environmentId}:${project.id}`}
        target={{ environmentId, projectId: project.id }}
      />
    </div>
  );
}
