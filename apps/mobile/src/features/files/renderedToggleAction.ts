import { msg } from "gt-react-native";

import type { AppBarAction } from "../../components/ui/AppBar.types";
import { m } from "../../i18n/messages";

/** The icon names the view a tap switches to, like the desktop file header. */
export function renderedToggleAction(input: {
  readonly rendered: boolean;
  readonly table: boolean;
  readonly onToggle: (rendered: boolean) => void;
}): AppBarAction {
  return {
    accessibilityLabel: input.rendered
      ? m(msg("Show source"))
      : input.table
        ? m(msg("Show table"))
        : m(msg("Show preview")),
    icon: input.rendered
      ? "chevron.left.forwardslash.chevron.right"
      : input.table
        ? "tablecells"
        : "eye",
    selected: input.rendered,
    onPress: () => input.onToggle(!input.rendered),
  };
}
