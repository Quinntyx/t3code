import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-direct-linking-open-url", {
  filename: "apps/mobile/src/features/settings/providers/Example.tsx",
});

describe("t3code/no-direct-linking-open-url", () => {
  rule.valid(
    "allows the guarded helper",
    `
      import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";

      void tryOpenExternalUrl("https://example.com");
    `,
  );

  rule.valid(
    "allows other Linking methods",
    `
      import { Linking } from "react-native";

      void Linking.canOpenURL("https://example.com");
    `,
  );

  rule.valid(
    "allows a namespace import's other methods",
    `
      import * as Linking from "expo-linking";

      void Linking.createURL("/");
    `,
  );

  rule.invalid(
    "reports Linking.openURL calls",
    `
      import { Linking } from "react-native";

      void Linking.openURL("https://example.com");
    `,
  );

  rule.invalid(
    "reports openURL destructured from react-native",
    `import { openURL } from "react-native";`,
  );

  rule.invalid(
    "reports the namespace's openURL",
    `
    import * as L from "expo-linking";

    void L.openURL("https://example.com");
  `,
  );

  rule.invalid(
    "reports a renamed Linking import",
    `
    import { Linking as RnLinking } from "react-native";

    void RnLinking.openURL("https://example.com");
  `,
  );

  rule.invalid(
    "reports an openURL destructured from Linking",
    `
    import { Linking } from "react-native";

    const { openURL } = Linking;
    void openURL("https://example.com");
  `,
  );

  rule.invalid(
    "reports a renamed openURL destructured from Linking",
    `
    import * as Linking from "expo-linking";

    const { openURL: open } = Linking;
    void open("https://example.com");
  `,
  );
});
