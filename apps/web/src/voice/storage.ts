import type { DesktopBridge } from "@t3tools/contracts";
import {
  DEFAULT_VOICE_LIVE_MODEL,
  type VoiceKeyStore,
} from "@t3tools/client-runtime/voice/session";
import type { VoiceSeenStore } from "@t3tools/client-runtime/voice/notifications";

type LocalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function createVoiceStorage(
  storage: LocalStorage,
  desktop?: Pick<DesktopBridge, "encryptVoiceKey" | "decryptVoiceKey">,
) {
  const readList = (key: string): string[] => {
    try {
      const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  };
  const keyName = desktop ? "t3.voice.encrypted-key" : "t3.voice.key";
  const key: VoiceKeyStore & { write: (value: string) => Promise<void> } = {
    async read() {
      const stored = storage.getItem(keyName);
      if (!stored) return null;
      return desktop ? desktop.decryptVoiceKey(stored) : stored;
    },
    async write(value) {
      if (!value.trim()) {
        storage.removeItem(keyName);
        return;
      }
      storage.setItem(
        keyName,
        desktop ? await desktop.encryptVoiceKey(value.trim()) : value.trim(),
      );
    },
  };
  const seen: VoiceSeenStore = {
    has: (id) => readList("t3.voice.seen").includes(id),
    mark(ids) {
      storage.setItem(
        "t3.voice.seen",
        JSON.stringify([...new Set([...readList("t3.voice.seen"), ...ids])].slice(-4096)),
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
  return { key, seen, model };
}
