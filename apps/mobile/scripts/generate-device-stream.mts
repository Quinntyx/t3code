import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";

const mobileRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

async function buildWebViewScript(feature: string, name: string) {
  const stem = `${name.toLowerCase()}-stream`;
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      target: "es2022",
      minify: true,
      lib: {
        entry: NodePath.join(mobileRoot, "src/features", feature, `${stem}.browser.ts`),
        name: `T3${name}Stream`,
        formats: ["iife"],
      },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const chunk = bundles
    .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
    .find((output) => output.type === "chunk");
  if (!chunk) throw new Error(`${name} build did not emit a script.`);
  return { stem, code: chunk.code };
}

async function generateWebViewScript(feature: string, name: string) {
  const { stem, code } = await buildWebViewScript(feature, name);
  const root = NodePath.join(mobileRoot, ".generated", stem);
  await NodeFSP.mkdir(root, { recursive: true });
  for (const [file, contents] of [
    ["index.js", `module.exports = ${JSON.stringify(code)};\n`],
    ["package.json", '{"main":"index.js"}\n'],
  ] as const) {
    const destination = NodePath.join(root, file);
    const previous = await NodeFSP.readFile(destination, "utf8").catch(() => null);
    if (previous !== contents) await NodeFSP.writeFile(destination, contents);
  }
}

/** The same IIFE the generated module ships, for a test that executes it. */
export const buildPreviewStreamScript = async () =>
  (await buildWebViewScript("browser", "Preview")).code;

export const generateDeviceStreamScript = () => generateWebViewScript("devices", "Device");
export const generatePreviewStreamScript = () => generateWebViewScript("browser", "Preview");
