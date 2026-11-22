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
import { useGT } from "gt-react-native";

import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { previewEnvironment } from "../../../state/preview";
import { SettingsSection } from "./SettingsSection";

const NO_GPUS_ATOM = Atom.make(AsyncResult.success<ServerBrowserGpuList>({ gpus: [] }));
const RENDER_SCALES: ReadonlyArray<ServerBrowserRenderScale> = [1, 1.5, 2, 3];

/** Null values mean the selected environments differ. */
export function BrowserRenderingSections(props: {
  readonly environmentId: EnvironmentId | null;
  readonly gpu: string | null;
  readonly scale: ServerBrowserRenderScale | null;
  readonly disabled: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
}) {
  const gt = useGT();
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
      label: gt("Software", { $context: "browser GPU software rendering" }),
      description: gt(
        "Render on the CPU. The default. Changing this reloads the environment's open browser tabs.",
      ),
    },
    { id: "auto", label: gt("Automatic"), description: gt("Let the browser pick a GPU.") },
    ...gpus.map((gpu) => ({
      id: gpu.id,
      label: gpu.name,
      description: gpu.driver ? `${gpu.driver} · ${gpu.id}` : gpu.id,
    })),
  ];
  if (props.gpu !== null && !gpuChoices.some((choice) => choice.id === props.gpu)) {
    gpuChoices.push({
      id: props.gpu,
      label: props.gpu,
      description: gt("Not found on this host."),
    });
  }

  return (
    <>
      <SettingsSection title={gt("Browser GPU")}>
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
      <SettingsSection title={gt("Browser render scale")}>
        {RENDER_SCALES.map((scale, index) => (
          <ListChoiceRow
            key={scale}
            label={`${scale}×`}
            {...(scale === DEFAULT_SERVER_BROWSER_RENDER_SCALE
              ? {
                  description: gt(
                    "The default. Changing this reloads the environment's open browser tabs.",
                  ),
                }
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
