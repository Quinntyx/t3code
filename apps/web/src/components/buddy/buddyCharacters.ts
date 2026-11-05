import { BUDDY_ANIMATIONS, type BuddyAnimation } from "./buddy.logic";

/** The on-disk shape of a buddy folder, bundled or downloaded. */
export interface BuddyManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly author: string;
  readonly license: string;
  /** Clip width divided by height. */
  readonly aspectRatio: number;
  /** Buddy state slot to clip file name. */
  readonly clips: Readonly<Record<string, string>>;
}

export interface BuddyCharacter {
  readonly label: string;
  readonly description: string;
  readonly author: string;
  readonly license: string;
  /** Only the slots this character has art for; `resolveBuddyClip` fills the rest. */
  readonly clips: Partial<Record<BuddyAnimation, string>>;
  readonly aspectRatio: number;
}

/**
 * Every clip a character lacks falls back down this chain, which always ends at
 * `idle`. It keeps a sparse set working across all states.
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

/** Builds a character from a manifest, given how to address one of its clips. */
export function buddyCharacterFrom(
  manifest: BuddyManifest,
  clipUrl: (file: string) => string,
): BuddyCharacter {
  const clips: Partial<Record<BuddyAnimation, string>> = {};
  for (const slot of BUDDY_ANIMATIONS) {
    const file = manifest.clips[slot];
    if (file !== undefined) clips[slot] = clipUrl(file);
  }
  return {
    label: manifest.name,
    description: manifest.description || manifest.author,
    author: manifest.author,
    license: manifest.license,
    clips,
    aspectRatio: manifest.aspectRatio,
  };
}

const BUNDLED_MANIFESTS = import.meta.glob<BuddyManifest>("~/assets/buddy/*/buddy.json", {
  eager: true,
  import: "default",
});

const BUNDLED_CLIP_URLS = import.meta.glob<string>("~/assets/buddy/*/*.webm", {
  eager: true,
  query: "?url",
  import: "default",
});

function bundledCharacters(): Readonly<Record<string, BuddyCharacter>> {
  const characters: Record<string, BuddyCharacter> = {};
  for (const [manifestPath, manifest] of Object.entries(BUNDLED_MANIFESTS)) {
    const directory = manifestPath.slice(0, manifestPath.lastIndexOf("/"));
    characters[manifest.id] = buddyCharacterFrom(manifest, (file) => {
      const url = BUNDLED_CLIP_URLS[`${directory}/${file}`];
      if (url === undefined) throw new Error(`Bundled clip ${directory}/${file} is missing.`);
      return url;
    });
  }
  return characters;
}

/** Buddies drawn into the app itself; downloaded ones are resolved at runtime. */
export const BUDDY_CHARACTERS = bundledCharacters();

export const BUDDY_CHARACTER_IDS: ReadonlyArray<string> = Object.keys(BUDDY_CHARACTERS);

export const isBuddyCharacterId = (value: string): boolean =>
  Object.hasOwn(BUDDY_CHARACTERS, value);

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
