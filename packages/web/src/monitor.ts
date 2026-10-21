import { compile, lex } from "@benchtop-plc/compiler";
import {
  coerceValue,
  isBitType,
  isLongType,
  validateValue,
  formatValue,
  standardFunctionBlocks,
  type DataType,
  type TypedValue,
  type Variable,
  type VariableSnapshot,
} from "@benchtop-plc/core";

/** Decimal input for integer storage must be exact even at a range boundary.
 * Work on digits so a tiny fraction cannot round back into range as binary64. */
function decimalInteger(text: string): number | null {
  const [mantissa = "", exponent = "0"] = text.toLowerCase().split("e");
  const fractionLength = mantissa.split(".")[1]?.length ?? 0;
  const scale = Number(exponent) - fractionLength;
  if (!Number.isSafeInteger(scale)) return null;
  let digits = mantissa.replace(/^[+-]/, "").replace(".", "").replace(/^0+/, "");
  if (!digits) return text.startsWith("-") ? null : 0;
  if (scale < 0) {
    const count = -scale;
    if (count >= digits.length || !/^0*$/.test(digits.slice(-count))) return null;
    digits = digits.slice(0, -count);
  } else {
    // All supported integer storage types fit in ten decimal digits.
    if (digits.length + scale > 10) return null;
    digits += "0".repeat(scale);
  }
  return Number(`${text.startsWith("-") ? "-" : ""}${digits}`);
}

/** Reuse ST literal syntax without compiling user-supplied statements. */
export function parseWrittenValue(dataType: DataType, source: string): TypedValue | null {
  const text = source.trim();
  if (dataType === "BOOL")
    return /^(TRUE|FALSE)$/i.test(text) ? { dataType, value: text.toUpperCase() === "TRUE" } : null;
  if (isLongType(dataType)) {
    let literal = text;
    if (dataType === "LTIME" && /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(text))
      literal = `LTIME#${text}ns`;
    const result = lex(literal);
    if (!result.tokens) return null;
    // A signed plain number is two tokens; reject statements before compiling the slot.
    const tokens = result.tokens.filter((token) => token.kind !== "eof");
    if (tokens.length !== 1 && !(tokens.length === 2 && /^[+-]$/.test(tokens[0]!.text)))
      return null;
    if (
      !tokens.every(
        (token) => ["integer", "time"].includes(token.kind) || /^[+-]$/.test(token.text),
      )
    )
      return null;
    const declaration = compile(
      `PROGRAM Written VAR value : ${dataType} := ${literal}; END_VAR END_PROGRAM`,
    ).ir?.variables[0];
    if (declaration?.kind !== "scalar" || declaration.dataType !== dataType) return null;
    return { dataType, value: declaration.initialValue } as TypedValue;
  }
  let number: number;
  if (dataType === "TIME" && /^(T|TIME)#/i.test(text)) {
    const result = lex(text);
    if (!result.tokens || result.tokens.length !== 2 || result.tokens[0]?.kind !== "time")
      return null;
    number = Number(result.tokens[0].value);
    if (!Number.isFinite(number) || !Number.isInteger(number)) return null;
    // Check the exact literal text too: binary64 can round an out-of-range decimal
    // back to the boundary. The single-token guard above excludes statements.
    const declaration = compile(`PROGRAM Written VAR value : TIME := ${text}; END_VAR END_PROGRAM`)
      .ir?.variables[0];
    if (declaration?.kind !== "scalar" || declaration.dataType !== "TIME") return null;
    number = declaration.initialValue;
  } else {
    if (isBitType(dataType) && /^(?:2#[01]+(?:_[01]+)*|16#[0-9a-f]+(?:_[0-9a-f]+)*)$/i.test(text)) {
      number = Number(
        BigInt(text.toLowerCase().replaceAll("_", "").replace(/^2#/, "0b").replace(/^16#/, "0x")),
      );
    } else {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
      const parsed =
        dataType === "REAL" || dataType === "LREAL" ? Number(text) : decimalInteger(text);
      if (parsed === null) return null;
      number = parsed;
    }
  }
  try {
    // REAL text is rounded once to its storage precision; integer inputs must fit exactly.
    const value = dataType === "REAL" ? coerceValue("REAL", number) : number;
    validateValue(dataType, value);
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
