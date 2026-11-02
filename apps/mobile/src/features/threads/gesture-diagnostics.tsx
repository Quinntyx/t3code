import { useEffect, useSyncExternalStore } from "react";
import { DeviceEventEmitter, Text, View } from "react-native";

// Diagnostic build only: an on-screen log of drawer and feed gesture lifecycles.
const MAX_ENTRIES = 18;
let entries: ReadonlyArray<string> = [];
let lastAt = 0;
const listeners = new Set<() => void>();

export function logGesture(message: string) {
  const now = Date.now();
  const gap = lastAt === 0 ? 0 : now - lastAt;
  lastAt = now;
  entries = [...entries.slice(1 - MAX_ENTRIES), `+${gap}ms ${message}`];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function GestureLogOverlay() {
  const log = useSyncExternalStore(subscribe, () => entries);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the patched gesture handler's native touch-grab reports
  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener("RNGHNativeGrab", (message: string) => {
      logGesture(`GRAB ${message}`);
    });
    return () => subscription.remove();
  }, []);
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 8,
        right: 8,
        top: 140,
        padding: 6,
        backgroundColor: "rgba(0,0,0,0.78)",
        zIndex: 100,
        elevation: 30,
      }}
    >
      <Text style={{ color: "#7CFC00", fontFamily: "monospace", fontSize: 10, lineHeight: 13 }}>
        {log.length === 0 ? "gesture log: touch the thread" : log.join("\n")}
      </Text>
    </View>
  );
}
