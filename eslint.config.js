// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

// Only rendered content and accessible labels are messages; role/class/value attributes are structural.
const jsxMessageExpression =
  ":matches(JSXElement > JSXExpressionContainer, JSXFragment > JSXExpressionContainer, " +
  "JSXAttribute[name.name=/^(title|placeholder|alt|label|aria-label|aria-description|aria-valuetext)$/] > JSXExpressionContainer)";

export default defineConfig(
  {
    ignores: [
      "**/dist/",
      "**/coverage/",
      "**/node_modules/",
      "**/test-results/",
      "**/playwright-report/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["*.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["packages/web/src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXText[value=/\\S/]",
          message: "Use the i18n catalog for JSX text.",
        },
        {
          selector: `${jsxMessageExpression} > Literal[value=/\\S/]`,
          message: "Use the i18n catalog for JSX strings.",
        },
        {
          selector: `${jsxMessageExpression} > TemplateLiteral`,
          message: "Use a catalog template for JSX strings.",
        },
        {
          selector: `${jsxMessageExpression} :matches(ConditionalExpression, LogicalExpression) > Literal[value=/\\S/]`,
          message: "Use the i18n catalog for conditional JSX strings.",
        },
        {
          selector:
            "JSXAttribute[name.name=/^(title|placeholder|alt|label|aria-label|aria-description|aria-valuetext)$/] > Literal[value=/\\S/]",
          message: "Use the i18n catalog for user-facing JSX attributes.",
        },
      ],
    },
  },
  // Must stay last: turns off rules that conflict with Prettier.
  prettier,
);
