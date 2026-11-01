import type { ConversionFunction, SourceSpan, TypeDescriptor } from "@benchtop-plc/core";
import {
  coerceValue,
  conversionFunctions,
  convertValue,
  enumerationType,
  interfaceType,
  isAggregateType,
  isLongType,
  referenceType,
  sameScalarType,
  validateDeclaredValue,
} from "@benchtop-plc/core";
import type { ExpressionInfo } from "../checked.js";
import { assignable } from "../type-rules.js";

import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { baseType, isEnum, referenceAssignable } from "./type-identity.js";

export function assignment(
  ctx: CheckerContext,
  target: TypeDescriptor,
  info: ExpressionInfo,
  span: SourceSpan,
): boolean {
  const source = info.descriptor ?? info.dataType;
  const ti = interfaceType(target, ctx.types),
    si = interfaceType(source, ctx.types);
  if (ti || si) {
    if (
      ti &&
      (info.nullReference ||
        (si &&
          (si.name.toUpperCase() === ti.name.toUpperCase() ||
            si.extends.includes(ti.name.toUpperCase()))) ||
        (typeof source === "object" &&
          source.kind === "functionBlock" &&
          ctx.pous.get(source.name)?.implemented?.includes(ti.name.toUpperCase())))
    )
      return true;
    report(ctx, "type.assign-mismatch", { from: source, to: target }, span);
    return false;
  }
  if (info.nullReference && !referenceType(target, ctx.types)) {
    report(ctx, "type.invalid-reference-target", {}, span);
    return false;
  }
  if (referenceType(target, ctx.types) || referenceType(source, ctx.types)) {
    if (
      referenceType(target, ctx.types) &&
      (info.nullReference || referenceAssignable(ctx, target, source))
    )
      return true;
    report(ctx, "type.assign-mismatch", { from: source, to: target }, span);
    return false;
  }
  if (isAggregateType(target, ctx.types) || isAggregateType(source, ctx.types)) {
    if (sameScalarType(target, source, ctx.types)) return true;
    report(ctx, "type.assign-mismatch", { from: source, to: target }, span);
    return false;
  }
  const to = baseType(ctx, target, ctx.types),
    from = info.dataType;
  const enums = isEnum(ctx, info) || !!enumerationType(target, ctx.types);
  if (enums ? !sameScalarType(target, info.descriptor ?? from, ctx.types) : !assignable(to, from)) {
    report(
      ctx,
      "type.assign-mismatch",
      {
        from: info.descriptor ?? from,
        to: target,
        ...(!enums && Object.hasOwn(conversionFunctions, `${from}_TO_${to}`)
          ? { hint: "explicit-conversion" as const }
          : {}),
      },
      span,
    );
    return false;
  }
  if (info.constant !== undefined) {
    try {
      validateDeclaredValue(target, info.constant, ctx.types);
      if (isLongType(to) && to !== from)
        convertValue(`${from}_TO_${to}` as ConversionFunction, info.constant);
      else coerceValue(to, info.constant);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      report(ctx, "type.invalid-constant", {}, span);
      return false;
    }
  }
  return true;
}
