import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  SRGBColorSpace,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OrbitIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

import { loadModelBytes } from "./modelCache";
import { hasGlbSignature, modelExtension } from "./modelFormat";

export interface ModelViewerContentProps {
  readonly src: string;
  readonly name: string;
  readonly cacheKey?: string | undefined;
  readonly className?: string | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
  readonly onReload: () => void;
}

type Status = "loading" | "ready" | "error";

type Renderable = Object3D & {
  readonly geometry?: BufferGeometry;
  readonly material?: Material | Material[];
};

function disposeObject(object: Object3D): void {
  const bitmaps = new Set<ImageBitmap>();
  object.traverse((child) => {
    const renderable = child as Renderable;
    renderable.geometry?.dispose();
    if (renderable.material === undefined) return;
    for (const material of Array.isArray(renderable.material)
      ? renderable.material
      : [renderable.material]) {
      for (const value of Object.values(material)) {
        if (!(value instanceof Texture)) continue;
        if (typeof ImageBitmap !== "undefined" && value.image instanceof ImageBitmap) {
          bitmaps.add(value.image);
        }
        value.dispose();
      }
      material.dispose();
    }
  });
  for (const bitmap of bitmaps) bitmap.close();
}

async function loadModel(source: ArrayBuffer, extension: string, name: string): Promise<Object3D> {
  const format = hasGlbSignature(source) ? "glb" : extension;
  if (format === "glb") {
    const gltf = await new GLTFLoader().parseAsync(source, "");
    return gltf.scene;
  }
  if (format === "stl") {
    const geometry = new STLLoader().parse(source);
    return new Mesh(
      geometry,
      new MeshStandardMaterial({ color: 0x9fb3c8, metalness: 0.15, roughness: 0.6 }),
    );
  }
  if (format === "obj") {
    const object = new OBJLoader().parse(new TextDecoder().decode(source));
    object.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      if (child.geometry.getAttribute("normal") === undefined)
        child.geometry.computeVertexNormals();
      const previous = child.material;
      child.material = new MeshStandardMaterial({
        color: 0x9fb3c8,
        metalness: 0.15,
        roughness: 0.6,
        vertexColors: child.geometry.getAttribute("color") !== undefined,
      });
      for (const material of Array.isArray(previous) ? previous : [previous]) material.dispose();
    });
    return object;
  }
  throw new Error(`Unsupported 3D format: ${name}`);
}

export function ModelViewerContent(props: ModelViewerContentProps) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const viewRef = useRef<{
    readonly reset: () => void;
    readonly setRotation: (enabled: boolean) => void;
  } | null>(null);
  const autoRotateRef = useRef(false);
  const [status, setStatus] = useState<Status>("loading");
  const [autoRotate, setAutoRotate] = useState(false);
  const format = modelExtension(props.name, props.src).toUpperCase();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- WebGL scene lifecycle follows the loaded model
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const abort = new AbortController();
    let disposed = false;
    let renderer: WebGLRenderer | null = null;
    let environment: Texture | null = null;
    const scene = new Scene();
    let stopRotation: (() => void) | null = null;

    const cleanup = () => {
      disposed = true;
      abort.abort();
      stopResize();
      stopRotation?.();
      controls?.dispose();
      disposeObject(scene);
      environment?.dispose();
      renderer?.forceContextLoss();
      renderer?.dispose();
      renderer?.domElement.remove();
      renderer = null;
      viewRef.current = null;
    };
    let controls: OrbitControls | null = null;
    let stopResize: () => void = () => {};

    void (async () => {
      try {
        renderer = new WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = SRGBColorSpace;
        renderer.toneMapping = ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1;
        renderer.domElement.className =
          "block size-full cursor-grab touch-none active:cursor-grabbing";
        renderer.domElement.setAttribute("aria-hidden", "true");
        container.appendChild(renderer.domElement);

        const camera = new PerspectiveCamera(45, 1, 0.01, 1000);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = false;
        controls.enablePan = false;
        controls.autoRotateSpeed = 2;

        const pmrem = new PMREMGenerator(renderer);
        environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
        scene.environment = environment;
        scene.environmentIntensity = 1;

        const render = () => renderer?.render(scene, camera);
        controls.addEventListener("change", render);

        scene.add(new HemisphereLight(0xffffff, 0x334155, 1.2));
        const keyLight = new DirectionalLight(0xffffff, 1.6);
        scene.add(keyLight, keyLight.target);
        const fillLight = new DirectionalLight(0xffffff, 0.6);
        fillLight.position.set(-1, -0.4, -1);
        scene.add(fillLight, fillLight.target);

        const resize = () => {
          if (renderer === null) return;
          const width = container.clientWidth;
          const height = container.clientHeight;
          if (width === 0 || height === 0) return;
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          render();
        };
        stopResize = observeResize(container, resize);
        resize();

        const object = await loadModel(
          await loadModelBytes(props.cacheKey ?? props.src, props.src, abort.signal),
          modelExtension(props.name, props.src),
          props.name,
        );
        if (disposed) {
          disposeObject(object);
          return;
        }

        object.updateWorldMatrix(true, true);
        const bounds = new Box3().setFromObject(object);
        const size = bounds.getSize(new Vector3());
        const center = bounds.getCenter(new Vector3());
        object.position.sub(center);
        const group = new Group();
        group.add(object);
        scene.add(group);

        const radius = Math.max(size.length() / 2, 0.001);
        const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.15;
        const home = new Vector3(0.62, 0.5, 0.85).setLength(distance);
        camera.near = Math.max(distance / 1000, 0.001);
        camera.far = distance * 100;
        camera.position.copy(home);
        camera.updateProjectionMatrix();
        keyLight.position.copy(home).multiplyScalar(1.5);
        keyLight.target.position.set(0, 0, 0);
        controls.target.set(0, 0, 0);
        controls.minDistance = radius * 0.4;
        controls.maxDistance = distance * 3;
        controls.update();

        let frame = 0;
        let rotating = false;
        const tick = () => {
          if (!rotating) return;
          controls?.update();
          render();
          frame = requestAnimationFrame(tick);
        };
        const setRotation = (enabled: boolean) => {
          rotating = enabled;
          if (controls !== null) controls.autoRotate = enabled;
          cancelAnimationFrame(frame);
          if (enabled) frame = requestAnimationFrame(tick);
          else render();
        };
        stopRotation = () => setRotation(false);

        viewRef.current = {
          reset: () => {
            camera.position.copy(home);
            controls?.target.set(0, 0, 0);
            controls?.update();
            render();
          },
          setRotation,
        };
        setStatus("ready");
        render();
        resize();
        if (autoRotateRef.current) setRotation(true);
      } catch (cause) {
        if (disposed || abort.signal.aborted) return;
        setStatus("error");
        console.warn("3D model preview failed", cause);
      }
    })();

    return cleanup;
  }, [props.cacheKey, props.name, props.src]);

  const resetView = () => viewRef.current?.reset();
  const toggleRotation = () => {
    const enabled = !autoRotate;
    autoRotateRef.current = enabled;
    setAutoRotate(enabled);
    viewRef.current?.setRotation(enabled);
  };
  const retry = () => {
    void props.onRetry?.();
    props.onReload();
  };

  return (
    <span
      className="relative block size-full"
      role="group"
      aria-label={`Interactive 3D model: ${props.name}`}
    >
      <span ref={containerRef} className={cn("block size-full", props.className)} />
      {status === "loading" ? (
        <span className="absolute inset-0 flex items-center justify-center bg-muted/30 text-xs text-muted-foreground motion-safe:animate-skeleton">
          Loading 3D model…
        </span>
      ) : null}
      {status === "error" ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/40 p-4 text-center text-xs text-muted-foreground">
          <span>3D model unavailable · {props.name}</span>
          <Button variant="outline" size="xs" onClick={retry}>
            Retry
          </Button>
        </span>
      ) : null}
      {status === "ready" ? (
        <>
          <span className="pointer-events-auto absolute right-1.5 top-1.5 flex gap-1">
            <Button
              variant="glass"
              size="icon-xs"
              aria-label="Reset camera"
              title="Reset camera"
              onClick={resetView}
            >
              <RotateCcwIcon />
            </Button>
            <Button
              variant="glass"
              size="icon-xs"
              aria-pressed={autoRotate}
              aria-label="Toggle auto-rotate"
              title="Toggle auto-rotate"
              onClick={toggleRotation}
            >
              <OrbitIcon />
            </Button>
          </span>
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-sm bg-background/70 px-1.5 py-0.5 text-3xs font-medium tracking-wide text-muted-foreground backdrop-blur-sm">
            {format || "3D"}
          </span>
        </>
      ) : null}
    </span>
  );
}
