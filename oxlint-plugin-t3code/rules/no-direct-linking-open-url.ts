import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const MESSAGE =
  "Open external URLs with tryOpenExternalUrl from apps/mobile/src/lib/openExternalUrl.ts; a direct Linking.openURL rejects and leaves the failure unreported.";

const LINKING_MODULES = new Set(["react-native", "expo-linking"]);

const importedName = (specifier: ESTree.ImportSpecifier): Option.Option<string> =>
  specifier.imported.type === "Identifier"
    ? Option.some(specifier.imported.name)
    : typeof specifier.imported.value === "string"
      ? Option.some(specifier.imported.value)
      : Option.none();

const identifierName = (node: unknown): Option.Option<string> =>
  Option.flatMap(unwrapExpression(node), (expression) => {
    if (expression.type === "Identifier") return Option.some(expression.name);
    if (expression.type === "AssignmentPattern") return identifierName(expression.left);
    return Option.none();
  });

const isOpenUrlProperty = (node: unknown): boolean =>
  Option.getOrUndefined(getPropertyName(node)) === "openURL";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct Linking.openURL calls in mobile code; use tryOpenExternalUrl so a failed open is reported instead of rejecting.",
    },
  },
  create(context) {
    // Names this file bound to the Linking API or to an openURL function, however imported.
    const linkingNames = new Set<string>();
    const openUrlNames = new Set<string>();

    const namesLinking = (node: unknown): boolean => {
      const expression = unwrapExpression(node);
      return (
        Option.isSome(expression) &&
        expression.value.type === "Identifier" &&
        (expression.value.name === "Linking" || linkingNames.has(expression.value.name))
      );
    };

    const namesOpenUrl = (node: unknown): boolean => {
      const expression = unwrapExpression(node);
      return (
        Option.isSome(expression) &&
        expression.value.type === "Identifier" &&
        openUrlNames.has(expression.value.name)
      );
    };

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string" || !LINKING_MODULES.has(source)) return;
        for (const specifier of node.specifiers) {
          // expo-linking exports the Linking API itself, as its namespace and default export.
          if (specifier.type === "ImportNamespaceSpecifier") {
            if (source === "expo-linking") linkingNames.add(specifier.local.name);
            continue;
          }
          if (specifier.type === "ImportSpecifier") {
            const imported = importedName(specifier);
            if (Option.isNone(imported)) continue;
            if (imported.value === "openURL") {
              openUrlNames.add(specifier.local.name);
              context.report({ node: specifier, message: MESSAGE });
            } else if (imported.value === "Linking") {
              linkingNames.add(specifier.local.name);
            }
            continue;
          }
          if (source === "expo-linking") linkingNames.add(specifier.local.name);
        }
      },
      VariableDeclarator(node) {
        const binding = unwrapExpression(node.id);
        if (Option.isNone(binding) || binding.value.type !== "ObjectPattern") return;
        if (!namesLinking(node.init)) return;
        for (const property of binding.value.properties) {
          if (property.type !== "Property" || !isOpenUrlProperty(property.key)) continue;
          const bound = identifierName(property.value);
          if (Option.isSome(bound)) openUrlNames.add(bound.value);
          context.report({ node: property, message: MESSAGE });
        }
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee)) return;
        if (namesOpenUrl(callee.value)) {
          context.report({ node: callee.value, message: MESSAGE });
          return;
        }
        const expression = callee.value;
        if (expression.type !== "MemberExpression") return;
        if (!namesLinking(expression.object) || !isOpenUrlProperty(expression.property)) return;
        context.report({ node: expression, message: MESSAGE });
      },
    };
  },
});
