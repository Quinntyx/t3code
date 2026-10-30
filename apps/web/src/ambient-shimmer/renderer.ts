import { observeResize } from "~/lib/observeResize";

import { shimmerPalette, shimmerPhases, WARP_TERMS, type ShimmerPalette } from "./field";

/** Canvas pixels per CSS pixel. The bands are soft, so the browser's upscale hides the rest. */
const RENDER_SCALE = 0.5;
const FRAME_INTERVAL_MS = 1000 / 30;
const MAX_STEP_SECONDS = 0.1;

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

// After the Hyperframes studio ground: a sine-warped field whose three offset samples split
// into fringes, tinted from the theme instead of raw RGB.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uPhases[${WARP_TERMS * 2 + 1}];
uniform vec3 uBase;
uniform vec3 uBands[3];
uniform vec3 uShade;
uniform float uTint;
uniform float uShadeAmount;

vec2 warp(vec2 p) {
  for (int i = 0; i < ${WARP_TERMS}; i++) {
    float k = float(i + 1);
    p.x += 0.3 / k * sin(k * 5.0 * p.y + uPhases[i]);
    p.y += 0.1 / k * cos(k * 3.0 * p.x + uPhases[${WARP_TERMS} + i]);
  }
  return p;
}

float band(vec2 p, float offset) {
  return pow(sin(warp(p + offset).x * 7.0 + uPhases[${WARP_TERMS * 2}]) * 0.5 + 0.5, 10.0);
}

void main() {
  vec2 p = gl_FragCoord.xy / max(uResolution.x, uResolution.y);
  vec3 w = vec3(band(p, 0.0), band(p, 0.02), band(p, 0.04));
  float body = sin(warp(p + 0.5).x * 3.5 + uPhases[${WARP_TERMS * 2}]) * 0.5 + 0.5;
  vec3 color = mix(uBase, uShade, uShadeAmount * body * (1.0 - max(w.x, max(w.y, w.z))));
  color = mix(color, uBands[0], uTint * w.x);
  color = mix(color, uBands[1], uTint * w.y);
  color = mix(color, uBands[2], uTint * w.z);
  // Dither below one 8-bit step so the long, faint gradients do not band.
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  fragColor = vec4(color + (noise - 0.5) / 255.0, 1.0);
}
`;

export interface AmbientShimmer {
  stop(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log ?? "Shader compile failed");
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(log ?? "Program link failed");
  }
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.useProgram(program);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  return {
    dispose: () => {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
    resolution: uniform("uResolution"),
    phases: uniform("uPhases"),
    base: uniform("uBase"),
    bands: uniform("uBands"),
    shade: uniform("uShade"),
    tint: uniform("uTint"),
    shadeAmount: uniform("uShadeAmount"),
  };
}

/** Resolves theme tokens through `probe`'s `color`; they may be `var()` chains or `color-mix()`. */
function readPalette(probe: HTMLElement): ShimmerPalette | null {
  const read = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  return shimmerPalette({
    primary: read("--primary"),
    background: read("--background"),
    foreground: read("--foreground"),
  });
}

/**
 * Fills `container` with a never-repeating iridescent field until stopped. Animates at 30fps,
 * pauses while the page is hidden, and draws a still frame for reduced motion.
 */
export function startAmbientShimmer(container: HTMLElement): AmbientShimmer {
  // Owned here rather than by React: a context lost on stop cannot be revived on the same node.
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%";
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: "low-power",
  });
  if (!gl) return { stop: () => {} };

  let program: ReturnType<typeof createProgram> | null = null;
  try {
    program = createProgram(gl);
  } catch (error) {
    console.warn("Ambient shimmer unavailable", error);
    return { stop: () => {} };
  }

  container.append(canvas);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const phases = new Float32Array(WARP_TERMS * 2 + 1);
  const seed = Math.random() * 1000;
  let palette: ShimmerPalette | null = null;
  let paletteStale = true;
  let seconds = 0;
  let lastTick = 0;
  let lastDraw = -Infinity;
  let frame = 0;
  let stopped = false;

  const draw = () => {
    if (!program || gl.isContextLost()) return;
    if (paletteStale) {
      palette = readPalette(canvas);
      paletteStale = false;
      if (palette) {
        gl.uniform3fv(program.base, palette.base);
        gl.uniform3fv(program.bands, palette.bands.flat());
        gl.uniform3fv(program.shade, palette.shade);
        gl.uniform1f(program.tint, palette.dark ? 0.26 : 0.3);
        gl.uniform1f(program.shadeAmount, palette.dark ? 0.035 : 0.05);
      }
    }
    if (!palette) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(program.resolution, canvas.width, canvas.height);
    gl.uniform1fv(program.phases, shimmerPhases(seconds, seed, phases));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const animating = () => !stopped && !document.hidden && !reducedMotion.matches;

  const tick = (now: number) => {
    frame = 0;
    if (!animating()) return;
    seconds += Math.min(MAX_STEP_SECONDS, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    if (now - lastDraw >= FRAME_INTERVAL_MS - 1) {
      lastDraw = now;
      draw();
    }
    frame = requestAnimationFrame(tick);
  };

  const resume = () => {
    if (frame || !animating()) return;
    lastTick = performance.now();
    frame = requestAnimationFrame(tick);
  };

  const redraw = () => {
    if (stopped) return;
    if (animating()) resume();
    else draw();
  };

  const resize = () => {
    const width = Math.max(1, Math.round(canvas.clientWidth * RENDER_SCALE));
    const height = Math.max(1, Math.round(canvas.clientHeight * RENDER_SCALE));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    // A resize clears the canvas; repaint now rather than on the next 30fps slot.
    draw();
  };

  const themeObserver = new MutationObserver(() => {
    paletteStale = true;
    // Repaint now: a throttled or paused frame loop would otherwise show the old theme.
    draw();
    redraw();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme-id"],
  });
  const unobserveResize = observeResize(canvas, resize);
  const onContextLost = (event: Event) => {
    event.preventDefault();
    program = null;
  };
  const onContextRestored = () => {
    try {
      program = createProgram(gl);
      paletteStale = true;
      redraw();
    } catch (error) {
      console.warn("Ambient shimmer unavailable", error);
    }
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  document.addEventListener("visibilitychange", redraw);
  reducedMotion.addEventListener("change", redraw);

  resize();
  draw();
  resume();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      themeObserver.disconnect();
      unobserveResize();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      document.removeEventListener("visibilitychange", redraw);
      reducedMotion.removeEventListener("change", redraw);
      program?.dispose();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
