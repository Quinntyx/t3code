import { quietSpectrum, type SpectrumFrame } from "./spectrum";

const vertex = `#version 300 es
in vec2 position;out vec2 uv;void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;

// Layers composite in premultiplied alpha, so the panel's own surface (and its glass) shows through.
const fragment = `#version 300 es
precision highp float;out vec4 fragColor;in vec2 uv;
uniform sampler2D profiles;uniform vec2 size;uniform float darkMode;
uniform float offsets[10];uniform float softness[10];uniform float opacity[10];
uniform vec3 palettes[10];uniform vec3 whiteStops[10];
float heightAt(float x,float row){vec4 s=texture(profiles,vec2(clamp(x,0.,1.),row));return (s.r*65280.+s.g*255.)/65535.;}
vec3 hue(float h){vec3 p=abs(fract(vec3(h)+vec3(0.,.666667,.333333))*6.-3.);return (mix(vec3(.478),clamp(p-1.,0.,1.),.636)*.73+.18)*.97;}
vec4 over(vec4 below,vec3 color,float alpha){return vec4(below.rgb*(1.-alpha)+color*alpha,below.a*(1.-alpha)+alpha);}
void main(){
  vec4 col=vec4(0.);
  for(int i=0;i<10;i++){
    float row=(float(i)+.5)/10.;float x=(uv.x+.2-offsets[i])/1.4;
    float dx=softness[i]/size.x/1.4;
    float peak=heightAt(x,row)*.28;
    peak+=(heightAt(x-dx,row)+heightAt(x+dx,row))*.22;
    peak+=(heightAt(x-dx*2.,row)+heightAt(x+dx*2.,row))*.11;
    peak+=(heightAt(x-dx*3.,row)+heightAt(x+dx*3.,row))*.03;
    float radius=softness[i]/size.y;
    float field=1.-smoothstep(peak-radius*1.7,peak+radius*1.7,uv.y);
    vec3 color=hue(mix(palettes[i].x,palettes[i].y,uv.x)/360.);
    vec3 patches=1.-smoothstep(vec3(.025),vec3(.12),abs(vec3(uv.x)-whiteStops[i]));
    float white=max(patches.x,max(patches.y,patches.z))*palettes[i].z;
    color=mix(color,mix(vec3(1.,.998,.985),vec3(.26),darkMode),white);
    col=over(col,color,field*opacity[i]*(1.+white*.14));
  }
  col=over(col,hue((190.+95.*uv.x)/360.),(1.-smoothstep(0.,.018,uv.y))*.12);
  fragColor=col;
}`;

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
  hueStart: 184 + hash(i, 137) * 24,
  hueEnd: 270 + hash(i, 139) * 28,
  white: i < 5 ? 0 : 0.65 + (i - 5) * 0.0875,
}));

export function createSpectralRenderer(
  canvas: HTMLCanvasElement,
  getSpectrum: () => SpectrumFrame,
) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
  });
  if (!gl) return null;
  const program = gl.createProgram();
  const shaders = [gl.createShader(gl.VERTEX_SHADER)!, gl.createShader(gl.FRAGMENT_SHADER)!];
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  const dispose = () => {
    for (const shader of shaders) gl.deleteShader(shader);
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    gl.deleteTexture(texture);
  };
  try {
    [vertex, fragment].forEach((source, index) => {
      const shader = shaders[index]!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) || "Spectrum shader failed");
      gl.attachShader(program, shader);
    });
    gl.bindAttribLocation(program, 0, "position");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || "Spectrum link failed");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const locations = {
      size: uniform("size"),
      darkMode: uniform("darkMode"),
      offsets: uniform("offsets[0]"),
      whiteStops: uniform("whiteStops[0]"),
    };
    gl.uniform1fv(uniform("softness[0]"), new Float32Array(layers.map((l) => l.blur)));
    gl.uniform1fv(uniform("opacity[0]"), new Float32Array(layers.map((l) => l.opacity)));
    gl.uniform3fv(
      uniform("palettes[0]"),
      new Float32Array(layers.flatMap((l) => [l.hueStart, l.hueEnd, l.white])),
    );
    const data = new Uint8Array(128 * 10 * 4),
      offsets = new Float32Array(10),
      whiteStops = new Float32Array(30);

    const paint = (active: boolean) => {
      try {
        const measured = active ? getSpectrum() : quietSpectrum;
        const w = canvas.clientWidth,
          h = canvas.clientHeight,
          dpr = Math.min(devicePixelRatio || 1, 1.5);
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform1f(
          locations.darkMode,
          document.documentElement.classList.contains("dark") ? 1 : 0,
        );
        for (const [index, layer] of layers.entries()) {
          for (let stop = 0; stop < 3; stop++)
            whiteStops[index * 3 + stop] =
              sample(measured.bands[stop] ?? 0, layer.seed + 211 + stop * 71) * 1.2 - 0.1;
          const band = measured.bands[Math.min(4, Math.floor(index / 2))] ?? 0;
          const energy = layer.voice
            ? measured.energy * (0.75 + 0.25 * sample(measured.bands[index % 5] ?? 0, layer.seed))
            : Math.max(band, measured.energy * 0.4);
          offsets[index] = measured.energy
            ? ((sample(Math.abs(measured.flux), layer.seed + 17) * 2 - 1) *
                layer.range *
                measured.energy +
                measured.flux * 90 * (index % 2 ? 1 : -1)) /
              w
            : 0;
          const values = Array.from({ length: layer.bins }, (_, i) => {
            const x = i / (layer.bins - 1),
              center = layer.voice ? 0.65 + 0.35 * Math.exp(-Math.pow((x - 0.5) / 0.28, 2)) : 1;
            const profile = 0.35 + 0.65 * sample(i * 0.7, layer.seed + 29);
            const frequency =
              measured.bins[
                Math.min(measured.bins.length - 1, Math.floor(x * (measured.bins.length - 1)))
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
            data[at + 3] = 255;
          }
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 128, 10, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.uniform2f(locations.size, w, h);
        gl.uniform1fv(locations.offsets, offsets);
        gl.uniform3fv(locations.whiteStops, whiteStops);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      } catch {
        dispose();
        throw new Error("Spectral glow unavailable");
      }
    };

    return { paint, dispose };
  } catch {
    dispose();
    return null;
  }
}
