import {
  addressBinds,
  arrayType,
  isAggregateType,
  isFunctionBlockType as isBlock,
  isStandardFunction as isFunction,
  leafCount,
  referenceLike,
  resolveType,
  validDirectAddress,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import type { VariableSymbol } from "../checked.js";
import { isConstantDeclaration } from "../constants.js";
import { isReservedStandardName } from "../reserved-names.js";
import { resolveDescriptor } from "./types.js";

import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { baseType, declarationType, hasOpenDimensions, isScalar } from "./type-identity.js";
import { defaultValue } from "./types.js";

export function declare(ctx: CheckerContext, declaration: AST.Declaration): void {
  const descriptor = resolveDescriptor(
    ctx,
    declaration.typeName,
    declaration.subrange,
    declaration.stringLength,
    declaration.array,
    declaration.reference,
  );
  if (declaration.array && ctx.unsupportedBlockArrays.has(declaration.array)) return;
  const element = descriptor && arrayType(descriptor, ctx.types)?.element;
  const type =
    element && typeof element !== "string" && element.kind === "functionBlock"
      ? element.name
      : descriptor
        ? baseType(ctx, descriptor, ctx.types)
        : declarationType(declaration.typeName.key);
  const userBlock = ctx.blockIds.get(type);
  const block = isBlock(type) || userBlock !== undefined;
  if (
    userBlock !== undefined &&
    ctx.pous.get(type)?.abstract &&
    declaration.section !== "VAR_EXTERNAL"
  )
    report(
      ctx,
      "inheritance.abstract-instance",
      { name: declaration.typeName.name },
      declaration.typeName.span,
    );
  const known = isScalar(type) || block;
  if (
    hasOpenDimensions(declaration.array) &&
    (declaration.section !== "VAR_IN_OUT" || hasOpenDimensions(declaration.array?.array))
  )
    report(ctx, "decl.open-array-section", {}, declaration.span);
  if (descriptor && leafCount(descriptor, ctx.types) > 10000)
    report(ctx, "type.invalid-constant", {}, declaration.span);
  if (
    isConstantDeclaration(declaration) &&
    (block ||
      (descriptor &&
        (isAggregateType(descriptor, ctx.types) || referenceLike(descriptor, ctx.types))))
  )
    report(ctx, "decl.constant-type", {}, declaration.typeName.span);
  if ((declaration.retain || declaration.nonRetain) && declaration.address)
    report(ctx, "decl.retention-address", {}, declaration.address.span);
  if (isConstantDeclaration(declaration) && declaration.address)
    report(ctx, "decl.constant-address", {}, declaration.address.span);
  if (declaration.section === "VAR_IN_OUT" && declaration.initializer)
    report(
      ctx,
      "decl.in-out-initializer",
      { name: declaration.names[0].name },
      declaration.initializer.span,
    );
  if (block && declaration.section && declaration.section !== "VAR_EXTERNAL")
    report(
      ctx,
      "fb.invalid-instance-section",
      { name: declaration.names[0].name },
      declaration.typeName.span,
    );
  if (ctx.ast.kind === "function" && block)
    report(ctx, "pou.function-block-in-function", {}, declaration.typeName.span);
  if (!known && !ctx.failedReferenceTypes.has(declaration.typeName))
    report(
      ctx,
      "decl.unknown-type",
      { name: declaration.typeName.name },
      declaration.typeName.span,
    );
  if (declaration.address) {
    const address = declaration.address;
    if (declaration.section === "VAR_TEMP") report(ctx, "decl.temp-address", {}, address.span);
    if (
      ctx.ast.kind === "program" &&
      (declaration.section === "VAR_INPUT" || declaration.section === "VAR_OUTPUT")
    )
      report(ctx, "decl.parameter-address", {}, address.span);
    if (ctx.ast.kind !== "program") report(ctx, "pou.direct-address", {}, address.span);
    if (declaration.names.length > 1) report(ctx, "decl.at-multiple-names", {}, address.span);
    if (!validDirectAddress(address))
      report(ctx, "decl.address-out-of-range", { address: address.text }, address.span);
    if (
      known &&
      (declaration.subrange ||
        !addressBinds(address, descriptor ? resolveType(descriptor, ctx.types) : type))
    )
      report(
        ctx,
        "decl.direct-address-type",
        { name: declaration.names[0].name, type },
        address.span,
      );
  }
  if (declaration.section === "VAR_EXTERNAL") {
    declareExternal(ctx, declaration);
    return;
  }
  for (const name of declaration.names) {
    const duplicate = ctx.declaredNames.has(name.key);
    ctx.declaredNames.add(name.key);
    const pou = ctx.pous.get(name.key);
    if (pou) {
      report(
        ctx,
        "decl.name-collision",
        { name: name.name, kind: pou.kind === "function" ? "function" : "type" },
        name.span,
      );
    } else if (
      isScalar(name.key) ||
      isBlock(name.key) ||
      ctx.types.some((entry) => entry.name.toUpperCase() === name.key)
    ) {
      report(ctx, "decl.name-collision", { name: name.name, kind: "type" }, name.span);
    } else if (isFunction(name.key) || isReservedStandardName(name.key)) {
      report(ctx, "decl.name-collision", { name: name.name, kind: "function" }, name.span);
    } else if (duplicate) {
      report(ctx, "decl.duplicate", { name: name.name }, name.span);
    } else if (isConstantDeclaration(declaration) && isScalar(type)) {
      ctx.constants.set(name.key, { name, type, descriptor, initializerProcessed: false });
    } else if (known) {
      const symbol: VariableSymbol = {
        id: ctx.symbols.length,
        name,
        type,
        ...(descriptor ? { descriptor } : {}),
        ...(userBlock !== undefined ? { userBlock } : {}),
        initialValue: block ? null : defaultValue(ctx, descriptor!),
      };
      ctx.symbols.push(symbol);
      ctx.names.set(name.key, symbol);
      ctx.references.set(name, { variable: symbol.id });
    }
  }
}

function declareExternal(ctx: CheckerContext, declaration: AST.Declaration): void {
  if (declaration.initializer || declaration.address)
    report(
      ctx,
      "global.external-initializer",
      { name: declaration.names[0].name },
      declaration.span,
    );
  for (const name of declaration.names) {
    if (ctx.declaredNames.has(name.key)) {
      report(ctx, "decl.duplicate", { name: name.name }, name.span);
      continue;
    }
    ctx.declaredNames.add(name.key);
    const global = ctx.globals?.symbols.find((s) => s.name.key === name.key);
    const constant = ctx.globals?.constants.get(name.key);
    if (!global && !constant) {
      report(ctx, "global.not-found", { name: name.name }, name.span);
      continue;
    }
    if (isConstantDeclaration(declaration) !== !!constant)
      report(ctx, "global.constant-mismatch", { name: name.name }, name.span);
    if (constant) ctx.constants.set(name.key, { ...constant, name });
    else if (global) {
      const symbol = { ...global, id: ctx.symbols.length, name, external: name.key };
      ctx.symbols.push(symbol);
      ctx.names.set(name.key, symbol);
      ctx.references.set(name, { variable: symbol.id });
    }
  }
  return;
}
