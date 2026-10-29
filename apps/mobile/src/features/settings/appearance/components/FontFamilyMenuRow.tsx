import { SymbolView } from "../../../../components/ui/AppSymbol";
import { ListRowLayout } from "../../../../components/ui/ListRowLayout";
import { Menu } from "../../../../components/ui/Menu";
import { RowPressable } from "../../../../components/ui/RowPressable";
import type { FontChoice } from "../../../../lib/fontFamilies";

const DEFAULT_ACTION_ID = "default";

export function FontFamilyMenuRow(props: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly defaultLabel: string;
  readonly choices: ReadonlyArray<FontChoice<unknown>>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}) {
  const value =
    props.choices.find((choice) => choice.id === props.selectedId)?.label ?? props.defaultLabel;

  return (
    <Menu
      title={props.label}
      actions={[
        {
          id: DEFAULT_ACTION_ID,
          title: props.defaultLabel,
          subtitle: props.defaultLabel === "Default" ? undefined : "Default",
          state: props.selectedId === null ? "on" : "off",
        },
        ...props.choices.map((choice) => ({
          id: choice.id,
          title: choice.label,
          state: choice.id === props.selectedId ? ("on" as const) : ("off" as const),
        })),
      ]}
      onPressAction={({ nativeEvent }) =>
        props.onSelect(nativeEvent.event === DEFAULT_ACTION_ID ? null : nativeEvent.event)
      }
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${value}`}
        accessibilityState={{ disabled: Boolean(props.disabled) }}
        disabled={props.disabled}
      >
        <ListRowLayout
          icon="textformat"
          label={props.label}
          detail={value}
          disabled={props.disabled}
          accessory={
            <SymbolView
              name="chevron.down"
              size={14}
              tintColorClassName="accent-chevron"
              type="monochrome"
            />
          }
        />
      </RowPressable>
    </Menu>
  );
}
