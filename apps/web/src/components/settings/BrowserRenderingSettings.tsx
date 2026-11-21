import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_BROWSER_GPU,
  DEFAULT_SERVER_BROWSER_RENDER_SCALE,
  type ServerBrowserGpuList,
  type ServerBrowserRenderScale,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT } from "gt-react";

import { previewEnvironment } from "../../state/preview";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const NO_GPUS_ATOM = Atom.make(AsyncResult.success<ServerBrowserGpuList>({ gpus: [] }));
const RENDER_SCALES: ReadonlyArray<ServerBrowserRenderScale> = [1, 1.5, 2, 3];

function BrowserGpuSetting() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { scope, environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  // GPUs belong to one host, so they are listed only when one environment is selected.
  const environmentId = scope.environmentIds.length === 1 ? environment?.environmentId : undefined;
  const discovered = useAtomValue(
    environmentId ? previewEnvironment.gpus({ environmentId, input: {} }) : NO_GPUS_ATOM,
  );
  const gpus = AsyncResult.isSuccess(discovered) ? discovered.value.gpus : [];
  const current = settings.serverBrowserGpu;
  const mixed = useScopedSettingsMixed(["serverBrowserGpu"]);
  const options = [
    { value: DEFAULT_SERVER_BROWSER_GPU, label: gt("Software (default)") },
    { value: "auto", label: gt("Automatic") },
    ...gpus.map((gpu) => ({
      value: gpu.id,
      label: gpu.driver ? `${gpu.name} (${gpu.driver})` : gpu.name,
    })),
  ];
  // A saved GPU stays selectable while its host is offline or the GPU is gone.
  if (!options.some((option) => option.value === current)) {
    options.push({
      value: current,
      label: gt("{gpu} (not found)", { gpu: current }),
    });
  }
  const labelFor = (value: string | null) =>
    options.find((option) => option.value === value)?.label ?? gt("Mixed");

  return (
    <SettingsRow
      serverScoped
      settingKeys={["serverBrowserGpu"]}
      {...searchableSetting("browser-render-gpu")}
      description={gt(
        "What renders this environment's browser tabs. Software keeps Chromium on the CPU; a GPU makes scrolling and animation smoother. Changing it reloads the open browser tabs on this environment.",
      )}
      resetAction={
        current !== DEFAULT_SERVER_BROWSER_GPU ? (
          <SettingResetButton
            ariaLabel={gt("Reset browser GPU to default")}
            onClick={() => updateSettings({ serverBrowserGpu: DEFAULT_SERVER_BROWSER_GPU })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : current}
          onValueChange={(value) => {
            if (typeof value === "string") updateSettings({ serverBrowserGpu: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-64" aria-label={gt("Browser GPU")}>
            <SelectValue>{(value: string | null) => labelFor(value)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {options.map((option) => (
              <SelectItem hideIndicator key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserRenderScaleSetting() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const current = settings.serverBrowserRenderScale;
  const mixed = useScopedSettingsMixed(["serverBrowserRenderScale"]);
  const scaleLabel = (scale: ServerBrowserRenderScale) =>
    scale === DEFAULT_SERVER_BROWSER_RENDER_SCALE
      ? gt("{scale}× (default)", { scale })
      : gt("{scale}×", { scale });

  return (
    <SettingsRow
      serverScoped
      settingKeys={["serverBrowserRenderScale"]}
      {...searchableSetting("browser-render-scale")}
      description={gt(
        "Pixels the browser draws per CSS pixel. Higher is sharper on high-density screens and in screenshots; lower is faster without a GPU. Changing it reloads the open browser tabs on this environment.",
      )}
      resetAction={
        current !== DEFAULT_SERVER_BROWSER_RENDER_SCALE ? (
          <SettingResetButton
            ariaLabel={gt("Reset render scale to default")}
            onClick={() =>
              updateSettings({ serverBrowserRenderScale: DEFAULT_SERVER_BROWSER_RENDER_SCALE })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : current}
          onValueChange={(value) => {
            const scale = RENDER_SCALES.find((candidate) => candidate === value);
            if (scale !== undefined) updateSettings({ serverBrowserRenderScale: scale });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={gt("Render scale")}>
            <SelectValue>
              {(value: ServerBrowserRenderScale | null) =>
                value === null ? gt("Mixed") : scaleLabel(value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {RENDER_SCALES.map((scale) => (
              <SelectItem hideIndicator key={scale} value={scale}>
                {scaleLabel(scale)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function BrowserRenderingSettings() {
  return (
    <>
      <BrowserGpuSetting />
      <BrowserRenderScaleSetting />
    </>
  );
}
