import { compile, lex } from "@benchtop-plc/compiler";
import {
  coerceValue,
  isCharacterType,
  isWideCharacterType,
  readStringLiteral,
  scalarBase,
  enumerationType,
  validateScalar,
  type TypeDescriptor,
  type TypeTable,
  isBitType,
  isLongType,
  isCalendarType,
  validateValue,
  formatValue,
  standardFunctionBlocks,
  type DataType,
  type TypedValue,
  type Variable,
  type VariableSnapshot,
  type RuntimeSnapshot,
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
function parseElementaryWrittenValue(dataType: DataType, source: string): TypedValue | null {
  const text = source.trim();
  if (isCharacterType(dataType)) {
    try {
      const literal = readStringLiteral(text);
      if (literal.length !== text.length || literal.wide !== isWideCharacterType(dataType))
        return null;
      validateValue(dataType, literal.value);
      return { dataType, value: literal.value } as TypedValue;
    } catch {
      return null;
    }
  }
  if (dataType === "BOOL")
    return /^(TRUE|FALSE)$/i.test(text) ? { dataType, value: text.toUpperCase() === "TRUE" } : null;
  if (isLongType(dataType) || isCalendarType(dataType)) {
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
        (token) =>
          ["integer", "time", "calendar"].includes(token.kind) || /^[+-]$/.test(token.text),
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
/** Resolve an enumeration name without changing the scalar wire representation. */
export function parseWrittenValue(
  type: TypeDescriptor,
  source: string,
  types: TypeTable = [],
): TypedValue | null {
  try {
    const enumeration = enumerationType(type, types);
    if (enumeration) {
      const member = enumeration.values.find(
        (member) => member.name.toUpperCase() === source.trim().toUpperCase(),
      );
      return member ? ({ dataType: enumeration.base, value: member.value } as TypedValue) : null;
    }
    const value = parseElementaryWrittenValue(scalarBase(type, types), source);
    if (value) validateScalar(type, value.value, types);
    return value;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return null;
  }
}

export function formatMonitoredValue(
  type: TypeDescriptor,
  value: TypedValue,
  types: TypeTable = [],
): string {
  const enumeration = enumerationType(type, types);
  return (
    enumeration?.values.find((member) => BigInt(member.value) === BigInt(value.value))?.name ??
    formatValue(value.dataType, value.value)
  );
}

export function variableValue(
  variable: Variable,
  value: VariableSnapshot | undefined,
  types: TypeTable = [],
): string {
  if (!value) return "—";
  if (value.kind === "reference") return value.target ?? "NULL";
  if (value.kind === "scalar")
    return variable.kind === "scalar"
      ? formatMonitoredValue(variable.dataType, value, types)
      : formatValue(value.dataType, value.value);
  if (variable.kind !== "functionBlock") return "—";
  return standardFunctionBlocks[variable.fbType].outputs
    .map(([name], index) => {
      const output = value.outputs[index];
      return output ? `${name}=${formatValue(output.dataType, output.value)}` : `${name}=—`;
    })
    .join(", ");
}

export type MonitorRow =
  | { kind: "group"; name: string; depth: number; dataType?: TypeDescriptor; instance?: string }
  | { kind: "leaf"; id: number; depth: number };

/** Build visible rows and the watch list from the IR paths, independent of React. */
export function monitorRows(
  variables: Variable[],
  composites: { name: string; path: string[]; dataType: TypeDescriptor }[],
  expanded: ReadonlySet<string>,
  forced: readonly number[] = [],
): MonitorRow[] {
  const rows: MonitorRow[] = [];
  const emitted = new Set<string>();
  const groups = new Map<string, { name: string; path: string[]; dataType?: TypeDescriptor }>(
    composites.map((group) => [JSON.stringify(group.path), group]),
  );
  for (const variable of variables) {
    if (variable.instance)
      groups.set(JSON.stringify([variable.instance]), {
        name: variable.instance,
        path: [variable.instance],
      });
  }
  for (const [id, variable] of variables.entries()) {
    const parents = (variable.path ?? []).flatMap((_, i) => {
      const group = groups.get(JSON.stringify(variable.path!.slice(0, i)));
      return group ? [group] : [];
    });
    let visible = true;
    for (const [depth, parent] of parents.entries()) {
      if (!visible) break;
      if (!emitted.has(parent.name)) {
        rows.push({
          kind: "group",
          name: parent.name,
          depth,
          dataType: parent.dataType,
          instance: variable.instance,
        });
        emitted.add(parent.name);
      }
      visible = expanded.has(parent.name);
    }
    if (visible || forced.includes(id))
      rows.push({ kind: "leaf", id, depth: visible ? parents.length : 0 });
  }
  return rows;
}
export function watchedLeaves(rows: readonly MonitorRow[], variables: Variable[]): number[] {
  return rows.flatMap((row) => (row.kind === "leaf" && variables[row.id]?.watched ? [row.id] : []));
}

/** Index a received snapshot once so rendering many watched rows stays linear. */
export function snapshotValues(
  snapshot: RuntimeSnapshot | null | undefined,
): ReadonlyMap<number, VariableSnapshot> {
  const values = new Map<number, VariableSnapshot>();
  snapshot?.variables.forEach((value, index) => {
    const id = snapshot.variableIds ? snapshot.variableIds[index] : index;
    if (id !== undefined) values.set(id, value);
  });
  return values;
}

/** Grouped rows show paths relative to their program instance. */
export function monitorLabel(path: string, instance?: string): string {
  return instance && path.startsWith(`${instance}.`) ? path.slice(instance.length + 1) : path;
}
