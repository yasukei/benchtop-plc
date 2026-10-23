import { isCharacterType, DEFAULT_STRING_LENGTH } from "./strings.js";
import {
  validateValue,
  type DataType,
  type IntegerType,
  type ScalarValue,
  type TypedValue,
} from "./values.js";

export interface NamedType {
  kind: "named";
  name: string;
}
export interface SubrangeType {
  kind: "subrange";
  base: IntegerType;
  lower: number | string;
  upper: number | string;
}
/** Plain-data descriptors; composite storage is implemented by later milestones. */
export type TypeDescriptor =
  | DataType
  | NamedType
  | SubrangeType
  | { kind: "string"; base: "STRING" | "WSTRING"; length: number }
  | { kind: "character"; base: "CHAR" | "WCHAR" }
  | {
      kind: "array";
      dimensions: ({ lower: number; upper: number } | "*")[];
      element: TypeDescriptor;
    }
  | { kind: "reference"; target: TypeDescriptor };
export interface EnumerationType {
  kind: "enumeration";
  base: IntegerType;
  values: { name: string; value: number | string }[];
}
export type TypeDefinition =
  | EnumerationType
  | SubrangeType
  | { kind: "alias"; type: TypeDescriptor }
  | {
      kind: "structure";
      members: { name: string; dataType: TypeDescriptor; initialValue: unknown }[];
    };
export interface TypeEntry {
  name: string;
  definition: TypeDefinition;
  initialValue: TypedValue["value"];
}
export type TypeTable = TypeEntry[];

export function typeEntry(type: NamedType, table: readonly TypeEntry[]): TypeEntry {
  const entry = table.find((entry) => entry.name.toUpperCase() === type.name.toUpperCase());
  if (!entry) throw new RangeError("Unknown data type");
  return entry;
}
/** Unwrap aliases and named definitions, rejecting malformed cyclic tables. */
export function resolveType(
  type: TypeDescriptor,
  table: readonly TypeEntry[] = [],
):
  | Exclude<TypeDescriptor, NamedType>
  | EnumerationType
  | Extract<TypeDefinition, { kind: "structure" }> {
  const seen = new Set<string>();
  while (typeof type !== "string" && type.kind === "named") {
    const key = type.name.toUpperCase();
    if (seen.has(key)) throw new RangeError("Cyclic data type");
    seen.add(key);
    const definition = typeEntry(type, table).definition;
    if (definition.kind !== "alias") return definition;
    type = definition.type;
  }
  return type;
}
export function scalarBase(type: TypeDescriptor, table: readonly TypeEntry[] = []): DataType {
  const resolved = resolveType(type, table);
  if (typeof resolved === "string") return resolved;
  if (
    resolved.kind === "enumeration" ||
    resolved.kind === "subrange" ||
    resolved.kind === "string" ||
    resolved.kind === "character"
  )
    return resolved.base;
  throw new RangeError("Expected a supported scalar type");
}
export function enumerationType(
  type: TypeDescriptor,
  table: readonly TypeEntry[] = [],
): EnumerationType | undefined {
  const resolved = resolveType(type, table);
  return typeof resolved !== "string" && resolved.kind === "enumeration" ? resolved : undefined;
}
export function subrangeType(
  type: TypeDescriptor,
  table: readonly TypeEntry[] = [],
): SubrangeType | undefined {
  const resolved = resolveType(type, table);
  return typeof resolved !== "string" && resolved.kind === "subrange" ? resolved : undefined;
}
/** Name equivalence for enumerations; structural equivalence for subranges. */
export function sameScalarType(
  a: TypeDescriptor,
  b: TypeDescriptor,
  table: readonly TypeEntry[] = [],
): boolean {
  const left = resolveType(a, table),
    right = resolveType(b, table);
  const leftBase = scalarBase(a, table),
    rightBase = scalarBase(b, table);
  if (isCharacterType(leftBase) || isCharacterType(rightBase)) return leftBase === rightBase;
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (left.kind === "enumeration" || right.kind === "enumeration") return left === right;
  return (
    left.kind === "subrange" &&
    right.kind === "subrange" &&
    left.base === right.base &&
    BigInt(left.lower) === BigInt(right.lower) &&
    BigInt(left.upper) === BigInt(right.upper)
  );
}
/** Validate storage constraints before coercion, including monitor writes and forces. */
export function validateDeclaredValue(
  type: TypeDescriptor,
  value: ScalarValue,
  table: readonly TypeEntry[] = [],
): void {
  const resolved = resolveType(type, table);
  const base = scalarBase(type, table);
  if (base === "STRING" || base === "WSTRING") {
    const length =
      typeof resolved !== "string" && resolved.kind === "string"
        ? resolved.length
        : DEFAULT_STRING_LENGTH;
    if (typeof value !== "string" || value.length > length)
      throw new RangeError("String exceeds capacity");
  }
  if (typeof resolved === "string") return;
  if (resolved.kind === "subrange") {
    const integer = BigInt(value);
    if (integer < BigInt(resolved.lower) || integer > BigInt(resolved.upper))
      throw new SubrangeViolation(value, resolved);
  } else if (
    resolved.kind === "enumeration" &&
    !resolved.values.some((item) => BigInt(item.value) === BigInt(value))
  ) {
    throw new RangeError("Undeclared enumeration value");
  }
}
export class SubrangeViolation extends RangeError {
  constructor(
    readonly value: ScalarValue,
    readonly range: SubrangeType,
  ) {
    super("Subrange violation");
  }
}
export function validateScalar(
  type: TypeDescriptor,
  value: TypedValue["value"],
  table: readonly TypeEntry[] = [],
): void {
  validateValue(scalarBase(type, table), value);
  validateDeclaredValue(type, value, table);
}
export function formatType(type: TypeDescriptor): string {
  if (typeof type === "string") return type;
  switch (type.kind) {
    case "named":
      return type.name;
    case "subrange":
      return `${type.base} (${type.lower}..${type.upper})`;
    case "string":
      return `${type.base}[${type.length}]`;
    case "character":
      return type.base;
    case "reference":
      return `REF_TO ${formatType(type.target)}`;
    case "array":
      return `ARRAY[${type.dimensions.map((dimension) => (dimension === "*" ? "*" : `${dimension.lower}..${dimension.upper}`)).join(", ")}] OF ${formatType(type.element)}`;
  }
}

/** Runtime stores truncate text; external values use validateScalar instead. */
export function truncateString(
  type: TypeDescriptor,
  value: ScalarValue,
  table: readonly TypeEntry[] = [],
): ScalarValue {
  const resolved = resolveType(type, table);
  const base = scalarBase(type, table);
  return (base === "STRING" || base === "WSTRING") && typeof value === "string"
    ? value.slice(
        0,
        typeof resolved !== "string" && resolved.kind === "string"
          ? resolved.length
          : DEFAULT_STRING_LENGTH,
      )
    : value;
}
