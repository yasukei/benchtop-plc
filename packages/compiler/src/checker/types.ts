import type { ScalarValue, TypeDescriptor } from "@benchtop-plc/core";
import {
  arrayType,
  coerceValue,
  DEFAULT_STRING_LENGTH,
  enumerationType,
  interfaceType,
  isAggregateType,
  isFunctionBlockType as isBlock,
  isCharacterType,
  isIntegerType,
  isLongType,
  leafCount,
  MAX_STRING_LENGTH,
  referenceLike,
  referenceType,
  subrangeType,
  typeEntry,
  validateValue,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import { baseType } from "./type-identity.js";

import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { declarationType, isEnum, isScalar } from "./type-identity.js";

export function arrayDeclaration(
  ctx: CheckerContext,
  node: AST.ArrayDeclaration,
): TypeDescriptor | undefined {
  if (ctx.unsupportedBlockArrays.has(node)) return undefined;
  const key = declarationType(node.typeName.key);
  const block = !node.array && !node.reference && (isBlock(key) || ctx.blockIds.has(key));
  if (block && (node.subrange || node.stringLength !== undefined)) {
    report(ctx, "type.invalid-constant", {}, node.span);
    return undefined;
  }
  const element: TypeDescriptor | undefined = block
    ? {
        kind: "functionBlock",
        name: key,
        ...(ctx.blockIds.has(key) ? { block: ctx.blockIds.get(key)! } : {}),
      }
    : resolveDescriptor(
        ctx,
        node.typeName,
        node.subrange,
        node.stringLength,
        node.array,
        node.reference,
      );
  if (!element) {
    if (node.array && ctx.unsupportedBlockArrays.has(node.array))
      ctx.unsupportedBlockArrays.add(node);
    return undefined;
  }
  const nested = arrayType(element, ctx.types);
  if (nested && typeof nested.element !== "string" && nested.element.kind === "functionBlock") {
    ctx.unsupportedBlockArrays.add(node);
    report(ctx, "decl.fb-array-form", { form: "nested" }, node.span);
    return undefined;
  }
  if (ctx.state.collectingDeclarations)
    return { kind: "array", dimensions: [{ lower: 0, upper: 0 }], element };
  try {
    if (node.dimensions.some((d) => d === "*") && !node.dimensions.every((d) => d === "*"))
      throw new RangeError("Mixed open and fixed dimensions");
    const dimensions = node.dimensions.map((d) => {
      if (d === "*") return "*" as const;
      const lower = ctx.rules.expression(ctx, d.lower, "LINT"),
        upper = ctx.rules.expression(ctx, d.upper, "LINT");
      if (
        !lower ||
        !upper ||
        !isIntegerType(lower.dataType) ||
        !isIntegerType(upper.dataType) ||
        isEnum(ctx, lower) ||
        isEnum(ctx, upper) ||
        lower.constant === undefined ||
        upper.constant === undefined
      )
        throw new RangeError("Nonconstant array bounds");
      const l = BigInt(lower.constant),
        u = BigInt(upper.constant);
      if (l < -2147483648n || u > 2147483647n || l > u)
        throw new RangeError("Invalid array bounds");
      return { lower: Number(l), upper: Number(u) };
    });
    const type: TypeDescriptor = { kind: "array", dimensions, element };
    if (dimensions.length > 3 || leafCount(type, ctx.types) > 10000)
      throw new RangeError("Array limit");
    return type;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    report(ctx, "type.invalid-constant", {}, node.span);
    return undefined;
  }
}

export function resolveDescriptor(
  ctx: CheckerContext,
  name: AST.Identifier,
  range?: AST.Subrange,
  stringLength?: number,
  array?: AST.ArrayDeclaration,
  reference?: AST.TypeSyntax,
): TypeDescriptor | undefined {
  if (reference) {
    const fail = () => {
      ctx.failedReferenceTypes.add(name);
      ctx.failedReferenceTargets.add(reference);
      return undefined;
    };
    if (ctx.failedReferenceTargets.has(reference)) return fail();
    if (!reference.reference && !reference.array && isBlock(reference.typeName.key)) {
      report(ctx, "type.invalid-reference-target", {}, reference.typeName.span);
      return fail();
    }
    const target: TypeDescriptor | undefined =
      !reference.reference &&
      !reference.array &&
      !reference.subrange &&
      reference.stringLength === undefined &&
      ctx.blockIds.has(reference.typeName.key)
        ? {
            kind: "functionBlock",
            name: reference.typeName.key,
            block: ctx.blockIds.get(reference.typeName.key)!,
          }
        : resolveDescriptor(
            ctx,
            reference.typeName,
            reference.subrange,
            reference.stringLength,
            reference.array,
            reference.reference,
          );
    if (!target) {
      if (!ctx.failedReferenceTypes.has(reference.typeName)) {
        let leaf = reference;
        while (leaf.reference || leaf.array) leaf = (leaf.reference ?? leaf.array)!;
        report(ctx, "decl.unknown-type", { name: leaf.typeName.name }, leaf.typeName.span);
      }
      return fail();
    }
    const seen = new Set<TypeDescriptor>();
    const valid = (type: TypeDescriptor): boolean => {
      if (seen.has(type)) return true;
      seen.add(type);
      const a = arrayType(type, ctx.types);
      const r = referenceType(type, ctx.types);
      return a
        ? !a.dimensions.includes("*") && valid(a.element)
        : r
          ? valid(r.target)
          : !interfaceType(type, ctx.types) &&
            !(
              typeof type === "object" &&
              type.kind === "functionBlock" &&
              !ctx.blockIds.has(type.name)
            );
    };
    if (!valid(target)) {
      report(ctx, "type.invalid-reference-target", {}, reference.typeName.span);
      return fail();
    }
    return { kind: "reference", target };
  }
  if (array) {
    const descriptor = arrayDeclaration(ctx, array);
    if (!descriptor && ctx.failedReferenceTypes.has(array.typeName))
      ctx.failedReferenceTypes.add(name);
    return descriptor;
  }
  const key = declarationType(name.key);
  let type: TypeDescriptor;
  if (isScalar(key)) type = key;
  else {
    const entry = ctx.types.find((entry) => entry.name.toUpperCase() === key);
    if (!entry) return undefined;
    type = { kind: "named", name: entry.name };
  }
  if (key === "STRING" || key === "WSTRING") {
    const length = stringLength ?? DEFAULT_STRING_LENGTH;
    if (!Number.isInteger(length) || length < 1 || length > MAX_STRING_LENGTH) {
      report(ctx, "type.invalid-constant", {}, name.span);
      return type;
    }
    type = { kind: "string", base: key, length };
  } else if (stringLength !== undefined) {
    report(ctx, "type.invalid-constant", {}, name.span);
    return type;
  } else if (key === "CHAR" || key === "WCHAR") type = { kind: "character", base: key };
  if (range && (isAggregateType(type, ctx.types) || referenceLike(type, ctx.types))) {
    report(ctx, "type.invalid-constant", {}, range.span);
    return undefined;
  }
  if (!range || ctx.state.collectingDeclarations) return type;
  const base = baseType(ctx, type, ctx.types);
  const lower = ctx.rules.expression(ctx, range.lower, base),
    upper = ctx.rules.expression(ctx, range.upper, base);
  try {
    if (
      !isIntegerType(base) ||
      lower?.constant === undefined ||
      upper?.constant === undefined ||
      enumerationType(lower.descriptor ?? lower.dataType, ctx.types) ||
      enumerationType(upper.descriptor ?? upper.dataType, ctx.types)
    )
      throw new RangeError("Invalid bounds");
    validateValue(base, lower.constant);
    validateValue(base, upper.constant);
    if (BigInt(lower.constant) > BigInt(upper.constant)) throw new RangeError("Reversed bounds");
    return {
      kind: "subrange",
      base,
      lower: coerceValue(base, lower.constant),
      upper: coerceValue(base, upper.constant),
    };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    report(ctx, "type.invalid-constant", {}, range.span);
    return undefined;
  }
}

export function defaultValue(ctx: CheckerContext, type: TypeDescriptor): ScalarValue | null {
  if (referenceLike(type, ctx.types)) return null;
  if (isAggregateType(type, ctx.types)) return 0;
  if (typeof type !== "string" && type.kind === "named")
    return typeEntry(type, ctx.types).initialValue as ScalarValue;
  const range = subrangeType(type, ctx.types);
  if (range) return range.lower;
  const base = baseType(ctx, type, ctx.types);
  return isCharacterType(base)
    ? base === "CHAR" || base === "WCHAR"
      ? "\0"
      : ""
    : isLongType(base)
      ? "0"
      : base === "BOOL"
        ? false
        : 0;
}

export function parameterType(
  ctx: CheckerContext,
  pou: AST.Program,
  declaration: AST.Declaration,
): TypeDescriptor | undefined {
  const checked = ctx.interfaces.get(pou);
  const reference = checked?.references.get(declaration.names[0]);
  if (reference) {
    const symbol = checked!.symbols[reference.variable];
    if (symbol?.descriptor) return symbol.descriptor;
    if (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined))
      return {
        kind: "functionBlock",
        name: symbol.type,
        ...(symbol.userBlock !== undefined ? { block: symbol.userBlock } : {}),
      };
  }
  return resolveDescriptor(
    ctx,
    declaration.typeName,
    declaration.subrange,
    declaration.stringLength,
    declaration.array,
    declaration.reference,
  );
}
