import { GUEST_PENDING_EDGE_CLASS_NAME } from "./guestMessageStyle";

/** A message the agent has not received yet: unfilled, with a dashed edge, like a pending guest message. */
export function unsentMessageBubbleClassName(tone: "default" | "guest" = "default"): string {
  return tone === "guest"
    ? GUEST_PENDING_EDGE_CLASS_NAME
    : "border border-dashed border-foreground-muted/40 bg-transparent";
}

/** The dashed edge is the only sighted cue, so the state is spoken as well. */
export const UNSENT_MESSAGE_ANNOUNCEMENT = "Waiting for the agent to receive this message";
