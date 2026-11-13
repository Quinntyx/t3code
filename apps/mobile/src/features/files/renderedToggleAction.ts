import type { AppBarAction } from "../../components/ui/AppBar.types";

/** The icon names the view a tap switches to, like the desktop file header. */
export function renderedToggleAction(input: {
  readonly rendered: boolean;
  readonly table: boolean;
  readonly onToggle: (rendered: boolean) => void;
}): AppBarAction {
  return {
    accessibilityLabel: input.rendered
      ? "Show source"
      : input.table
        ? "Show table"
        : "Show preview",
    icon: input.rendered
      ? "chevron.left.forwardslash.chevron.right"
      : input.table
        ? "tablecells"
        : "eye",
    selected: input.rendered,
    onPress: () => input.onToggle(!input.rendered),
  };
}
