import { quietSpectrum, type SpectrumFrame } from "./spectrum";

const colorAlpha = (color: string) => {
  const match = /rgba?\(([^)]+)\)/.exec(color);
  if (!match) return color === "transparent" ? 0 : 1;
  const parts = match[1]!.split(/[\s,/]+/).filter(Boolean);
  return parts.length > 3 ? Number(parts[3]) : 1;
};
import {
  studioFragment,
  studioVertical,
  studioHorizontal,
} from "./vendor/liquid-glass-studio/shaders";
import preset from "./vendor/liquid-glass-studio/voice-preset.json";

export function createSpectralRenderer(
  canvas: HTMLCanvasElement,
  getSpectrum: () => SpectrumFrame,
) {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl) return null;
  const shaders: WebGLShader[] = [],
    programs: WebGLProgram[] = [],
    buffers: WebGLBuffer[] = [],
    textures: WebGLTexture[] = [],
    framebuffers: WebGLFramebuffer[] = [];
  const ownShader = (kind: number) => {
    const resource = gl.createShader(kind)!;
    shaders.push(resource);
    return resource;
  };
  const ownProgram = () => {
    const resource = gl.createProgram()!;
    programs.push(resource);
    return resource;
  };
  const ownBuffer = () => {
    const resource = gl.createBuffer()!;
    buffers.push(resource);
    return resource;
  };
  const ownTexture = () => {
    const resource = gl.createTexture()!;
    textures.push(resource);
    return resource;
  };
  const ownFramebuffer = () => {
    const resource = gl.createFramebuffer()!;
    framebuffers.push(resource);
    return resource;
  };
  const dispose = () => {
    for (const resource of shaders) gl.deleteShader(resource);
    for (const resource of programs) gl.deleteProgram(resource);
    for (const resource of buffers) gl.deleteBuffer(resource);
    for (const resource of textures) gl.deleteTexture(resource);
    for (const resource of framebuffers) gl.deleteFramebuffer(resource);
    shaders.length = programs.length = buffers.length = textures.length = framebuffers.length = 0;
  };
  let background = new Float32Array([0.96, 0.96, 0.95]);
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext("2d", { willReadFrequently: true });
  const updateBackground = () => {
    if (!colorContext) return;
    // The canvas is opaque, so match the nearest painted surface rather than a transparent wrapper.
    let surface = canvas.parentElement;
    while (surface && colorAlpha(getComputedStyle(surface).backgroundColor) === 0)
      surface = surface.parentElement;
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = surface
      ? getComputedStyle(surface).backgroundColor
      : getComputedStyle(document.body).backgroundColor;
    colorContext.fillRect(0, 0, 1, 1);
    background = new Float32Array(
      [...colorContext.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => value / 255),
    );
  };
  try {
    const vertex = `#version 300 es
in vec2 position;out vec2 uv;out vec2 v_uv;void main(){uv=position*.5+.5;v_uv=uv;gl_Position=vec4(position,0.,1.);}`;
    const fragment = `#version 300 es
precision highp float;out vec4 fragColor;
      in vec2 uv;uniform sampler2D profiles;uniform vec2 size;
      uniform vec3 baseColor;uniform float darkMode;uniform float offsets[10];uniform float softness[10];uniform float opacity[10];uniform vec3 palettes[10];uniform vec3 whiteStops[10];uniform vec4 shadowRects[16];uniform int rectCount;
      float heightAt(float x,float row){vec4 s=texture(profiles,vec2(clamp(x,0.,1.),row));return (s.r*65280.+s.g*255.)/65535.;}
      vec3 hue(float h){vec3 p=abs(fract(vec3(h)+vec3(0.,.666667,.333333))*6.-3.);return (mix(vec3(.478),clamp(p-1.,0.,1.),.636)*.73+.18)*.97;}
      vec3 scene(vec2 point){
        vec3 col=baseColor;
        for(int i=0;i<10;i++){
          float row=(float(i)+.5)/10.;float x=(point.x+.2-offsets[i])/1.4;
          float dx=softness[i]/size.x/1.4;
          float peak=heightAt(x,row)*.28;
          peak+=(heightAt(x-dx,row)+heightAt(x+dx,row))*.22;
          peak+=(heightAt(x-dx*2.,row)+heightAt(x+dx*2.,row))*.11;
          peak+=(heightAt(x-dx*3.,row)+heightAt(x+dx*3.,row))*.03;
          float radius=softness[i]/size.y;
          float field=1.-smoothstep(peak-radius*1.7,peak+radius*1.7,point.y);
          vec3 color=hue(mix(palettes[i].x,palettes[i].y,point.x)/360.);
                vec3 distanceToStop=abs(vec3(point.x)-whiteStops[i]);
          vec3 patches=1.-smoothstep(vec3(.025),vec3(.12),distanceToStop);
          float white=max(patches.x,max(patches.y,patches.z))*palettes[i].z;
          color=mix(color,mix(vec3(1.,.998,.985),baseColor+.15,darkMode),white);
          col=mix(col,color,field*opacity[i]*(1.+white*.14));
        }
        float edge=1.-smoothstep(0.,.018,point.y);
        col=mix(col,hue((190.+95.*point.x)/360.),edge*.12);
        return col;
      }
      float shadowSDF(vec2 p,vec4 r){vec2 q=abs(p-r.xy)-r.zw*.5+r.w*.5;return length(max(q,0.))+min(max(q.x,q.y),0.)-r.w*.5;}
      void main(){vec3 color=scene(uv);float distance=1e6;for(int i=0;i<16;i++){if(i>=rectCount)break;distance=min(distance,abs(shadowSDF(uv*size,shadowRects[i])));}color-=exp(-distance/25.)*.6*.15;fragColor=vec4(color,1.);}`;
    const glassFragment = studioFragment
      .replace("uniform vec4 u_rects[3];", "uniform vec4 u_rects[16];uniform int u_rectCount;")
      .replaceAll("for(int i=0;i<3;i++) {", "for(int i=0;i<16;i++) { if(i>=u_rectCount)break;");
    const shader = (kind: number, source: string) => {
      const s = ownShader(kind);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) || "Spectrum shader failed");
      return s;
    };
    const program = ownProgram();
    const vs = shader(gl.VERTEX_SHADER, vertex),
      fs = shader(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "position");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || "Spectrum link failed");
    gl.useProgram(program);
    const buffer = ownBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const texture = ownTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const locations = {
      size: gl.getUniformLocation(program, "size"),
      offsets: gl.getUniformLocation(program, "offsets[0]"),
      softness: gl.getUniformLocation(program, "softness[0]"),
      opacity: gl.getUniformLocation(program, "opacity[0]"),
      palettes: gl.getUniformLocation(program, "palettes[0]"),
      whiteStops: gl.getUniformLocation(program, "whiteStops[0]"),
      shadowRects: gl.getUniformLocation(program, "shadowRects[0]"),
    };
    const glassProgram = ownProgram(),
      glassShader = shader(gl.FRAGMENT_SHADER, glassFragment);
    gl.attachShader(glassProgram, vs);
    gl.attachShader(glassProgram, glassShader);
    gl.bindAttribLocation(glassProgram, 0, "position");
    gl.linkProgram(glassProgram);
    if (!gl.getProgramParameter(glassProgram, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(glassProgram) || "Glass link failed");
    const glassSize = gl.getUniformLocation(glassProgram, "u_resolution");
    gl.useProgram(glassProgram);
    const uniform = (name: string, value: number) =>
      gl.uniform1f(gl.getUniformLocation(glassProgram, name), value);
    gl.uniform1i(gl.getUniformLocation(glassProgram, "u_bg"), 0);
    gl.uniform1i(gl.getUniformLocation(glassProgram, "u_blurredBg"), 1);
    gl.uniform1i(gl.getUniformLocation(glassProgram, "STEP"), 9);
    const c = preset.controls;
    gl.uniform1i(gl.getUniformLocation(glassProgram, "u_blurEdge"), c.blurEdge ? 1 : 0);
    gl.uniform4f(
      gl.getUniformLocation(glassProgram, "u_tint"),
      c.tint.r / 255,
      c.tint.g / 255,
      c.tint.b / 255,
      c.tint.a,
    );
    for (const [name, value] of Object.entries({
      u_refThickness: c.refThickness,
      u_refDistance: c.refDistance,
      u_refFactor: c.refFactor,
      u_refDispersion: c.refDispersion,
      u_refFresnelRange: c.refFresnelRange,
      u_refFresnelHardness: c.refFresnelHardness / 100,
      u_refFresnelFactor: c.refFresnelFactor / 100,
      u_glareRange: c.glareRange,
      u_glareHardness: c.glareHardness / 100,
      u_glareFactor: c.glareFactor / 100,
      u_glareConvergence: c.glareConvergence / 100,
      u_glareOppositeFactor: c.glareOppositeFactor / 100,
      u_glareAngle: (c.glareAngle * Math.PI) / 180,
      u_materialHeight: c.shapeHeight,
    }))
      uniform(name, value);
    const rects = gl.getUniformLocation(glassProgram, "u_rects[0]");
    const glassDpr = gl.getUniformLocation(glassProgram, "u_dpr");
    const kernel = Array.from({ length: c.blurRadius + 1 }, (_, i) =>
      Math.exp((-0.5 * i * i) / Math.pow(c.blurRadius / 3, 2)),
    );
    const kernelSum = kernel[0]! + 2 * kernel.slice(1).reduce((a, b) => a + b, 0);
    const blurPrograms = [studioVertical, studioHorizontal].map((source) => {
      const p = ownProgram(),
        f = shader(gl.FRAGMENT_SHADER, source);
      gl.attachShader(p, vs);
      gl.attachShader(p, f);
      gl.bindAttribLocation(p, 0, "position");
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(p) || "Studio blur link failed");
      gl.useProgram(p);
      gl.uniform1i(gl.getUniformLocation(p, "u_blurRadius"), c.blurRadius);
      gl.uniform1fv(
        gl.getUniformLocation(p, "u_blurWeights[0]"),
        new Float32Array(kernel.map((w) => w / kernelSum)),
      );
      return { program: p, shader: f, size: gl.getUniformLocation(p, "u_resolution") };
    });
    gl.useProgram(program);
    const sceneTexture = ownTexture(),
      framebuffer = ownFramebuffer();
    const floatTarget = gl.getExtension("EXT_color_buffer_float");
    const sceneType = floatTarget ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    const sceneFormat = floatTarget ? gl.RGBA16F : gl.RGBA8;
    gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const blurTargets = blurPrograms.map(() => {
      const texture = ownTexture(),
        framebuffer = ownFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return { texture, framebuffer };
    });
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const hash = (i: number, seed: number) => {
      const n = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
      return n - Math.floor(n);
    };
    const sample = (time: number, seed: number) => {
      const i = Math.floor(time),
        f = time - i,
        s = f * f * (3 - 2 * f);
      return hash(i, seed) * (1 - s) + hash(i + 1, seed) * s;
    };
    const layers = Array.from({ length: 10 }, (_, i) => ({
      seed: 19 + i * 31,
      voice: i % 2 === 0,
      bins: [7, 11, 16, 22, 30, 40, 52, 66, 82, 96][i]!,
      height: [580, 520, 460, 400, 330, 260, 195, 135, 82, 48][i]!,
      opacity: 0.045 + i * 0.002,
      blur: [38, 35, 31, 27, 23, 19, 15, 12, 10, 8][i]!,
      range: 190 - i * 13,
      rate: 0.65 + hash(i, 101) * 1.8,
      hueStart: 184 + hash(i, 137) * 24,
      hueEnd: 270 + hash(i, 139) * 28,
      white: i < 5 ? 0 : 0.65 + (i - 5) * 0.0875,
    }));
    const data = new Uint8Array(128 * 10 * 4),
      offsets = new Float32Array(10),
      whiteStops = new Float32Array(30);
    gl.uniform1fv(locations.softness, new Float32Array(layers.map((l) => l.blur)));
    gl.uniform1fv(locations.opacity, new Float32Array(layers.map((l) => l.opacity)));
    gl.uniform3fv(
      locations.palettes,
      new Float32Array(layers.flatMap((l) => [l.hueStart, l.hueEnd, l.white])),
    );
    let smoothed = 0,
      fluxSmoothed = 0,
      allocatedWidth = 0,
      allocatedHeight = 0;
    const bandSmoothed = [0, 0, 0, 0, 0];
    const paint = (active: boolean) => {
      try {
        const measured = active ? getSpectrum() : quietSpectrum;
        smoothed = measured.energy;
        fluxSmoothed = measured.flux;
        for (let i = 0; i < bandSmoothed.length; i++) bandSmoothed[i] = measured.bands[i] ?? 0;
        const bounds = canvas.getBoundingClientRect();
        const capsules = Array.from(
          canvas.parentElement!.querySelectorAll<HTMLElement>("[data-voice-glass]"),
        )
          .filter((el) => {
            return el.getBoundingClientRect().width > 0;
          })
          .slice(0, 16)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [
              r.x - bounds.x + r.width / 2,
              canvas.clientHeight - (r.y - bounds.y) - r.height / 2,
              r.width,
              r.height,
            ] as const;
          });
        const geometry = new Float32Array(64),
          shadows = new Float32Array(64);
        capsules.forEach((r, i) => {
          geometry.set(r, i * 4);
          shadows.set([r[0], r[1] - 10, r[2], r[3]], i * 4);
        });
        const w = canvas.clientWidth,
          h = canvas.clientHeight,
          dpr = Math.min(devicePixelRatio || 1, 1.5);
        if (allocatedWidth !== Math.round(w * dpr) || allocatedHeight !== Math.round(h * dpr)) {
          canvas.width = allocatedWidth = Math.round(w * dpr);
          canvas.height = allocatedHeight = Math.round(h * dpr);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            sceneFormat,
            canvas.width,
            canvas.height,
            0,
            gl.RGBA,
            sceneType,
            null,
          );
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            sceneTexture,
            0,
          );
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error("Glass backdrop framebuffer incomplete");
          for (const target of blurTargets) {
            gl.bindTexture(gl.TEXTURE_2D, target.texture);
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              sceneFormat,
              canvas.width,
              canvas.height,
              0,
              gl.RGBA,
              sceneType,
              null,
            );
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              gl.TEXTURE_2D,
              target.texture,
              0,
            );
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
              throw new Error("Glass blur framebuffer incomplete");
          }
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform3fv(gl.getUniformLocation(program, "baseColor"), background);
        gl.uniform1f(gl.getUniformLocation(program, "darkMode"), background[0]! < 0.4 ? 1 : 0);
        const voice = smoothed;
        for (const [index, layer] of layers.entries()) {
          for (let stop = 0; stop < 3; stop++)
            whiteStops[index * 3 + stop] =
              sample(measured.bands[stop] ?? 0, layer.seed + 211 + stop * 71) * 1.2 - 0.1;
          const band = bandSmoothed[Math.min(4, Math.floor(index / 2))] ?? 0;
          const energy = layer.voice
            ? voice * (0.75 + 0.25 * sample(measured.bands[index % 5] ?? 0, layer.seed))
            : Math.max(band, smoothed * 0.4);
          offsets[index] = smoothed
            ? ((sample(Math.abs(fluxSmoothed), layer.seed + 17) * 2 - 1) * layer.range * smoothed +
                fluxSmoothed * 90 * (index % 2 ? 1 : -1)) /
              w
            : 0;
          const values = Array.from({ length: layer.bins }, (_, i) => {
            const x = i / (layer.bins - 1),
              center = layer.voice ? 0.65 + 0.35 * Math.exp(-Math.pow((x - 0.5) / 0.28, 2)) : 1;
            const profile = 0.35 + 0.65 * sample(i * 0.7, layer.seed + 29);
            const frequency =
              measured.bins[
                Math.min(
                  measured.bins.length - 1,
                  Math.floor((i / (layer.bins - 1)) * (measured.bins.length - 1)),
                )
              ] ?? 0;
            return (
              4 + layer.height * (h / 800) * energy * (profile * 0.75 + frequency * 0.25) * center
            );
          });
          for (let x = 0; x < 128; x++) {
            const p = (x / 127) * (layer.bins - 1),
              a = Math.floor(p),
              f = p - a,
              s = f * f * (3 - 2 * f);
            const height =
              (values[a]! * (1 - s) + values[Math.min(a + 1, layer.bins - 1)]! * s) / h;
            const encoded = Math.round(Math.min(1, height) * 65535),
              at = (index * 128 + x) * 4;
            data[at] = encoded >> 8;
            data[at + 1] = encoded & 255;
            data[at + 2] = 0;
            data[at + 3] = 255;
          }
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 128, 10, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.uniform2f(locations.size, w, h);
        gl.uniform1fv(locations.offsets, offsets);
        gl.uniform3fv(locations.whiteStops, whiteStops);
        gl.uniform4fv(locations.shadowRects, shadows);
        gl.uniform1i(gl.getUniformLocation(program, "rectCount"), capsules.length);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        for (let i = 0; i < 2; i++) {
          const blur = blurPrograms[i]!;
          gl.useProgram(blur.program);
          gl.bindFramebuffer(gl.FRAMEBUFFER, blurTargets[i]!.framebuffer);
          gl.bindTexture(gl.TEXTURE_2D, i === 0 ? sceneTexture : blurTargets[0]!.texture);
          gl.uniform2f(blur.size, canvas.width, canvas.height);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(glassProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, blurTargets[1]!.texture);
        gl.uniform2f(glassSize, canvas.width, canvas.height);
        gl.uniform1f(glassDpr, dpr);
        gl.uniform4fv(rects, geometry);
        gl.uniform1i(gl.getUniformLocation(glassProgram, "u_rectCount"), capsules.length);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      } catch {
        dispose();
        throw new Error("Spectral glass unavailable");
      }
    };

    return { paint, updateBackground, dispose };
  } catch {
    dispose();
    return null;
  }
}
