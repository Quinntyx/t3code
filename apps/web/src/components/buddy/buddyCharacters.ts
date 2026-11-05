import type { Buddy } from "@t3tools/contracts/settings";
import type { CSSProperties } from "react";

import { BUDDY_ANIMATIONS, type BuddyAnimation } from "./buddy.logic";

/** Buddies drawn into the app itself; downloaded ones are resolved at runtime. */
export type BuddyCharacterId = "whale-chan" | "clawd";

export const BUDDY_CHARACTER_IDS: ReadonlyArray<BuddyCharacterId> = ["whale-chan", "clawd"];

export const isBuddyCharacterId = (value: Buddy): value is BuddyCharacterId =>
  BUDDY_CHARACTER_IDS.includes(value as BuddyCharacterId);

export interface BuddyCharacter {
  readonly label: string;
  readonly description: string;
  /** Only the slots this character has art for; `resolveBuddyClip` fills the rest. */
  readonly clips: Partial<Record<BuddyAnimation, string>>;
  /** Positions a clip so that only the character's rectangle shows. */
  readonly clipStyle: CSSProperties;
  readonly aspectRatio: number;
}

/**
 * Every clip a character lacks falls back down this chain, which always ends at
 * `idle`. It keeps a small set (Whale-chan ships seven) working across all states.
 */
const BUDDY_FALLBACKS: Readonly<Record<BuddyAnimation, ReadonlyArray<BuddyAnimation>>> = {
  idle: [],
  roam: ["idle"],
  thinking: ["idle"],
  working: ["thinking", "idle"],
  working2: ["working", "thinking", "idle"],
  working3: ["working2", "working", "idle"],
  juggling: ["working", "thinking", "idle"],
  juggling2: ["juggling", "working", "idle"],
  waiting: ["thinking", "idle"],
  sweeping: ["working", "thinking", "idle"],
  carrying: ["working", "thinking", "idle"],
  yawning: ["idle"],
  dozing: ["thinking", "idle"],
  collapsing: ["dozing", "thinking", "idle"],
  sleeping: ["dozing", "thinking", "idle"],
  waking: ["idle"],
  success: ["idle"],
  error: ["idle"],
  angry: ["error", "idle"],
  drag: ["angry", "error", "idle"],
};

export function resolveBuddyClip(
  character: BuddyCharacter,
  animation: BuddyAnimation,
): BuddyAnimation {
  if (character.clips[animation] !== undefined) return animation;
  for (const candidate of BUDDY_FALLBACKS[animation]) {
    if (character.clips[candidate] !== undefined) return candidate;
  }
  return "idle";
}

const CLIP_URLS = import.meta.glob<string>("~/assets/buddy/*/*.webm", {
  eager: true,
  query: "?url",
  import: "default",
});

function clipsFor(character: BuddyCharacterId): Partial<Record<BuddyAnimation, string>> {
  const clips: Partial<Record<BuddyAnimation, string>> = {};
  for (const [file, url] of Object.entries(CLIP_URLS)) {
    const match = /buddy\/([^/]+)\/([^/]+)\.webm$/.exec(file);
    if (match === null || match[1] !== character) continue;
    const slot = match[2] as BuddyAnimation;
    if (BUDDY_ANIMATIONS.includes(slot)) clips[slot] = url;
  }
  return clips;
}

function cropStyle(
  frame: { readonly width: number; readonly height: number },
  crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): CSSProperties {
  return {
    width: `${(frame.width / crop.width) * 100}%`,
    height: `${(frame.height / crop.height) * 100}%`,
    left: `${(-crop.x / crop.width) * 100}%`,
    top: `${(-crop.y / crop.height) * 100}%`,
  };
}

const FULL_FRAME: CSSProperties = { width: "100%", height: "100%", left: 0, top: 0 };

export const BUDDY_CHARACTERS: Readonly<Record<BuddyCharacterId, BuddyCharacter>> = {
  "whale-chan": {
    label: "Whale-chan",
    description: "DeepSeek",
    clips: clipsFor("whale-chan"),
    clipStyle: cropStyle({ width: 640, height: 360 }, { x: 155, y: 6, width: 313, height: 331 }),
    aspectRatio: 313 / 331,
  },
  clawd: {
    label: "Clawd",
    description: "Claude",
    clips: clipsFor("clawd"),
    clipStyle: FULL_FRAME,
    aspectRatio: 1,
  },
};

/** Idle first, then the loop states, then one-shots, so the pet appears fast. */
export function clipLoadOrder(character: BuddyCharacter): ReadonlyArray<BuddyAnimation> {
  const order: BuddyAnimation[] = ["idle", "thinking", "working", "waiting"];
  const rest = BUDDY_ANIMATIONS.filter((name) => !order.includes(name));
  return [...order, ...rest].filter((name) => character.clips[name] !== undefined);
}

const clipObjectUrls = new Map<string, Promise<string | null>>();

/**
 * Plays from an in-memory copy: static servers may not answer range requests,
 * and without them a looping or rewound video cannot seek back to its start.
 * Copies are kept for the session, so the overlay and settings share them.
 */
export function loadBuddyClip(url: string): Promise<string | null> {
  let objectUrl = clipObjectUrls.get(url);
  if (objectUrl === undefined) {
    objectUrl = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Buddy clip ${url} failed with ${response.status}.`);
        return response.blob();
      })
      .then((blob) => URL.createObjectURL(blob))
      .catch((error: unknown) => {
        console.error("[BUDDY] Could not load clip.", error);
        clipObjectUrls.delete(url);
        return null;
      });
    clipObjectUrls.set(url, objectUrl);
  }
  return objectUrl;
}
