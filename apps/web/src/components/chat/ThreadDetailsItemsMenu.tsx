import { T, useMessages } from "gt-react";
import type { ReactNode } from "react";
import { useThemeLayout } from "../../hooks/useTheme";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

/** Items the chat header shows instead under the theme layout `workspaceActions: "header"`. */
const HEADER_ITEM_IDS: ReadonlySet<string> = new Set(["scripts", "changes", "gitActions"]);

/** Menu body that shows and hides thread details items. The card's context menu and Settings share it. */
export function ThreadDetailsItemsMenuItems() {
  const inHeader = useThemeLayout().workspaceActions === "header";
  return (
    <>
      {inHeader ? (
        <>
          <ItemsGroup
            label={<T>Show in thread details</T>}
            items={THREAD_DETAILS_ITEMS.filter((item) => !HEADER_ITEM_IDS.has(item.id))}
          />
          <ItemsGroup
            label={<T>Show in header</T>}
            items={THREAD_DETAILS_ITEMS.filter((item) => HEADER_ITEM_IDS.has(item.id))}
          />
        </>
      ) : (
        <ItemsGroup label={<T>Show in thread details</T>} items={THREAD_DETAILS_ITEMS} />
      )}
      <ResetItem />
    </>
  );
}

function ItemsGroup(props: {
  label: ReactNode;
  items: ReadonlyArray<(typeof THREAD_DETAILS_ITEMS)[number]>;
}) {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const m = useMessages();
  return (
    <MenuGroup>
      <MenuGroupLabel>{props.label}</MenuGroupLabel>
      {props.items.map((item) => (
        <MenuCheckboxItem
          key={item.id}
          checked={visibility[item.id]}
          onCheckedChange={(checked) =>
            updateClientSettings({
              threadDetailsItems: setThreadDetailsItem(getClientSettings(), item, checked),
            })
          }
        >
          {m(item.label)}
        </MenuCheckboxItem>
      ))}
    </MenuGroup>
  );
}

function ResetItem() {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  return (
    <>
      <MenuSeparator />
      <MenuItem
        disabled={isDefaultThreadDetailsVisibility(visibility)}
        onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
      >
        <T>Reset to default</T>
      </MenuItem>
    </>
  );
}
