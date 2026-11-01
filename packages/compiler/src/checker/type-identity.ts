import type { DataType, TypeDescriptor } from "@benchtop-plc/core";
import {
  arrayType,
  enumerationType,
  isAggregateType,
  referenceLike,
  referenceType,
  resolveType,
  sameScalarType,
  scalarBase,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import type { ExpressionInfo } from "../checked.js";
import { scalarTypes } from "../type-rules.js";

import type { CheckerContext } from "./context.js";

export const declarationType = (name: string): string =>
  (
    ({
      TIME_OF_DAY: "TOD",
      DATE_AND_TIME: "DT",
      LTIME_OF_DAY: "LTOD",
      LDATE_AND_TIME: "LDT",
    }) as Record<string, string>
  )[name] ?? name;
export const isScalar = (name: string): name is DataType =>
  scalarTypes.some((type) => type === name);

export function hasOpenDimensions(node?: AST.ArrayDeclaration): boolean {
  return !!node && (node.dimensions.includes("*") || hasOpenDimensions(node.array));
}

export function baseType(ctx: CheckerContext, type: TypeDescriptor, table = ctx.types): DataType {
  return isAggregateType(type, table) ||
    referenceLike(type, table) ||
    (typeof type !== "string" && type.kind === "functionBlock")
    ? "INT"
    : scalarBase(type, table);
}

export function aggregate(ctx: CheckerContext, info: ExpressionInfo): boolean {
  return isAggregateType(info.descriptor ?? info.dataType, ctx.types);
}

export function isEnum(ctx: CheckerContext, info: ExpressionInfo): boolean {
  return !!enumerationType(info.descriptor ?? info.dataType, ctx.types);
}

export function sameExternalType(
  ctx: CheckerContext,
  left: TypeDescriptor,
  right: TypeDescriptor,
): boolean {
  const a = arrayType(left, ctx.types),
    b = arrayType(right, ctx.types);
  if (a || b)
    return (
      !!a &&
      !!b &&
      JSON.stringify(a.dimensions) === JSON.stringify(b.dimensions) &&
      sameExternalType(ctx, a.element, b.element)
    );
  if (typeof left !== "string" && left.kind === "functionBlock")
    return typeof right !== "string" && right.kind === "functionBlock" && left.name === right.name;
  return sameScalarType(left, right, ctx.types);
}

export function referenceAssignable(
  ctx: CheckerContext,
  target: TypeDescriptor,
  source: TypeDescriptor,
): boolean {
  const t = referenceType(target, ctx.types),
    s = referenceType(source, ctx.types);
  if (!t || !s) return false;
  const left = resolveType(t.target, ctx.types),
    right = resolveType(s.target, ctx.types);
  if (
    typeof left === "object" &&
    left.kind === "functionBlock" &&
    typeof right === "object" &&
    right.kind === "functionBlock"
  ) {
    let actual = ctx.pous.get(right.name);
    while (actual) {
      if (actual.name.key === left.name) return true;
      actual = actual.baseType;
    }
    return false;
  }
  return sameScalarType(target, source, ctx.types);
}

export function instanceReference(ctx: CheckerContext, type: TypeDescriptor): boolean {
  const ref = referenceType(type, ctx.types);
  const target = ref && resolveType(ref.target, ctx.types);
  return typeof target === "object" && target.kind === "functionBlock";
}
