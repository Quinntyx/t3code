import { use } from "react";

import { loadBuddyClip, type BuddyCharacter } from "./buddyCharacters";

/** The character's idle loop; suspends until the clip has loaded. */
export function BuddyIdlePreview({
  character,
  height,
}: {
  character: BuddyCharacter;
  height: number;
}) {
  const src = use(loadBuddyClip(character.clips.idle));
  if (src === null) return null;
  return (
    <div
      aria-hidden
      className="relative overflow-hidden"
      style={{ height, width: Math.round(height * character.aspectRatio) }}
    >
      <video
        className="absolute max-w-none"
        style={character.clipStyle}
        src={src}
        autoPlay
        loop
        muted
        playsInline
        draggable={false}
        disablePictureInPicture
      />
    </div>
  );
}
