/**
 * Glass made of several rounded rectangles that blend into one body, following
 * liquid-glass-studio: the parts merge through a rounded signed-distance union, and refraction
 * follows that field's normal, so a joint is glass interior rather than two rims meeting.
 */

export interface LiquidGlassPart {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /** Radius of the concave blend where this part joins the parts before it. */
  fillet: number;
}

export interface LiquidGlassShape {
  width: number;
  height: number;
  parts: readonly LiquidGlassPart[];
}

export interface GlassEdge {
  d: string;
  normalX: number;
  normalY: number;
}

// Matches the rect map: a 12px refracting rim whose inner edge is softened by a 4px gaussian.
export const RIM_WIDTH = 12;
const RIM_SOFTNESS = 4;
const RIM_REACH = RIM_WIDTH + RIM_SOFTNESS * 3;
const OUTLINE_TOLERANCE = 0.15;

function partDistance(part: LiquidGlassPart, x: number, y: number): number {
  const radius = Math.max(0, Math.min(part.radius, part.width / 2, part.height / 2));
  const qx = Math.abs(x - part.x - part.width / 2) - part.width / 2 + radius;
  const qy = Math.abs(y - part.y - part.height / 2) - part.height / 2 + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

// hg_sdf's fOpUnionRound: an exact circular fillet where two edges meet.
function unionRound(a: number, b: number, radius: number): number {
  if (radius <= 0) return Math.min(a, b);
  return (
    Math.max(radius, Math.min(a, b)) - Math.hypot(Math.max(radius - a, 0), Math.max(radius - b, 0))
  );
}

export function shapeDistance(shape: LiquidGlassShape, x: number, y: number): number {
  let distance = Infinity;
  for (const part of shape.parts) {
    const next = partDistance(part, x, y);
    distance = distance === Infinity ? next : unionRound(distance, next, part.fillet);
  }
  return distance;
}

/** Outward unit normal of the union at a point. */
function shapeNormal(shape: LiquidGlassShape, x: number, y: number): [number, number] {
  const h = 0.5;
  const nx = shapeDistance(shape, x + h, y) - shapeDistance(shape, x - h, y);
  const ny = shapeDistance(shape, x, y + h) - shapeDistance(shape, x, y - h);
  const length = Math.hypot(nx, ny) || 1;
  return [nx / length, ny / length];
}

/** Cheap bounds so only points near the outline pay for the full union. */
function classify(shape: LiquidGlassShape, x: number, y: number, reach: number): -1 | 0 | 1 {
  let outside = true;
  for (const part of shape.parts) {
    const inset = Math.max(reach, part.radius);
    if (
      x >= part.x + inset &&
      x <= part.x + part.width - inset &&
      y >= part.y + inset &&
      y <= part.y + part.height - inset
    ) {
      return -1;
    }
    const pad = part.fillet + 2;
    if (
      x >= part.x - pad &&
      x <= part.x + part.width + pad &&
      y >= part.y - pad &&
      y <= part.y + part.height + pad
    ) {
      outside = false;
    }
  }
  return outside ? 1 : 0;
}

// Abramowitz-Stegun 7.1.26; plenty for an 8-bit map.
function gaussianCdf(value: number): number {
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return value >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// The map is smooth (normals and a 4px-softened rim), so a 2px grid carries it; the exact
// distance field also interpolates the outline to well under a pixel at that spacing.
const STEP = 2;

interface DistanceField {
  values: Float32Array;
  columns: number;
  rows: number;
}

/** Distances at map-pixel centers, padded by one sample on each side so the outline closes. */
function sampleField(shape: LiquidGlassShape): DistanceField {
  const columns = Math.ceil(shape.width / STEP) + 2;
  const rows = Math.ceil(shape.height / STEP) + 2;
  const values = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const y = (row - 0.5) * STEP;
    for (let column = 0; column < columns; column += 1) {
      const x = (column - 0.5) * STEP;
      const region = classify(shape, x, y, RIM_REACH);
      values[row * columns + column] =
        region === 0 ? shapeDistance(shape, x, y) : region * RIM_REACH;
    }
  }
  return { values, columns, rows };
}

// R=0 (no rim), G=B=128 (no displacement), opaque; written as one little-endian word.
const NEUTRAL_PIXEL = 0xff808000;

/**
 * The displacement map as RGBA pixels: B and G carry the outward normal scaled by the rim
 * weight (neutral 0.5 in the interior), and R carries the rim weight for the center blur.
 */
function rasterizeMap({ values, columns, rows }: DistanceField) {
  const width = columns - 2;
  const height = rows - 2;
  const pixels = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  new Uint32Array(pixels.buffer).fill(NEUTRAL_PIXEL);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = (row + 1) * columns + column + 1;
      const depth = -(values[index] ?? 0);
      if (depth >= RIM_REACH) continue;
      const rim = depth > -1 ? 1 - gaussianCdf((depth - RIM_WIDTH) / RIM_SOFTNESS) : 1;
      const gradientX = (values[index + 1] ?? 0) - (values[index - 1] ?? 0);
      const gradientY = (values[index + columns] ?? 0) - (values[index - columns] ?? 0);
      const scale = (0.5 * rim) / (Math.hypot(gradientX, gradientY) || 1);
      const offset = (row * width + column) * 4;
      pixels[offset] = Math.round(rim * 255);
      pixels[offset + 1] = Math.round((0.5 + gradientY * scale) * 255);
      pixels[offset + 2] = Math.round((0.5 + gradientX * scale) * 255);
    }
  }
  return { pixels, width, height };
}

type Point = [number, number];

/** Traces the union's zero contour with marching squares over the sampled field. */
function traceOutline({ values, columns, rows }: DistanceField): Point[] {
  // Crossing points sit on grid edges: id 2k is the edge right of sample k, 2k+1 the one below.
  const count = columns * rows * 2;
  const pointX = new Float32Array(count);
  const pointY = new Float32Array(count);
  const linkA = new Int32Array(count).fill(-1);
  const linkB = new Int32Array(count).fill(-1);
  const crossing = (a: number, b: number, vertical: boolean) => {
    const id = a * 2 + (vertical ? 1 : 0);
    const va = values[a] ?? 0;
    const t = va / (va - (values[b] ?? 0));
    pointX[id] = ((a % columns) - 0.5 + (vertical ? 0 : t)) * STEP;
    pointY[id] = (Math.floor(a / columns) - 0.5 + (vertical ? t : 0)) * STEP;
    return id;
  };
  const link = (from: number, to: number) => {
    if (linkA[from] === -1) linkA[from] = to;
    else linkB[from] = to;
    if (linkA[to] === -1) linkA[to] = from;
    else linkB[to] = from;
  };
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const topLeft = row * columns + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      const a = (values[topLeft] ?? 0) < 0;
      const b = (values[topRight] ?? 0) < 0;
      const c = (values[bottomRight] ?? 0) < 0;
      const d = (values[bottomLeft] ?? 0) < 0;
      if (a === b && b === c && c === d) continue;
      const top = a !== b ? crossing(topLeft, topRight, false) : -1;
      const right = b !== c ? crossing(topRight, bottomRight, true) : -1;
      const bottom = d !== c ? crossing(bottomLeft, bottomRight, false) : -1;
      const left = a !== d ? crossing(topLeft, bottomLeft, true) : -1;
      if (top !== -1 && right !== -1 && bottom !== -1 && left !== -1) {
        // Saddle: the cell center decides which corners connect.
        const center =
          (values[topLeft] ?? 0) +
          (values[topRight] ?? 0) +
          (values[bottomLeft] ?? 0) +
          (values[bottomRight] ?? 0);
        if (center < 0 === a) {
          link(top, right);
          link(bottom, left);
        } else {
          link(top, left);
          link(bottom, right);
        }
        continue;
      }
      const ends = [top, right, bottom, left].filter((edge) => edge !== -1);
      link(ends[0] ?? 0, ends[1] ?? 0);
    }
  }
  let longest: Point[] = [];
  const visited = new Uint8Array(count);
  for (let start = 0; start < count; start += 1) {
    if (linkA[start] === -1 || visited[start]) continue;
    const loop: Point[] = [];
    let previous = -1;
    let current = start;
    while (current !== -1 && !visited[current]) {
      visited[current] = 1;
      loop.push([pointX[current] ?? 0, pointY[current] ?? 0]);
      const first = linkA[current] ?? -1;
      const next = first !== previous && first !== -1 ? first : (linkB[current] ?? -1);
      previous = current;
      current = next;
    }
    if (loop.length > longest.length) longest = loop;
  }
  return longest;
}

function simplify(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points];
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  let farthest = 0;
  let index = 0;
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const length = Math.hypot(dx, dy);
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i] as Point;
    const distance =
      length === 0
        ? Math.hypot(px - first[0], py - first[1])
        : Math.abs(dy * px - dx * py + last[0] * first[1] - last[1] * first[0]) / length;
    if (distance > farthest) {
      farthest = distance;
      index = i;
    }
  }
  if (farthest <= tolerance) return [first, last];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

const round = (value: number) => Math.round(value * 100) / 100;

export interface GlassGeometry {
  /** The displacement map; stretched over the shape, so it may be coarser than the shape. */
  map: { pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
  /** The union's outline as an SVG path. */
  path: string;
  /** The outline's straight pieces with their outward normals, for the rim light. */
  edges: GlassEdge[];
}

export function buildGlassGeometry(shape: LiquidGlassShape): GlassGeometry {
  const field = sampleField(shape);
  const map = rasterizeMap(field);
  const loop = traceOutline(field);
  if (loop.length < 3) return { map, path: "", edges: [] };
  // Split the closed loop at its farthest pair so simplification keeps both halves anchored.
  const start = loop[0] as Point;
  let split = 0;
  let farthest = 0;
  loop.forEach(([x, y], index) => {
    const distance = Math.hypot(x - start[0], y - start[1]);
    if (distance > farthest) {
      farthest = distance;
      split = index;
    }
  });
  const outline = [
    ...simplify(loop.slice(0, split + 1), OUTLINE_TOLERANCE).slice(0, -1),
    ...simplify([...loop.slice(split), start], OUTLINE_TOLERANCE).slice(0, -1),
  ];
  const point = ([x, y]: Point) => `${round(x)} ${round(y)}`;
  const edges = outline.map((from, index) => {
    const to = outline[(index + 1) % outline.length] as Point;
    const [normalX, normalY] = shapeNormal(shape, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
    return { d: `M${point(from)}L${point(to)}`, normalX, normalY };
  });
  return { map, path: `M${outline.map(point).join("L")}Z`, edges };
}
