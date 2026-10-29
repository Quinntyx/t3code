import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_BROWSER_GPU,
  DEFAULT_SERVER_BROWSER_RENDER_SCALE,
  type ServerBrowserGpuList,
  type ServerBrowserRenderScale,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { previewEnvironment } from "../../state/preview";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const NO_GPUS_ATOM = Atom.make(AsyncResult.success<ServerBrowserGpuList>({ gpus: [] }));
const RENDER_SCALES: ReadonlyArray<ServerBrowserRenderScale> = [1, 1.5, 2, 3];
const APPLIES = "Changing it reloads the open browser tabs on this environment.";

const scaleLabel = (scale: ServerBrowserRenderScale) =>
  `${scale}×${scale === DEFAULT_SERVER_BROWSER_RENDER_SCALE ? " (default)" : ""}`;

function BrowserGpuSetting() {
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
    { value: DEFAULT_SERVER_BROWSER_GPU, label: "Software (default)" },
    { value: "auto", label: "Automatic" },
    ...gpus.map((gpu) => ({
      value: gpu.id,
      label: gpu.driver ? `${gpu.name} (${gpu.driver})` : gpu.name,
    })),
  ];
  // A saved GPU stays selectable while its host is offline or the GPU is gone.
  if (!options.some((option) => option.value === current)) {
    options.push({ value: current, label: `${current} (not found)` });
  }
  const labelFor = (value: string | null) =>
    options.find((option) => option.value === value)?.label ?? "Mixed";

  return (
    <SettingsRow
      serverScoped
      settingKeys={["serverBrowserGpu"]}
      {...searchableSetting("browser-render-gpu")}
      description={`What renders this environment's browser tabs. Software keeps Chromium on the CPU; a GPU makes scrolling and animation smoother. ${APPLIES}`}
      resetAction={
        current !== DEFAULT_SERVER_BROWSER_GPU ? (
          <SettingResetButton
            label="browser GPU"
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
          <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="Browser GPU">
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
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const current = settings.serverBrowserRenderScale;
  const mixed = useScopedSettingsMixed(["serverBrowserRenderScale"]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["serverBrowserRenderScale"]}
      {...searchableSetting("browser-render-scale")}
      description={`Pixels the browser draws per CSS pixel. Higher is sharper on high-density screens and in screenshots; lower is faster without a GPU. ${APPLIES}`}
      resetAction={
        current !== DEFAULT_SERVER_BROWSER_RENDER_SCALE ? (
          <SettingResetButton
            label="render scale"
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
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Render scale">
            <SelectValue>
              {(value: ServerBrowserRenderScale | null) =>
                value === null ? "Mixed" : scaleLabel(value)
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
