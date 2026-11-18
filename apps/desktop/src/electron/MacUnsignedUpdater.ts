// @effect-diagnostics nodeBuiltinImport:off -- Read once while the updater is chosen, before any Effect service exists.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Electron from "electron";
import { MacUpdater } from "electron-updater";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";

import { swapBundleOnExit } from "./MacBundleSwap.ts";

/** Whether scripts/build-desktop-artifact.ts packaged this app for macOS without a signature. */
export function isUnsignedMacBuild(): boolean {
  if (!Electron.app.isPackaged) return false;
  try {
    const manifest: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(Electron.app.getAppPath(), "package.json"), "utf8"),
    );
    return (
      typeof manifest === "object" &&
      manifest !== null &&
      "t3codeMacUnsignedUpdates" in manifest &&
      manifest.t3codeMacUnsignedUpdates === true
    );
  } catch {
    return false;
  }
}

/**
 * Squirrel.Mac installs an update only when its signature matches the running app's, so an
 * unsigned build keeps electron-updater's download and replaces its own bundle.
 */
export class MacUnsignedUpdater extends MacUpdater {
  #downloadedZip: string | undefined;

  protected override executeDownload(task: DownloadExecutorTask): Promise<Array<string>> {
    return super.executeDownload({
      ...task,
      // MacUpdater's own handler gives the zip to Squirrel.Mac, which errors without a signature.
      done: async (event) => {
        this.#downloadedZip = event.downloadedFile;
        const cacheDir = this.downloadedUpdateHelper?.cacheDir;
        // MacUpdater diffs the next download against this copy; its own handler made it.
        if (cacheDir !== undefined && !task.downloadUpdateOptions.disableDifferentialDownload) {
          await NodeFSP.copyFile(event.downloadedFile, NodePath.join(cacheDir, "update.zip")).catch(
            (error: unknown) => this._logger.warn(`Unable to cache update.zip: ${String(error)}`),
          );
        }
        this.dispatchUpdateDownloaded(event);
      },
    });
  }

  override quitAndInstall(): void {
    const zipPath = this.#downloadedZip;
    if (zipPath === undefined) {
      this.emit("error", new Error("No downloaded update to install."));
      return;
    }
    swapBundleOnExit({ zipPath, execPath: process.execPath, pid: process.pid }).then(
      () => this.app.quit(),
      (cause: unknown) =>
        this.emit("error", cause instanceof Error ? cause : new Error(String(cause))),
    );
  }
}
