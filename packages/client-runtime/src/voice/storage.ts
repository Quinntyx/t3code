import type { VoiceSeenStore } from "./notifications.ts";
import { DEFAULT_VOICE_LIVE_MODEL } from "./session.ts";

export interface VoiceKeyValueStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

/** The device's Live model and the notifications it already delivered; the key lives elsewhere. */
export function createVoicePreferences(storage: VoiceKeyValueStorage) {
  const readSeen = (): string[] => {
    try {
      const value: unknown = JSON.parse(storage.getItem("t3.voice.seen") ?? "[]");
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  };
  const seen: VoiceSeenStore = {
    has: (id) => readSeen().includes(id),
    mark(ids) {
      storage.setItem(
        "t3.voice.seen",
        JSON.stringify([...new Set([...readSeen(), ...ids])].slice(-4096)),
      );
    },
  };
  const model = {
    read: () => storage.getItem("t3.voice.model")?.trim() || DEFAULT_VOICE_LIVE_MODEL,
    write(value: string) {
      if (value.trim()) storage.setItem("t3.voice.model", value.trim());
      else storage.removeItem("t3.voice.model");
    },
  };
  return { seen, model };
}
