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

const dateCallee =
  ":matches([callee.name=Date], [callee.property.name=Date], " +
  "[callee.computed=true][callee.property.value=Date])";
const tickerMessage = "Use the injected Ticker instead of host timers (ADR 0003).";

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
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          // The service discovers tsconfig.json, not this standalone tools config.
          allowDefaultProject: ["packages/web/vite.config.ts"],
          defaultProject: "packages/web/tsconfig.tools.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["*.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["packages/{core,compiler,runtime,project}/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "setTimeout", message: tickerMessage },
        { name: "setInterval", message: tickerMessage },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression:matches([object.name=/^(Date|performance)$/], " +
            "[object.property.name=/^(Date|performance)$/], " +
            "[object.computed=true][object.property.value=/^(Date|performance)$/])" +
            ":matches([property.name=now], [computed=true][property.value=now])",
          message: "Use the injected Clock instead of reading the host clock (ADR 0003).",
        },
        {
          selector: `NewExpression${dateCallee}[arguments.length=0]`,
          message: "Use the injected Clock; only construct Date with a given instant (ADR 0003).",
        },
        {
          // Date called without new reads the host clock even when given arguments.
          selector: `CallExpression${dateCallee}`,
          message: "Use the injected Clock instead of calling Date as a function (ADR 0003).",
        },
        {
          selector:
            "MemberExpression[property.name=/^(setTimeout|setInterval)$/], " +
            "MemberExpression[computed=true][property.value=/^(setTimeout|setInterval)$/]",
          message: tickerMessage,
        },
      ],
    },
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
