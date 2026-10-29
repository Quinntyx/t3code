import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_BROWSER_GPU,
  DEFAULT_SERVER_BROWSER_RENDER_SCALE,
  type EnvironmentId,
  type ServerBrowserGpuList,
  type ServerBrowserRenderScale,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { previewEnvironment } from "../../../state/preview";
import { SettingsSection } from "./SettingsSection";

const NO_GPUS_ATOM = Atom.make(AsyncResult.success<ServerBrowserGpuList>({ gpus: [] }));
const RENDER_SCALES: ReadonlyArray<ServerBrowserRenderScale> = [1, 1.5, 2, 3];
const APPLIES = "Changing this reloads the environment's open browser tabs.";

/** Null values mean the selected environments differ. */
export function BrowserRenderingSections(props: {
  readonly environmentId: EnvironmentId | null;
  readonly gpu: string | null;
  readonly scale: ServerBrowserRenderScale | null;
  readonly disabled: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
}) {
  // GPUs belong to one host, so they are listed only when one environment is selected.
  const discovered = useAtomValue(
    props.environmentId
      ? previewEnvironment.gpus({ environmentId: props.environmentId, input: {} })
      : NO_GPUS_ATOM,
  );
  const gpus = AsyncResult.isSuccess(discovered) ? discovered.value.gpus : [];
  const gpuChoices = [
    {
      id: DEFAULT_SERVER_BROWSER_GPU,
      label: "Software",
      description: `Render on the CPU. The default. ${APPLIES}`,
    },
    { id: "auto", label: "Automatic", description: "Let the browser pick a GPU." },
    ...gpus.map((gpu) => ({
      id: gpu.id,
      label: gpu.name,
      description: gpu.driver ? `${gpu.driver} · ${gpu.id}` : gpu.id,
    })),
  ];
  if (props.gpu !== null && !gpuChoices.some((choice) => choice.id === props.gpu)) {
    gpuChoices.push({ id: props.gpu, label: props.gpu, description: "Not found on this host." });
  }

  return (
    <>
      <SettingsSection title="Browser GPU">
        {gpuChoices.map((choice, index) => (
          <ListChoiceRow
            key={choice.id}
            label={choice.label}
            description={choice.description}
            selected={props.gpu === choice.id}
            separated={index > 0}
            disabled={props.disabled}
            onPress={() => props.write({ serverBrowserGpu: choice.id })}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Browser render scale">
        {RENDER_SCALES.map((scale, index) => (
          <ListChoiceRow
            key={scale}
            label={`${scale}×`}
            {...(scale === DEFAULT_SERVER_BROWSER_RENDER_SCALE
              ? { description: `The default. ${APPLIES}` }
              : {})}
            selected={props.scale === scale}
            separated={index > 0}
            disabled={props.disabled}
            onPress={() => props.write({ serverBrowserRenderScale: scale })}
          />
        ))}
      </SettingsSection>
    </>
  );
}
