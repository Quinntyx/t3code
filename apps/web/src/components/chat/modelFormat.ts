const MODEL_EXTENSIONS = new Set(["glb", "obj", "stl"]);

function decodedPath(candidate: string): string {
  const path = candidate.split(/[?#]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Reads the format from the asset URL first; markdown alt text is only a fallback. */
export function modelExtension(name: string, src: string): string {
  for (const candidate of [src, name]) {
    const extension = decodedPath(candidate).split(".").at(-1)?.toLowerCase();
    if (extension !== undefined && MODEL_EXTENSIONS.has(extension)) return extension;
  }
  return "";
}

export function hasGlbSignature(source: ArrayBuffer): boolean {
  if (source.byteLength < 4) return false;
  const bytes = new Uint8Array(source, 0, 4);
  return bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}
