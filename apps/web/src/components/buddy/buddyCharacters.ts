import type { Buddy } from "@t3tools/contracts/settings";
import type { CSSProperties } from "react";

import angryUrl from "~/assets/buddy/whale-chan/angry.webm";
import errorUrl from "~/assets/buddy/whale-chan/error.webm";
import idleUrl from "~/assets/buddy/whale-chan/idle.webm";
import successUrl from "~/assets/buddy/whale-chan/success.webm";
import thinkingUrl from "~/assets/buddy/whale-chan/thinking.webm";
import waitingUrl from "~/assets/buddy/whale-chan/waiting.webm";
import workingUrl from "~/assets/buddy/whale-chan/working.webm";

import type { BuddyAnimation } from "./buddy.logic";

export type BuddyCharacterId = Exclude<Buddy, "none">;

export interface BuddyCharacter {
  readonly label: string;
  readonly description: string;
  readonly clips: Readonly<Record<BuddyAnimation, string>>;
  /** Positions a clip so that only the character's rectangle shows. */
  readonly clipStyle: CSSProperties;
  readonly aspectRatio: number;
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

export const BUDDY_CHARACTERS: Readonly<Record<BuddyCharacterId, BuddyCharacter>> = {
  "whale-chan": {
    label: "Whale-chan",
    description: "DeepSeek",
    clips: {
      idle: idleUrl,
      thinking: thinkingUrl,
      working: workingUrl,
      waiting: waitingUrl,
      success: successUrl,
      error: errorUrl,
      angry: angryUrl,
    },
    clipStyle: cropStyle({ width: 640, height: 360 }, { x: 155, y: 6, width: 313, height: 331 }),
    aspectRatio: 313 / 331,
  },
};

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
