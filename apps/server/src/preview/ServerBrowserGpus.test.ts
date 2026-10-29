// @effect-diagnostics nodeBuiltinImport:off - Builds a fake devfs and sysfs tree on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { discoverGpus, gpuLaunchArgs } from "./ServerBrowserGpus.ts";

let root = "";

beforeAll(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-gpus-"));
  const write = async (path: string, text: string) => {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  };
  const gpu = async (pci: string, node: string, vendor: string, device: string, driver: string) => {
    await write(`dev/dri/${node}`, "");
    await NodeFSP.mkdir(NodePath.join(root, "dev/dri/by-path"), { recursive: true });
    await NodeFSP.symlink(`../${node}`, NodePath.join(root, `dev/dri/by-path/${pci}-render`));
    await NodeFSP.symlink(`../${node}`, NodePath.join(root, `dev/dri/by-path/${pci}-card`));
    await write(`sys/class/drm/${node}/device/vendor`, `0x${vendor}\n`);
    await write(`sys/class/drm/${node}/device/device`, `0x${device}\n`);
    await NodeFSP.mkdir(NodePath.join(root, "sys/bus/pci/drivers", driver), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(root, "sys/bus/pci/drivers", driver),
      NodePath.join(root, `sys/class/drm/${node}/device/driver`),
    );
  };
  await gpu("pci-0000:2b:00.0", "renderD128", "10de", "2504", "nvidia");
  await gpu("pci-0000:00:02.0", "renderD129", "8086", "a780", "i915");
  await write(
    "usr/share/hwdata/pci.ids",
    [
      "# comment",
      "10de  NVIDIA Corporation",
      "\t2503  GA106 [GeForce RTX 3060]",
      "\t2504  GA106 [GeForce RTX 3060 Lite Hash Rate]",
      "\t\t1462 397b  Subsystem",
      "10df  Emulex Corporation",
      "\t2504  Not this device",
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});

describe("server browser GPUs", () => {
  it("lists Linux render nodes by PCI path with names from pci.ids", async () => {
    expect(await discoverGpus("linux", root)).toEqual([
      { id: "pci-0000:00:02.0", name: "Intel a780", driver: "i915" },
      {
        id: "pci-0000:2b:00.0",
        name: "NVIDIA Corporation GA106 [GeForce RTX 3060 Lite Hash Rate]",
        driver: "nvidia",
      },
    ]);
    expect(await discoverGpus("darwin", root)).toEqual([]);
  });

  it("keeps software rendering unless a GPU that exists is chosen", async () => {
    const enabled = [
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=gl-egl",
    ];
    expect(await gpuLaunchArgs("software", "linux", root)).toEqual(["--disable-gpu"]);
    expect(await gpuLaunchArgs("auto", "linux", root)).toEqual(enabled);
    expect(await gpuLaunchArgs("auto", "win32", root)).toEqual([
      "--enable-gpu",
      "--ignore-gpu-blocklist",
    ]);
    expect(await gpuLaunchArgs("pci-0000:2b:00.0", "linux", root)).toEqual([
      ...enabled,
      `--render-node-override=${NodePath.join(root, "dev/dri/by-path/pci-0000:2b:00.0-render")}`,
    ]);
    // A removed GPU or a malformed id must not reach Chromium's command line.
    expect(await gpuLaunchArgs("pci-0000:99:00.0", "linux", root)).toEqual(["--disable-gpu"]);
    expect(await gpuLaunchArgs("pci-0000:2b:00.0 --no-sandbox", "linux", root)).toEqual([
      "--disable-gpu",
    ]);
  });
});
