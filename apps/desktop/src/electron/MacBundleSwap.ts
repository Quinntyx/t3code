// @effect-diagnostics nodeBuiltinImport:off -- The swap helper must outlive this process, which Effect's scoped child processes cannot.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// Runs once this process has exited, since a running bundle cannot be replaced safely. The old
// bundle moves back if the new one cannot take its place, and is deleted only once one is in place.
export const SWAP_SCRIPT = `
pid=$1 current=$2 next=$3 stage=$4
tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then rm -rf "$stage"; exit 1; fi
  sleep 0.2
done
if mv "$current" "$stage/previous.app"; then
  mv "$next" "$current" || mv "$stage/previous.app" "$current"
fi
[ -d "$current" ] && rm -rf "$stage"
open "$current"
`;

function bundlePathOf(execPath: string): string {
  const bundlePath = NodePath.resolve(execPath, "../../..");
  if (!bundlePath.endsWith(".app")) {
    throw new Error(`T3 Code is not running from an app bundle: ${execPath}`);
  }
  return bundlePath;
}

/** Unpacks a downloaded update next to the running bundle and leaves a helper to swap them on exit. */
export async function swapBundleOnExit(input: {
  readonly zipPath: string;
  readonly execPath: string;
  readonly pid: number;
}): Promise<void> {
  const bundlePath = bundlePathOf(input.execPath);
  // A sibling keeps the swap a rename on one volume, and creating it fails here when the app's
  // folder is read-only, as it is while the app still runs from its disk image.
  const stage = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(bundlePath), ".t3code-update-"),
  );
  try {
    await execFile("/usr/bin/ditto", ["-x", "-k", input.zipPath, stage]);
    const next = (await NodeFSP.readdir(stage)).find((entry) => entry.endsWith(".app"));
    if (next === undefined) {
      throw new Error(`The update holds no app bundle: ${input.zipPath}`);
    }
    NodeChildProcess.spawn(
      "/bin/sh",
      ["-c", SWAP_SCRIPT, "sh", String(input.pid), bundlePath, NodePath.join(stage, next), stage],
      { detached: true, stdio: "ignore" },
    ).unref();
  } catch (error) {
    await NodeFSP.rm(stage, { recursive: true, force: true });
    throw error;
  }
}
