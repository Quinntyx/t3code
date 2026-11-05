import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { Suspense, useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";

import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useQuietThreadShells,
} from "~/state/entities";

import {
  BUDDY_REST_AFTER_MS,
  buddyRunOutcome,
  clampBuddyFraction,
  deriveBuddyLoop,
  deriveBuddyRest,
  isBuddyOneShot,
  restLoop,
  restTransition,
  type BuddyAnimation,
  type BuddyLoop,
  type BuddyOneShot,
  type BuddyPosition,
  type BuddyRest,
  type BuddyRunSnapshot,
} from "./buddy.logic";
import {
  BUDDY_CHARACTERS,
  clipLoadOrder,
  isBuddyCharacterId,
  loadBuddyClip,
  resolveBuddyClip,
  type BuddyCharacter,
} from "./buddyCharacters";
import { useBuddyCatalog } from "./buddySources";

const BUDDY_WIDTH_PX = 120;
// Clips are hard swaps, so quick activity changes would otherwise flicker between them.
const MIN_LOOP_MS = 3000;
const DRAG_THRESHOLD_PX = 4;

const BUDDY_POSITION_STORAGE_KEY = "t3code:buddy-position:v1";
const BuddyPositionSchema = Schema.Struct({ x: Schema.Number, y: Schema.Number });
const DEFAULT_BUDDY_POSITION: BuddyPosition = { x: 0.98, y: 0.8 };

export function BuddyHost() {
  const buddy = useClientSettings((settings) => settings.buddy);
  const sources = useClientSettings((settings) => settings.buddySources);
  const catalog = useBuddyCatalog(sources.map((source) => source.repositoryUrl));
  if (buddy === "none") return null;
  // A downloaded buddy resolves once its source has been read.
  const character = isBuddyCharacterId(buddy)
    ? BUDDY_CHARACTERS[buddy]
    : catalog.characters.get(buddy);
  if (character === undefined) return null;
  return createPortal(
    <Suspense fallback={null}>
      <BuddyOverlay key={buddy} character={character} />
    </Suspense>,
    document.body,
  );
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly origin: BuddyPosition;
  readonly spanX: number;
  readonly spanY: number;
  moved: boolean;
}

function dragTarget(drag: DragState, event: PointerEvent): BuddyPosition {
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  return {
    x: drag.spanX > 0 ? clampBuddyFraction(drag.origin.x + dx / drag.spanX) : drag.origin.x,
    y: drag.spanY > 0 ? clampBuddyFraction(drag.origin.y + dy / drag.spanY) : drag.origin.y,
  };
}

/**
 * Clips arrive one at a time so the pet can appear on the idle loop without
 * waiting on the other nineteen.
 */
function useBuddyClips(character: BuddyCharacter) {
  const [urls, setUrls] = useState<Partial<Record<BuddyAnimation, string>>>({});
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches each clip blob from the network and keeps it mounted for the session
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const name of clipLoadOrder(character)) {
        const url = character.clips[name];
        if (url === undefined) continue;
        const objectUrl = await loadBuddyClip(url);
        if (cancelled) return;
        if (objectUrl !== null) setUrls((previous) => ({ ...previous, [name]: objectUrl }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [character]);
  return urls;
}

function BuddyOverlay({ character }: { character: BuddyCharacter }) {
  const loadedClips = useBuddyClips(character);
  const height = Math.round(BUDDY_WIDTH_PX / character.aspectRatio);
  const animation = useBuddyAnimation();
  const [storedPosition, setStoredPosition] = useLocalStorage(
    BUDDY_POSITION_STORAGE_KEY,
    DEFAULT_BUDDY_POSITION,
    BuddyPositionSchema,
  );
  const [dragPosition, setDragPosition] = useState<BuddyPosition | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const videosRef = useRef(new Map<BuddyAnimation, HTMLVideoElement>());
  const position = dragPosition ?? {
    x: clampBuddyFraction(storedPosition.x),
    y: clampBuddyFraction(storedPosition.y),
  };

  // A slot without its own art borrows the nearest clip this character ships.
  const loadedOnly: BuddyCharacter = { ...character, clips: loadedClips };
  const requested = resolveBuddyClip(loadedOnly, animation.name);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the media elements: only the clip on screen plays, from its first frame
  useEffect(() => {
    for (const [name, video] of videosRef.current) {
      if (name !== requested) video.pause();
    }
    const active = videosRef.current.get(requested);
    if (active === undefined) return;
    active.currentTime = 0;
    void active.play().catch(() => undefined);
  }, [requested]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const layer = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!layer) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: position,
      spanX: layer.width - BUDDY_WIDTH_PX,
      spanY: layer.height - height,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    drag.moved = true;
    setDragPosition(dragTarget(drag, event));
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) {
      setStoredPosition(dragTarget(drag, event));
      setDragPosition(null);
    } else if (event.type === "pointerup") {
      poke();
    }
  };

  const poke = () => {
    const video = videosRef.current.get("angry");
    if (animation.name === "angry" && video) {
      video.currentTime = 0;
      void video.play().catch(() => undefined);
      return;
    }
    animation.react("angry");
  };

  if (loadedClips.idle === undefined) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[2147483647]">
      <div
        aria-hidden
        className={cn(
          "pointer-events-auto absolute touch-none overflow-hidden select-none [-webkit-app-region:no-drag]",
          dragPosition === null ? "cursor-grab" : "cursor-grabbing",
        )}
        style={{
          width: BUDDY_WIDTH_PX,
          height,
          left: `calc((100% - ${BUDDY_WIDTH_PX}px) * ${position.x})`,
          top: `calc((100% - ${height}px) * ${position.y})`,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        // A native drag of the video would cancel the pointer drag.
        onDragStart={(event) => event.preventDefault()}
      >
        {(Object.entries(loadedClips) as Array<[BuddyAnimation, string]>).map(([name, src]) => (
          <video
            key={name}
            ref={(video) => {
              if (video === null) return;
              videosRef.current.set(name, video);
              return () => {
                videosRef.current.delete(name);
              };
            }}
            className={cn("absolute max-w-none", name === requested ? "visible" : "invisible")}
            style={character.clipStyle}
            src={src}
            draggable={false}
            muted
            playsInline
            preload="auto"
            disablePictureInPicture
            loop={!isBuddyOneShot(name)}
            onEnded={name === requested ? animation.finish : undefined}
            // A clip can mount before its data arrives, and a rejected play() would
            // otherwise leave the pet frozen on frame one until the state changed.
            onCanPlay={
              name === requested
                ? (event) => void event.currentTarget.play().catch(() => undefined)
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

interface BuddyAnimationState {
  readonly name: BuddyAnimation;
  readonly react: (oneShot: BuddyOneShot) => void;
  readonly finish: () => void;
}

/** Sleep thresholds, so a signature reads once instead of repeating the triple. */
const REST_THRESHOLDS_MS = [
  BUDDY_REST_AFTER_MS.restless,
  BUDDY_REST_AFTER_MS.dozing,
  BUDDY_REST_AFTER_MS.sleeping,
];

/** The clip that reflects the routed thread's agent right now. */
function useBuddyAnimation(): BuddyAnimationState {
  const threadRef = useThreadRouteRef();
  const shell = useQuietThreadShell(threadRef);
  const active = threadRuntimeIsActive(shell?.runtime);
  const structure = useQuietThreadProjection(active ? threadRef : null);
  const allShells = useQuietThreadShells();
  const activeThreadCount = allShells.filter((entry) =>
    threadRuntimeIsActive(entry.runtime),
  ).length;
  const busyLoop = deriveBuddyLoop(
    shell,
    structure?.projection.turnItems ?? [],
    Math.max(1, activeThreadCount),
  );

  const [oneShot, setOneShot] = useState<BuddyOneShot | null>(null);

  // The doze-off sequence only starts once the routed thread has been quiet.
  const [rest, setRest] = useState<BuddyRest>("awake");
  const restRef = useRef<BuddyRest>("awake");
  const idleSinceRef = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the doze-off timers, and the stage they advance, in step with the routed thread going quiet
  useEffect(() => {
    if (busyLoop !== "idle" || idleSinceRef.current === null) idleSinceRef.current = Date.now();
    const idleSince = idleSinceRef.current;
    // Every stage change lands in a timer, never synchronously inside the effect.
    const advance = () => {
      const next = deriveBuddyRest(Date.now() - idleSince);
      const previous = restRef.current;
      if (previous === next) return;
      restRef.current = next;
      setRest(next);
      const transition = restTransition(previous, next);
      if (transition !== null) setOneShot(transition);
    };
    const timers = [0, ...REST_THRESHOLDS_MS].map((threshold) =>
      window.setTimeout(advance, Math.max(0, idleSince + threshold - Date.now())),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [busyLoop]);

  const loop: BuddyLoop = busyLoop === "idle" ? restLoop(rest) : busyLoop;

  const run: BuddyRunSnapshot | null =
    threadRef !== null && shell?.latestRun
      ? {
          threadKey: scopedThreadKey(threadRef),
          runId: shell.latestRun.runId,
          status: shell.latestRun.status,
        }
      : null;
  const [seenRun, setSeenRun] = useState(run);
  if (
    seenRun?.threadKey !== run?.threadKey ||
    seenRun?.runId !== run?.runId ||
    seenRun?.status !== run?.status
  ) {
    setSeenRun(run);
    const outcome = buddyRunOutcome(seenRun, run);
    if (outcome !== null) setOneShot(outcome);
  }

  const [shownLoop, setShownLoop] = useState<{ loop: BuddyLoop; since: number }>(() => ({
    loop,
    since: 0,
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds each loop on screen for MIN_LOOP_MS before swapping to the next activity
  useEffect(() => {
    if (shownLoop.loop === loop) return;
    const timer = window.setTimeout(
      () => setShownLoop({ loop, since: Date.now() }),
      Math.max(0, shownLoop.since + MIN_LOOP_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [loop, shownLoop]);

  return {
    name: oneShot ?? shownLoop.loop,
    react: setOneShot,
    finish: () => {
      if (oneShot === null) return;
      setOneShot(null);
      setShownLoop({ loop, since: Date.now() });
    },
  };
}
