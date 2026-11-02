import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type ContainerProps = {
  readonly children?: ReactNode;
  readonly style?: { readonly maxHeight?: number };
};

const mocks = vi.hoisted(() => ({ copy: vi.fn(async () => true) }));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  StyleSheet: { absoluteFill: {} },
  useWindowDimensions: () => ({ height: 900, fontScale: 1 }),
  View: ({ children }: ContainerProps) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: ContainerProps & {
    readonly onPress: () => void;
    readonly accessibilityLabel: string;
    readonly accessibilityState: { readonly expanded: boolean };
  }) => (
    <button
      aria-label={accessibilityLabel}
      aria-expanded={accessibilityState.expanded}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  ScrollView: ({ children }: ContainerProps) => <div data-scrollable>{children}</div>,
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: ({ children }: ContainerProps) => <div>{children}</div>,
  usePanGesture: vi.fn(),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: ContainerProps) => <div>{children}</div> },
  FadeOut: { duration: () => ({ reduceMotion: () => ({}) }) },
  ReduceMotion: { System: "system" },
  Easing: { out: vi.fn(), cubic: vi.fn() },
}));
vi.mock("./AppText", () => ({
  AppText: ({ children, numberOfLines }: ContainerProps & { readonly numberOfLines?: number }) => (
    <span data-lines={numberOfLines}>{children}</span>
  ),
}));
vi.mock("./GlassSurface", () => ({
  GlassSurface: ({ children, style }: ContainerProps) => (
    <div data-surface style={style}>
      {children}
    </div>
  ),
}));
vi.mock("./useControlTheme", () => ({ useControlTheme: () => ({ colorScheme: "light" }) }));
vi.mock("./IconButton", () => ({
  IconButton: ({
    accessibilityLabel,
    onPress,
  }: {
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  }) => <button aria-label={accessibilityLabel} onClick={onPress} />,
}));
vi.mock("./Button", () => ({ Button: () => null }));
vi.mock("./AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("./AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: mocks.copy }));

import { Toast } from "./Toast";

it("expands errors into a height-capped scroll area, copies all details, and resets for a new error", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const onExpand = vi.fn();
  const description = `fatal: push rejected\n${"remote: detailed diagnostic\n".repeat(100)}`;
  act(() =>
    root.render(
      <Toast
        singleLine
        tone="danger"
        message="Git action failed"
        description={description}
        onExpand={onExpand}
      />,
    ),
  );
  expect(container.querySelector("[data-lines='1']")).not.toBeNull();
  expect(container.querySelector("[data-scrollable]")).toBeNull();

  const expand = container.querySelector<HTMLButtonElement>("button[aria-expanded='false']");
  expect(expand).not.toBeNull();
  act(() => expand!.click());
  expect(onExpand).toHaveBeenCalledOnce();
  expect(container.querySelector<HTMLElement>("[data-surface]")?.style.maxHeight).toBe("300px");
  expect(container.querySelector("[data-scrollable]")?.textContent).toBe(
    `Git action failed\n\n${description}`,
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button[aria-label='Copy error']")!.click(),
  );
  expect(mocks.copy).toHaveBeenCalledWith(`Git action failed\n\n${description}`);
  expect(container.querySelector("button[aria-label='Copied']")).not.toBeNull();

  act(() => container.querySelector<HTMLButtonElement>("button[aria-expanded='true']")!.click());
  expect(container.querySelector("[data-scrollable]")).toBeNull();
  act(() => container.querySelector<HTMLButtonElement>("button[aria-expanded='false']")!.click());
  act(() =>
    root.render(
      <Toast
        singleLine
        tone="danger"
        message="Git action failed"
        description="A different error"
        onExpand={onExpand}
      />,
    ),
  );
  expect(container.querySelector("[data-scrollable]")).toBeNull();

  act(() => root.render(<Toast singleLine tone="success" message="Pushed" />));
  expect(container.querySelector("button[aria-expanded]")).toBeNull();
});
