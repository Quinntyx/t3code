import type { ThreadListDrawerContextValue } from "../../threads/thread-list-drawer";

/** iOS keeps its phone stack; only Android opens the thread list as a drawer. */
export function ThreadListDrawerPanel(_props: {
  readonly drawer: ThreadListDrawerContextValue;
  readonly width: number;
}) {
  return null;
}
