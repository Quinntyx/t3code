import { assert, describe } from "@effect/vitest";

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

  rule.invalid(
    "reports Linking.openURL through a react-native namespace import",
    `
    import * as RN from "react-native";

    void RN.Linking.openURL("https://example.com");
  `,
  );

  rule.invalid(
    "reports a Linking rename destructured from a react-native namespace",
    `
    import * as RN from "react-native";

    const { Linking: L } = RN;
    void L.openURL("https://example.com");
  `,
  );

  rule.invalid(
    "reports a Linking rename",
    `
    import { Linking } from "react-native";

    const L = Linking;
    void L.openURL("https://example.com");
  `,
  );

  rule.invalid(
    "reports a Linking rename taken from a react-native namespace",
    `
    import * as RN from "react-native";

    const L = RN.Linking;
    void L.openURL("https://example.com");
  `,
  );

  rule.invalid(
    "reports an aliased openURL once",
    `
    import { Linking } from "react-native";

    const open = Linking.openURL;
    void open("https://example.com");
  `,
    (output) => {
      assert.equal(output.match(/no-direct-linking-open-url/g)?.length, 1);
    },
  );

  rule.invalid(
    "reports an openURL aliased from Linking.openURL",
    `
    import { Linking } from "react-native";

    const open = Linking.openURL;
    void open("https://example.com");
  `,
  );

  rule.valid(
    "allows a react-native namespace's other members",
    `
    import * as RN from "react-native";

    void RN.Text;
  `,
  );
});
