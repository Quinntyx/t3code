import { describe, expect, it } from "vite-plus/test";

import { hasGlbSignature, modelExtension } from "./modelFormat";

describe("modelExtension", () => {
  it("reads the format from the asset URL before markdown alt text", () => {
    expect(modelExtension("original.obj", "https://example.test/result.glb")).toBe("glb");
  });

  it("decodes encoded path extensions", () => {
    expect(modelExtension("model", "https://example.test/result%2Eglb?token=1")).toBe("glb");
  });

  it("falls back to the markdown name when the URL has no extension", () => {
    expect(modelExtension("part.STL", "https://example.test/download?token=1")).toBe("stl");
  });
});

describe("hasGlbSignature", () => {
  it("recognizes the GLB magic header", () => {
    const bytes = new TextEncoder().encode("glTF\u0002\u0000\u0000\u0000").buffer;
    expect(hasGlbSignature(bytes)).toBe(true);
  });

  it("rejects other model bytes", () => {
    const bytes = new TextEncoder().encode("solid part").buffer;
    expect(hasGlbSignature(bytes)).toBe(false);
  });
});
