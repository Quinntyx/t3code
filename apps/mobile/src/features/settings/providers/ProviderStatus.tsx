import {
  getProviderStatusKey,
  getProviderSummary,
  type ProviderStatusKey,
} from "@t3tools/client-runtime/provider-settings/status";
import {
  providerInstanceName,
  readConfigString,
} from "@t3tools/client-runtime/provider-settings/instance";
import {
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceInitials,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { View } from "react-native";

import { ProviderIcon } from "../../../components/ProviderIcon";
import { AppText as Text } from "../../../components/ui/AppText";

const STATUS_DOT_CLASS: Record<ProviderStatusKey, string> = {
  disabled: "bg-foreground-tertiary",
  error: "bg-danger",
  neutral: "bg-foreground-muted",
  ready: "bg-emerald-500",
  warning: "bg-warning",
};

export function ProviderStatusDot(props: { readonly status: ProviderStatusKey }) {
  return <View className={`size-2 rounded-full ${STATUS_DOT_CLASS[props.status]}`} />;
}

export function isProviderUpdating(provider: ServerProvider | undefined) {
  return provider?.updateState?.status === "queued" || provider?.updateState?.status === "running";
}

/** One status the list and the detail header agree on, from settings plus the live probe. */
export function describeProviderInstance(
  instance: ProviderInstanceConfig,
  provider: ServerProvider | undefined,
) {
  const enabled = resolveProviderInstanceEnabled(instance);
  const effective = provider && { ...provider, enabled };
  const statusKey = enabled ? getProviderStatusKey(effective) : "disabled";
  const summary = enabled ? getProviderSummary(effective) : { headline: "Off", detail: null };
  const updating = isProviderUpdating(provider);
  return {
    enabled,
    statusKey,
    headline: updating ? "Updating" : summary.headline,
    detail: summary.detail,
    needsAttention: statusKey === "warning" || statusKey === "error",
  };
}

/** The provider mark on a tile, with the accent initials badge the composer picker shows. */
export function ProviderInstanceGlyph(props: {
  readonly instance: ProviderInstanceConfig;
  readonly size?: number;
}) {
  const size = props.size ?? 22;
  const local = readConfigString(props.instance.config, "source") === "local";
  const accentColor = normalizeProviderAccentColor(props.instance.accentColor);
  return (
    <View
      className="items-center justify-center rounded-xl bg-subtle"
      style={{ width: size + 14, height: size + 14 }}
    >
      <ProviderIcon
        provider={props.instance.driver}
        iconUrl={local ? undefined : readConfigString(props.instance.config, "registryIconUrl")}
        size={size}
      />
      {accentColor ? (
        <View
          pointerEvents="none"
          className="absolute -right-1 -bottom-1 h-4 min-w-4 items-center justify-center rounded-full border-2 border-grouped-card px-0.5"
          style={{ backgroundColor: accentColor }}
        >
          <Text
            style={{
              fontSize: 8,
              fontWeight: "700",
              lineHeight: 10,
              color: providerAccentForegroundColor(accentColor),
            }}
          >
            {providerInstanceInitials(providerInstanceName(props.instance))}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
