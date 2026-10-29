// @effect-diagnostics nodeBuiltinImport:off - Reads sysfs and devfs for Chromium launch flags outside the Effect runtime.
import {
  DEFAULT_SERVER_BROWSER_GPU,
  type ServerBrowserGpu,
  type ServerBrowserGpuDevice,
} from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// A GPU is named by its PCI path, which survives render nodes renumbering across boots.
const RENDER_NODE_SUFFIX = "-render";
const PCI_PATH = /^pci-[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/;
const PCI_ID_FILES = ["usr/share/hwdata/pci.ids", "usr/share/misc/pci.ids"];
const VENDORS: Record<string, string> = { "10de": "NVIDIA", "1002": "AMD", "8086": "Intel" };

const readTrimmed = (path: string) =>
  NodeFSP.readFile(path, "utf8").then(
    (text) => text.trim(),
    () => null,
  );

const pciNames = async (root: string, vendor: string, device: string) => {
  for (const file of PCI_ID_FILES) {
    const text = await NodeFSP.readFile(NodePath.join(root, file), "utf8").catch(() => null);
    if (text === null) continue;
    let vendorName: string | null = null;
    for (const line of text.split("\n")) {
      if (vendorName === null) {
        if (line.startsWith(`${vendor}  `)) vendorName = line.slice(6);
      } else if (line.startsWith(`\t${device}  `)) {
        return { vendor: vendorName, device: line.slice(7) };
      } else if (line !== "" && !line.startsWith("\t") && !line.startsWith("#")) break;
    }
    return vendorName === null ? null : { vendor: vendorName, device: null };
  }
  return null;
};

/** Lists Linux GPUs Chromium can render on. Other platforms only choose software or automatic. */
export const discoverGpus = async (
  platform: NodeJS.Platform,
  root = "/",
): Promise<ReadonlyArray<ServerBrowserGpuDevice>> => {
  if (platform !== "linux") return [];
  const byPath = NodePath.join(root, "dev/dri/by-path");
  const entries = await NodeFSP.readdir(byPath).catch(() => []);
  const gpus: Array<ServerBrowserGpuDevice> = [];
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith(RENDER_NODE_SUFFIX)) continue;
    const id = entry.slice(0, -RENDER_NODE_SUFFIX.length);
    if (!PCI_PATH.test(id)) continue;
    const node = NodePath.basename(
      await NodeFSP.readlink(NodePath.join(byPath, entry)).catch(() => ""),
    );
    const device = NodePath.join(root, "sys/class/drm", node, "device");
    const vendorId = (await readTrimmed(NodePath.join(device, "vendor")))?.replace(/^0x/, "");
    const deviceId = (await readTrimmed(NodePath.join(device, "device")))?.replace(/^0x/, "");
    const driverLink = await NodeFSP.readlink(NodePath.join(device, "driver")).catch(() => null);
    const names = vendorId && deviceId ? await pciNames(root, vendorId, deviceId) : null;
    const vendor = names?.vendor ?? (vendorId ? VENDORS[vendorId] : undefined) ?? "GPU";
    gpus.push({
      id,
      name: names?.device ? `${vendor} ${names.device}` : `${vendor} ${deviceId ?? id}`,
      driver: driverLink ? NodePath.basename(driverLink) : null,
    });
  }
  return gpus;
};

/**
 * Chromium flags for a GPU setting. Software keeps the CPU rasterizer; a GPU that is no longer
 * present falls back to it rather than to whichever GPU Chromium would pick.
 */
export const gpuLaunchArgs = async (
  gpu: ServerBrowserGpu,
  platform: NodeJS.Platform,
  root = "/",
): Promise<ReadonlyArray<string>> => {
  const software = ["--disable-gpu"];
  if (gpu === DEFAULT_SERVER_BROWSER_GPU) return software;
  // Headless Chromium otherwise keeps SwiftShader on Linux even with the GPU enabled.
  const enabled = [
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    ...(platform === "linux" ? ["--use-gl=angle", "--use-angle=gl-egl"] : []),
  ];
  if (gpu === "auto") return enabled;
  if (platform !== "linux" || !PCI_PATH.test(gpu)) return software;
  const node = NodePath.join(root, "dev/dri/by-path", `${gpu}${RENDER_NODE_SUFFIX}`);
  const present = await NodeFSP.access(node).then(
    () => true,
    () => false,
  );
  return present ? [...enabled, `--render-node-override=${node}`] : software;
};
