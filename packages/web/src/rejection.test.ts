import type { CommandRejectionMessage } from "@benchtop-plc/core";
import { describe, expect, it } from "vitest";
import { en, ja } from "./catalog.js";
import { rejectionText } from "./rejection.js";

describe("command rejection messages", () => {
  const cases: [CommandRejectionMessage["diagnostic"], string, string][] = [
    [
      { code: "runtime.debug-target", severity: "error", args: {} },
      en.rejectedTarget,
      ja.rejectedTarget,
    ],
    [
      { code: "runtime.debug-value", severity: "error", args: {} },
      en.rejectedValue,
      ja.rejectedValue,
    ],
    [
      { code: "runtime.debug-type-mismatch", severity: "error", args: { from: "BOOL", to: "INT" } },
      "Command rejected: cannot write a value of type BOOL to a variable of type INT.",
      "操作を拒否しました。INT型の変数にBOOL型の値は書き込めません。",
    ],
    [
      { code: "runtime.write-input-mapped", severity: "error", args: { name: "input" } },
      "Command rejected: cannot write input-mapped variable input. Use force instead.",
      "操作を拒否しました。入力変数inputには書き込めません。強制設定を使用してください。",
    ],
  ];
  it.each(cases)("localizes $code with diagnostic arguments", (diagnostic, english, japanese) => {
    const rejection: CommandRejectionMessage = { type: "rejected", command: "write", diagnostic };
    expect(rejectionText(rejection, en)).toBe(english);
    expect(rejectionText(rejection, ja)).toBe(japanese);
  });
});
