import { isCharacterType, DEFAULT_STRING_LENGTH } from "./strings.js";
import {
  validateValue,
  type DataType,
  type IntegerType,
  type ScalarValue,
  type TypedValue,
} from "./values.js";

export interface InterfaceType {
  kind: "interface";
  name: string;
  extends: string[];
}
export function interfaceType(
  type: TypeDescriptor,
  table: readonly TypeEntry[] = [],
): InterfaceType | undefined {
  const resolved = resolveType(type, table);
  return typeof resolved !== "string" && resolved.kind === "interface" ? resolved : undefined;
}
export function referenceLike(type: TypeDescriptor, table: readonly TypeEntry[] = []): boolean {
  return !!referenceType(type, table) || !!interfaceType(type, table);
}

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
/** Plain-data descriptors; named structures are defined in the type table. */
export type TypeDescriptor =
  | DataType
  | InterfaceType
  | { kind: "functionBlock"; name: string; block?: number }
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
      members: { name: string; dataType: TypeDescriptor; initialValue: InitialValue }[];
    };
export type InitialValue = TypedValue["value"] | null | InitialValue[];
export function cloneInitialValue<T>(value: T): T {
  return (Array.isArray(value) ? value.map((item) => cloneInitialValue(item)) : value) as T;
}
export type ReferenceType = Extract<TypeDescriptor, { kind: "reference" }>;
export function referenceType(
  type: TypeDescriptor,
  table: readonly TypeEntry[] = [],
): ReferenceType | undefined {
  const resolved = resolveType(type, table);
  return typeof resolved !== "string" && resolved.kind === "reference" ? resolved : undefined;
}
export type ArrayType = Extract<TypeDescriptor, { kind: "array" }>;
export function arrayType(
  type: TypeDescriptor,
  table: readonly TypeEntry[] = [],
): ArrayType | undefined {
  const resolved = resolveType(type, table);
  return typeof resolved !== "string" && resolved.kind === "array" ? resolved : undefined;
}
export type StructureType = Extract<TypeDefinition, { kind: "structure" }>;
export function structureType(
  type: TypeDescriptor,
  table: readonly TypeEntry[] = [],
): StructureType | undefined {
  const resolved = resolveType(type, table);
  return typeof resolved !== "string" && resolved.kind === "structure" ? resolved : undefined;
}
export function isAggregateType(type: TypeDescriptor, table: readonly TypeEntry[] = []): boolean {
  return !!arrayType(type, table) || !!structureType(type, table);
}
export function arraySize(type: ArrayType): number {
  return type.dimensions.reduce((size, d) => size * (d === "*" ? 0 : d.upper - d.lower + 1), 1);
}
export function leafCount(type: TypeDescriptor, table: readonly TypeEntry[] = []): number {
  const array = arrayType(type, table);
  const structure = structureType(type, table);
  return array
    ? arraySize(array) * leafCount(array.element, table)
    : structure
      ? structure.members.reduce((count, member) => count + leafCount(member.dataType, table), 0)
      : 1;
}
export function arrayIndices(type: ArrayType, offset: number): number[] {
  const result: number[] = [];
  for (const d of [...type.dimensions].reverse()) {
    if (d === "*") throw new RangeError("Open dimension");
    const size = d.upper - d.lower + 1;
    result.unshift(d.lower + (offset % size));
    offset = Math.floor(offset / size);
  }
  return result;
}
export interface TypeEntry {
  name: string;
  definition: TypeDefinition;
  initialValue: InitialValue;
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
/** Name equivalence for enumerations/structures; structural equivalence for arrays/subranges. */
export function sameScalarType(
  a: TypeDescriptor,
  b: TypeDescriptor,
  table: readonly TypeEntry[] = [],
): boolean {
  const seen = new Map<ReturnType<typeof resolveType>, Set<ReturnType<typeof resolveType>>>();
  const compare = (a: TypeDescriptor, b: TypeDescriptor): boolean => {
    const left = resolveType(a, table),
      right = resolveType(b, table);
    if (left === right) return true;
    if (seen.get(left)?.has(right)) return true;
    if (!seen.has(left)) seen.set(left, new Set());
    seen.get(left)!.add(right);
    const la = arrayType(a, table),
      ra = arrayType(b, table);
    if (la || ra)
      return (
        !!la &&
        !!ra &&
        JSON.stringify(la.dimensions) === JSON.stringify(ra.dimensions) &&
        compare(la.element, ra.element)
      );
    if (structureType(a, table) || structureType(b, table)) return left === right;
    const li = interfaceType(a, table),
      ri = interfaceType(b, table);
    if (li || ri) return !!li && !!ri && li.name.toUpperCase() === ri.name.toUpperCase();
    const lr = referenceType(a, table),
      rr = referenceType(b, table);
    if (lr || rr) return !!lr && !!rr && compare(lr.target, rr.target);
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
  };
  return compare(a, b);
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
    case "interface":
    case "functionBlock":
      return type.name;
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
