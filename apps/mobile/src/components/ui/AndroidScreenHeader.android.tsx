import { AppActivityIndicator } from "./AppActivityIndicator";
import { Column, Text as NativeText, RNHostView } from "@expo/ui/jetpack-compose";
import { use, useState, type ReactNode } from "react";
import { View } from "react-native";

import type { AppSymbolName } from "./AppSymbol";
import { NativeAppBar } from "./NativeAppBar.android";
import { IconButton } from "./IconButton";
import type { IconButtonProps } from "./IconButton.types";
import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { FloatingHeaderButtonBackdrop } from "./FloatingHeaderButtonBackdrop";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu.android";
import { splitAndroidHeaderActions } from "./headerMenu.android";
import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";
import { useToolbarLayout } from "./useToolbarLayout";
import { useControlTheme } from "./useControlTheme";
import { RoutedFormSheetContext } from "./RoutedFormSheetContext";

export interface AndroidHeaderAction {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly selected?: boolean;
  readonly subtitle?: string;
  readonly destructive?: boolean;
  readonly overflowOnly?: boolean;
}

export function AndroidHeaderIconButton(props: IconButtonProps & { readonly floating?: boolean }) {
  const {
    floating = true,
    tintColorClassName = "accent-header-foreground",
    ...buttonProps
  } = props;
  const button = <IconButton {...buttonProps} tintColorClassName={tintColorClassName} />;
  return floating ? (
    <View className="overflow-hidden rounded-full">
      <FloatingHeaderButtonBackdrop />
      {button}
    </View>
  ) : (
    button
  );
}

export function AndroidScreenHeader(props: {
  readonly title: string;
  readonly titleContent?: ReactNode;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AndroidHeaderAction>;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onBack?: () => void;
  readonly embedded?: boolean;
  readonly hideBottomBorder?: boolean;
  /** Defaults to borderless chrome with the thread screen's circular controls. */
  readonly floating?: boolean;
}) {
  const { colors } = useControlTheme();
  const titleRole = useScaledTextRole("title");
  const floating = props.floating ?? true;
  const titleTypography = floating ? { ...titleRole, fontWeight: "600" as const } : titleRole;
  const subtitleTypography = useScaledTextRole("label");
  const { buttonSize } = useAndroidControlSizing();
  const inFormSheet = use(RoutedFormSheetContext);
  const { paddingTop, paddingBottom } = useToolbarLayout(props.embedded || inFormSheet);
  const [headerWidth, setHeaderWidth] = useState(0);
  const { visibleActions, overflowActions } = splitAndroidHeaderActions(
    props.actions ?? [],
    headerWidth >= 600,
  );

  return (
    <View
      onLayout={(event) => setHeaderWidth(event.nativeEvent.layout.width)}
      className={floating ? undefined : "border-b border-header-border bg-header"}
      style={{
        paddingTop,
        paddingBottom,
        borderBottomWidth: props.hideBottomBorder ? 0 : undefined,
      }}
    >
      {inFormSheet ? (
        <View
          pointerEvents="none"
          className="absolute top-1 h-1 w-8 self-center rounded-full bg-header-foreground/40"
        />
      ) : null}
      <NativeAppBar
        containerColor={floating ? "transparent" : undefined}
        navigationIcon={
          props.onBack || props.leading ? (
            <View collapsable={false} className="flex-row items-center gap-2">
              {props.onBack ? (
                <AndroidHeaderIconButton
                  accessibilityLabel="Navigate up"
                  icon="arrow.left"
                  floating={floating}
                  onPress={props.onBack}
                />
              ) : null}

              {props.leading}
            </View>
          ) : undefined
        }
        title={
          props.titleContent ? (
            <RNHostView matchContents={{ vertical: true }}>
              <View collapsable={false}>{props.titleContent}</View>
            </RNHostView>
          ) : !props.subtitle ? (
            <NativeText
              color={colors["--color-header-foreground"]}
              maxLines={1}
              overflow="ellipsis"
              style={titleTypography}
            >
              {props.title}
            </NativeText>
          ) : (
            <Column>
              <NativeText
                color={colors["--color-header-foreground"]}
                maxLines={1}
                overflow="ellipsis"
                style={titleTypography}
              >
                {props.title}
              </NativeText>
              {props.subtitle ? (
                <NativeText
                  color={colors["--color-foreground-muted"]}
                  maxLines={1}
                  overflow="ellipsis"
                  style={subtitleTypography}
                >
                  {props.subtitle}
                </NativeText>
              ) : null}
            </Column>
          )
        }
        actions={
          visibleActions.length > 0 || overflowActions.length > 0 || props.trailing ? (
            <View collapsable={false} className="flex-row items-center gap-2">
              {visibleActions.map((action) =>
                action.loading ? (
                  <View
                    key={action.accessibilityLabel}
                    accessibilityLabel={action.accessibilityLabel}
                    className="items-center justify-center"
                    style={{ width: buttonSize, height: buttonSize }}
                  >
                    {floating ? <FloatingHeaderButtonBackdrop /> : null}
                    <AppActivityIndicator colorClassName="accent-header-foreground" />
                  </View>
                ) : (
                  <AndroidHeaderIconButton
                    key={action.accessibilityLabel}
                    accessibilityLabel={action.accessibilityLabel}
                    disabled={action.disabled}
                    selected={action.selected}
                    icon={action.icon}
                    floating={floating}
                    onPress={action.onPress}
                  />
                ),
              )}
              {overflowActions.length > 0 ? (
                <AndroidAnchoredMenu
                  actions={overflowActions.map((action, index) => ({
                    id: String(index),
                    title: action.accessibilityLabel,
                    subtitle: action.subtitle,
                    state: action.selected ? "on" : undefined,
                    attributes: {
                      disabled: Boolean(action.disabled),
                      destructive: action.destructive,
                    },
                  }))}
                  onPressAction={({ nativeEvent }) =>
                    overflowActions[Number(nativeEvent.event)]?.onPress()
                  }
                >
                  {(open) => (
                    <AndroidHeaderIconButton
                      accessibilityLabel="More actions"
                      icon="ellipsis"
                      floating={floating}
                      onPress={open}
                    />
                  )}
                </AndroidAnchoredMenu>
              ) : null}
              {props.trailing}
            </View>
          ) : undefined
        }
      />
    </View>
  );
}
