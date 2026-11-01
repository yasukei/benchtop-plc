import type { ConversionFunction, ScalarValue, TypeDescriptor } from "@benchtop-plc/core";
import {
  arraySize,
  arrayType,
  cloneInitialValue,
  coerceValue,
  convertValue,
  isAggregateType,
  isFunctionBlockType as isBlock,
  isIntegerType,
  isLongType,
  referenceLike,
  structureType,
  typeEntry,
  type InitialValue,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import { resolveDescriptor } from "./types.js";

import { assignment } from "./assignment.js";
import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { baseType, declarationType, isEnum, isScalar, sameExternalType } from "./type-identity.js";
import { defaultValue } from "./types.js";

export function aggregateInitial(
  ctx: CheckerContext,
  type: TypeDescriptor,
  node?: AST.Expression,
): InitialValue[] {
  const structure = structureType(type, ctx.types);
  if (!structure) return arrayInitial(ctx, type, node);
  if (!node && typeof type !== "string" && type.kind === "named")
    return cloneInitialValue(typeEntry(type, ctx.types).initialValue) as InitialValue[];
  const result = structure.members.map((member) => cloneInitialValue(member.initialValue));
  if (node) {
    if (node.kind !== "structureInitializer") report(ctx, "type.invalid-constant", {}, node.span);
    else {
      const seen = new Set<string>();
      for (const member of node.members) {
        const index = structure.members.findIndex(
          (item) => item.name.toUpperCase() === member.name.key,
        );
        if (index < 0 || seen.has(member.name.key)) {
          report(ctx, "type.invalid-constant", {}, member.name.span);
          continue;
        }
        seen.add(member.name.key);
        const target = structure.members[index]!.dataType;
        if (isAggregateType(target, ctx.types))
          result[index] = aggregateInitial(ctx, target, member.value);
        else {
          if (referenceLike(target, ctx.types)) {
            if (member.value.kind !== "null")
              report(ctx, "type.reference-initializer", {}, member.value.span);
            result[index] = null;
            continue;
          }
          const info = ctx.rules.expression(ctx, member.value, target);
          if (!info || !assignment(ctx, target, info, member.value.span)) continue;
          if (info.constant === undefined) {
            report(ctx, "type.invalid-constant", {}, member.value.span);
            continue;
          }
          const base = baseType(ctx, target);
          result[index] =
            isLongType(base) && info.dataType !== base
              ? (convertValue(
                  `${info.dataType}_TO_${base}` as ConversionFunction,
                  info.constant,
                ) as InitialValue)
              : coerceValue(base, info.constant);
        }
      }
    }
  }
  return result;
}

export function arrayInitial(
  ctx: CheckerContext,
  type: TypeDescriptor,
  node?: AST.Expression,
): InitialValue[] {
  const array = arrayType(type, ctx.types)!;
  if (!node && typeof type !== "string" && type.kind === "named")
    return cloneInitialValue(typeEntry(type, ctx.types).initialValue) as InitialValue[];
  const result: InitialValue[] = [];
  if (node) {
    if (node.kind !== "arrayInitializer")
      report(ctx, "type.array-initializer-required", { type }, node.span);
    else
      for (const item of node.items) {
        const countInfo = item.count ? ctx.rules.expression(ctx, item.count, "DINT") : undefined;
        const count = item.count ? Number(countInfo?.constant) : 1;
        if (
          !Number.isInteger(count) ||
          count < 0 ||
          count > 10000 ||
          (countInfo && (!isIntegerType(countInfo.dataType) || isEnum(ctx, countInfo)))
        ) {
          report(ctx, "type.invalid-constant", {}, node.span);
          continue;
        }
        const values = item.values.map((value) => {
          if (isAggregateType(array.element, ctx.types))
            return aggregateInitial(ctx, array.element, value);
          if (referenceLike(array.element, ctx.types)) {
            if (value.kind !== "null") report(ctx, "type.reference-initializer", {}, value.span);
            return null;
          }
          const info = ctx.rules.expression(ctx, value, array.element);
          if (!info) return defaultValue(ctx, array.element);
          if (!assignment(ctx, array.element, info, value.span) || info.constant === undefined) {
            report(ctx, "type.invalid-constant", {}, value.span);
            return defaultValue(ctx, array.element);
          }
          const base = baseType(ctx, array.element);
          return isLongType(base) && info.dataType !== base
            ? (convertValue(
                `${info.dataType}_TO_${base}` as ConversionFunction,
                info.constant,
              ) as InitialValue)
            : coerceValue(base, info.constant);
        });
        if (result.length + count * values.length > arraySize(array)) {
          report(ctx, "type.invalid-constant", {}, node.span);
          continue;
        }
        for (let i = 0; i < count; i++)
          result.push(...(cloneInitialValue(values) as InitialValue[]));
      }
  }
  while (result.length < arraySize(array))
    result.push(
      isAggregateType(array.element, ctx.types)
        ? aggregateInitial(ctx, array.element)
        : (defaultValue(ctx, array.element) as InitialValue),
    );
  return result;
}

export function initializer(ctx: CheckerContext, declaration: AST.Declaration): void {
  if (declaration.section === "VAR_EXTERNAL") {
    const descriptor = resolveDescriptor(
      ctx,
      declaration.typeName,
      declaration.subrange,
      declaration.stringLength,
      declaration.array,
      declaration.reference,
    );
    for (const name of declaration.names) {
      const global = ctx.globals?.symbols.find((s) => s.name.key === name.key);
      const constant = ctx.globals?.constants.get(name.key);
      if (!global && !constant) continue;
      const actual = global?.descriptor ?? constant?.descriptor ?? global?.type ?? constant!.type;
      const type = declarationType(declaration.typeName.key);
      const block = isBlock(type) || ctx.blockIds.has(type);
      const same =
        block && !declaration.array
          ? !global?.aggregateValues && type === global?.type
          : descriptor && sameExternalType(ctx, descriptor, actual as TypeDescriptor);
      if (!same)
        report(ctx, "global.type-mismatch", { name: name.name }, declaration.typeName.span);
    }
    return;
  }
  const descriptor = resolveDescriptor(
    ctx,
    declaration.typeName,
    declaration.subrange,
    declaration.stringLength,
    declaration.array,
    declaration.reference,
  );
  if (declaration.array && !descriptor) return;
  for (const name of declaration.names) {
    const symbol = ctx.names.get(name.key),
      constant = ctx.constants.get(name.key);
    if (descriptor && symbol?.name === name) {
      symbol.descriptor = descriptor;
      symbol.initialValue = defaultValue(ctx, descriptor);
    }
    if (descriptor && constant?.name === name) constant.descriptor = descriptor;
  }
  if (descriptor && isAggregateType(descriptor, ctx.types)) {
    const element = arrayType(descriptor, ctx.types)?.element;
    const block = element && typeof element !== "string" && element.kind === "functionBlock";
    if (block && declaration.initializer)
      report(
        ctx,
        "decl.fb-initializer",
        { name: declaration.names[0].name },
        declaration.initializer.span,
      );
    const values = block
      ? Array.from({ length: arraySize(arrayType(descriptor, ctx.types)!) }, () => 0)
      : aggregateInitial(ctx, descriptor, declaration.initializer);
    for (const name of declaration.names) {
      const symbol = ctx.names.get(name.key);
      if (symbol?.name === name) symbol.aggregateValues = cloneInitialValue(values);
    }
    return;
  }
  const value = declaration.initializer;
  if (descriptor && referenceLike(descriptor, ctx.types)) {
    if (value && value.kind !== "null") report(ctx, "type.reference-initializer", {}, value.span);
    return;
  }
  if (!value) {
    for (const name of declaration.names) {
      const constant = ctx.constants.get(name.key);
      if (constant?.name === name)
        constant.value = defaultValue(ctx, constant.descriptor ?? constant.type) as ScalarValue;
    }
    return;
  }
  const type = descriptor
    ? baseType(ctx, descriptor, ctx.types)
    : declarationType(declaration.typeName.key);
  if (isBlock(type) || ctx.blockIds.has(type)) {
    report(ctx, "decl.fb-initializer", { name: declaration.names[0].name }, value.span);
    return;
  }
  const before = ctx.diagnostics.length;
  const info = ctx.rules.expression(ctx, value, descriptor ?? (isScalar(type) ? type : undefined));
  if (!info || !isScalar(type)) return;
  if (!assignment(ctx, descriptor ?? type, info, value.span)) return;
  if (info.constant === undefined) {
    if (!ctx.diagnostics.slice(before).some((item) => item.severity === "error"))
      report(ctx, "decl.nonconstant-initializer", { name: declaration.names[0].name }, value.span);
    return;
  }
  const initialValue =
    isLongType(type) && info.dataType !== type
      ? convertValue(`${info.dataType}_TO_${type}` as ConversionFunction, info.constant)
      : coerceValue(type, info.constant);
  for (const name of declaration.names) {
    const symbol = ctx.names.get(name.key);
    if (symbol?.name === name) symbol.initialValue = initialValue;
    const constant = ctx.constants.get(name.key);
    if (constant?.name === name) constant.value = initialValue;
  }
}
