import type { CommandRejectionMessage } from "@benchtop-plc/core";
import { describe, expect, it } from "vitest";
import { formatDiagnostic } from "./diagnostic-catalog.js";

describe("command rejection messages", () => {
  const cases: [CommandRejectionMessage["diagnostic"], string, string][] = [
    [
      { code: "runtime.debug-target", severity: "error", args: {} },
      "Command rejected: select a scalar variable from the loaded program.",
      "操作を拒否しました。読み込み済みプログラムのスカラー変数を選択してください。",
    ],
    [
      { code: "runtime.debug-value", severity: "error", args: {} },
      "Command rejected: the value is invalid or out of range.",
      "操作を拒否しました。値が無効か範囲外です。",
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
    [
      { code: "runtime.write-connected-input", severity: "error", args: { name: "A.Start" } },
      "Command rejected: cannot write connected input A.Start. Use force instead.",
      "操作を拒否しました。接続された入力 A.Start には書き込めません。強制設定を使用してください。",
    ],
  ];
  it.each(cases)("localizes $code with diagnostic arguments", (diagnostic, english, japanese) => {
    const rejection: CommandRejectionMessage = { type: "rejected", command: "write", diagnostic };
    expect(formatDiagnostic("en", rejection.diagnostic)).toBe(english);
    expect(formatDiagnostic("ja", rejection.diagnostic)).toBe(japanese);
  });
});
