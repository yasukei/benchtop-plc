import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { expect, it } from "vitest";

it("rejects hard-coded JSX text, expressions and accessible labels", async () => {
  // JSX message restrictions are syntax-only; virtual probes need no TypeScript project.
  const eslint = new ESLint({ overrideConfig: tseslint.configs.disableTypeChecked });
  for (const source of [
    "const view = <button>Save</button>;",
    'const view = <button>{"Save"}</button>;',
    'const view = <input aria-label="Name" />;',
    'const view = <button>{active ? "Save" : text.cancel}</button>;',
    "const view = <p>{`Hello ${name}`}</p>;",
  ]) {
    const [result] = await eslint.lintText(source, { filePath: "packages/web/src/GuardProbe.tsx" });
    expect(result?.messages.some((message) => message.ruleId === "no-restricted-syntax")).toBe(
      true,
    );
  }
  const [result] = await eslint.lintText(
    'export const view = <button className={active ? "action" : "idle"} role={active ? "alert" : "status"} aria-label={text.save}>{text.save}{" "}</button>;',
    { filePath: "packages/web/src/GuardProbe.tsx" },
  );
  expect(result?.messages).toEqual([]);
});
