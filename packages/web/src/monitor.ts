import { lex } from "@benchtop-plc/compiler";
import {
  coerceValue,
  formatValue,
  standardFunctionBlocks,
  type DataType,
  type TypedValue,
  type Variable,
  type VariableSnapshot,
} from "@benchtop-plc/core";

/** Reuse ST literal syntax without compiling user-supplied statements. */
export function parseWrittenValue(dataType: DataType, source: string): TypedValue | null {
  const text = source.trim();
  if (dataType === "BOOL")
    return /^(TRUE|FALSE)$/i.test(text) ? { dataType, value: text.toUpperCase() === "TRUE" } : null;
  let number: number;
  if (dataType === "TIME" && /^(T|TIME)#/i.test(text)) {
    const result = lex(text);
    if (!result.tokens || result.tokens.length !== 2 || result.tokens[0]?.kind !== "time")
      return null;
    number = Number(result.tokens[0].value);
  } else {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    number = Number(text);
  }
  if (
    !Number.isFinite(number) ||
    (["INT", "UINT", "DINT", "TIME"].includes(dataType) && !Number.isInteger(number))
  )
    return null;
  if (
    (dataType === "INT" && (number < -32768 || number > 32767)) ||
    (dataType === "UINT" && (number < 0 || number > 65535)) ||
    (dataType === "DINT" && (number < -2147483648 || number > 2147483647))
  )
    return null;
  try {
    return { dataType, value: coerceValue(dataType, number) } as TypedValue;
  } catch {
    return null;
  }
}
export function variableValue(variable: Variable, value: VariableSnapshot | undefined): string {
  if (!value) return "—";
  if (value.kind === "scalar") return formatValue(value.dataType, value.value);
  if (variable.kind !== "functionBlock") return "—";
  return standardFunctionBlocks[variable.fbType].outputs
    .map(([name], index) => {
      const output = value.outputs[index];
      return output ? `${name}=${formatValue(output.dataType, output.value)}` : `${name}=—`;
    })
    .join(", ");
}
