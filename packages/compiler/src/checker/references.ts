import type { TypeDescriptor } from "@benchtop-plc/core";
import {
  arrayType,
  bitWidths,
  standardFunctionBlocks as blocks,
  isAggregateType,
  isBitType,
  isFunctionBlockType as isBlock,
  isIntegerType,
  referenceLike,
  referenceType,
  scalarBase,
  structureType,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import { rootName } from "../ast.js";
import type { ExpressionInfo, VariableSymbol } from "../checked.js";
import { isConstantDeclaration } from "../constants.js";
import { accessible } from "../inheritance.js";
import { isInteger } from "../type-rules.js";

import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { aggregate, baseType, isEnum, isScalar } from "./type-identity.js";
import { parameterType } from "./types.js";

export function memberAccessible(ctx: CheckerContext, name: AST.Identifier): boolean {
  const owner = ctx.ast.owner ?? ctx.ast;
  const declaration = owner.declarations.find((d) => d.names.some((n) => n.key === name.key));
  if (
    declaration?.declaringType &&
    !declaration.section &&
    !accessible(
      declaration.access,
      declaration.declaringType,
      ctx.declarationScope?.initializerOwner ?? owner,
    )
  ) {
    report(ctx, "access.hidden", { name: name.name }, name.span);
    return false;
  }
  return true;
}

export function resolve(ctx: CheckerContext, name: AST.Identifier): VariableSymbol | null {
  if (!memberAccessible(ctx, name)) return null;
  const symbol = ctx.names.get(name.key);
  if (!symbol) {
    report(ctx, "name.undeclared", { name: name.name }, name.span);
    return null;
  }
  ctx.references.set(name, { variable: symbol.id });
  return symbol;
}

export function bitIndex(
  ctx: CheckerContext,
  type: TypeDescriptor,
  member: AST.Identifier,
): number | null {
  const index = ctx.constants.get(member.key);
  if (index && !memberAccessible(ctx, member)) return null;
  if (index && index.value === undefined) {
    if (!index.initializerProcessed)
      report(ctx, "decl.constant-order", { name: member.name }, member.span);
    return null;
  }
  if (index && !isInteger(index.type)) {
    report(ctx, "type.invalid-constant", {}, member.span);
    return null;
  }
  const bit = Number(index ? index.value : member.key);
  if (!Number.isSafeInteger(bit)) {
    report(ctx, "type.invalid-constant", {}, member.span);
    return null;
  }
  const base =
    isAggregateType(type, ctx.types) || referenceLike(type, ctx.types)
      ? undefined
      : scalarBase(type, ctx.types);
  if (!base || !isBitType(base) || base === "BOOL" || bit < 0 || bit >= bitWidths[base]) {
    report(ctx, "type.invalid-bit-access", { type, bit }, member.span);
    return null;
  }
  return bit;
}

export function field(
  ctx: CheckerContext,
  type: TypeDescriptor,
  member: AST.Identifier,
): ExpressionInfo | null {
  const structure = structureType(type, ctx.types);
  if (structure) {
    const index = structure.members.findIndex((item) => item.name.toUpperCase() === member.key);
    if (index < 0) {
      report(ctx, "type.unknown-structure-member", { type, member: member.name }, member.span);
      return null;
    }
    ctx.references.set(member, { variable: 0, member: index, structure: true });
    const descriptor = structure.members[index]!.dataType;
    return { dataType: baseType(ctx, descriptor), descriptor };
  }
  const bit = bitIndex(ctx, type, member);
  if (bit === null) return null;
  ctx.references.set(member, { variable: 0, bit });
  return { dataType: "BOOL" };
}

export function forControlWrite(
  ctx: CheckerContext,
  symbol: VariableSymbol,
  name: AST.Identifier,
): boolean {
  if (!ctx.activeForVariables.has(symbol.id)) return false;
  report(ctx, "flow.for-control-write", { name: name.name }, name.span);
  return true;
}

export function checkReference(
  ctx: CheckerContext,
  node: AST.AssignmentTarget,
  write = false,
  instance = false,
): ExpressionInfo | null {
  if (
    (node.kind === "name" && node.name.key === "SUPER") ||
    (node.kind === "member" && node.instance.key === "SUPER")
  ) {
    report(ctx, "inheritance.super-context", {}, node.span);
    return null;
  }
  if (node.kind === "member" && node.instance.key === "THIS") {
    if (!(
      ctx.ast.owner ?? (["functionBlock", "class"].includes(ctx.ast.kind) ? ctx.ast : undefined)
    )) {
      report(ctx, "method.this-outside", {}, node.instance.span);
      return null;
    }
    const owner = ctx.ast.owner ?? ctx.ast;
    if (!owner.declarations.some((d) => d.names.some((n) => n.key === node.member.key))) {
      report(
        ctx,
        "fb.unknown-member",
        { name: "THIS", member: node.member.name },
        node.member.span,
      );
      return null;
    }
    const local: AST.NameReference = { kind: "name", name: node.member, span: node.span };
    return checkReference(ctx, local, write, instance);
  }
  if (node.kind === "name" && node.name.key === "THIS") {
    const owner =
      ctx.ast.owner ?? (["class", "functionBlock"].includes(ctx.ast.kind) ? ctx.ast : undefined);
    if (owner && instance)
      return {
        dataType: "INT",
        descriptor: {
          kind: "functionBlock",
          name: owner.name.key,
          block: ctx.blockIds.get(owner.name.key),
        },
      };
    report(ctx, "method.this-outside", {}, node.span);
    return null;
  }
  if (node.kind === "dereference") {
    const value = ctx.rules.expression(ctx, node.reference);
    if (!value) return null;
    const ref = referenceType(value.descriptor ?? value.dataType, ctx.types);
    if (!ref) {
      report(ctx, "type.invalid-reference-target", {}, node.span);
      return null;
    }
    if (!instance && typeof ref.target === "object" && ref.target.kind === "functionBlock") {
      report(ctx, "fb.instance-as-value", { name: rootName(node).name }, node.span);
      return null;
    }
    return { dataType: baseType(ctx, ref.target), descriptor: ref.target };
  }
  if (node.kind === "field") return fieldReference(ctx, node, write);
  if (node.kind === "index") return indexReference(ctx, node, write, instance);
  if (node.kind === "elementBit") {
    const element = checkReference(ctx, node.element, write);
    if (!element) return null;
    ctx.expressions.set(node.element, element);
    const bit = bitIndex(ctx, element.descriptor ?? element.dataType, node.member);
    if (bit === null) return null;
    ctx.references.set(node.member, { variable: 0, bit });
    return { dataType: "BOOL" };
  }
  return namedReference(ctx, node, write, instance);
}

export function blockMember(
  ctx: CheckerContext,
  symbol: VariableSymbol,
  member: AST.Identifier,
  write: boolean,
  name = symbol.name,
): ExpressionInfo | null {
  if (symbol.userBlock !== undefined) {
    const pou = ctx.pous.get(symbol.type)!;
    const parameters = pou.declarations
      .filter((declaration) => !isConstantDeclaration(declaration))
      .flatMap((declaration) =>
        declaration.names.map((member) => ({
          name: member,
          type: parameterType(ctx, pou, declaration),
          section: declaration.section,
          access: declaration.access ?? "PROTECTED",
          declaringType: declaration.declaringType ?? pou,
        })),
      );
    const index = parameters.findIndex(
      (parameter) =>
        parameter.name.key === member.key &&
        !["VAR_TEMP", "VAR_IN_OUT", "VAR_EXTERNAL"].includes(parameter.section ?? ""),
    );
    const parameter = parameters[index];
    if (!parameter?.type) {
      report(ctx, "fb.unknown-member", { name: name.name, member: member.name }, member.span);
      return null;
    }
    if (
      !parameter.section &&
      !accessible(parameter.access, parameter.declaringType, ctx.ast.owner ?? ctx.ast)
    ) {
      report(ctx, "fb.unknown-member", { name: name.name, member: member.name }, member.span);
      return null;
    }
    if (write && parameter.section === "VAR_OUTPUT")
      report(ctx, "fb.output-not-writable", { name: name.name, member: member.name }, member.span);
    ctx.references.set(member, {
      variable: symbol.id,
      member: index,
      port: parameter.section === "VAR_OUTPUT" ? "output" : "input",
      userBlock: true,
    });
    return { dataType: baseType(ctx, parameter.type, ctx.types), descriptor: parameter.type };
  }
  if (!isBlock(symbol.type)) {
    report(ctx, "fb.not-function-block", { name: name.name }, name.span);
    return null;
  }
  const descriptor = blocks[symbol.type];
  for (const port of ["inputs", "outputs"] as const) {
    const index = descriptor[port].findIndex(([key]) => key === member.key);
    if (index < 0) continue;
    if (write && port === "outputs")
      report(ctx, "fb.output-not-writable", { name: name.name, member: member.name }, member.span);
    ctx.references.set(member, {
      variable: symbol.id,
      port: port === "inputs" ? "input" : "output",
      member: index,
    });
    return { dataType: descriptor[port][index]![1] };
  }
  report(ctx, "fb.unknown-member", { name: name.name, member: member.name }, member.span);
  return null;
}

function fieldReference(
  ctx: CheckerContext,
  node: Extract<AST.AssignmentTarget, { kind: "field" }>,
  write: boolean,
): ExpressionInfo | null {
  const object = checkReference(ctx, node.object, write, true);
  if (!object) return null;
  if (
    (node.object.kind === "member" || node.object.kind === "field") &&
    ctx.references.get(node.object.member)?.port &&
    !aggregate(ctx, object) &&
    !(typeof object.descriptor === "object" && object.descriptor.kind === "functionBlock")
  ) {
    report(
      ctx,
      "fb.unknown-member",
      {
        name: rootName(node.object).name,
        member: `${node.object.member.name}.${node.member.name}`,
      },
      node.member.span,
    );
    return null;
  }
  ctx.expressions.set(node.object, object);
  if (typeof object.descriptor !== "string" && object.descriptor?.kind === "functionBlock") {
    const type = object.descriptor;
    const symbol: VariableSymbol = {
      id: ctx.references.get(rootName(node.object))?.variable ?? 0,
      name: rootName(node.object),
      type: type.name,
      userBlock: ctx.blockIds.get(type.name),
      initialValue: null,
    };
    return blockMember(ctx, symbol, node.member, write);
  }
  return field(ctx, object.descriptor ?? object.dataType, node.member);
}

function indexReference(
  ctx: CheckerContext,
  node: Extract<AST.AssignmentTarget, { kind: "index" }>,
  write: boolean,
  instance: boolean,
): ExpressionInfo | null {
  const parent = checkReference(ctx, node.array, write, true);
  if (!parent) return null;
  ctx.expressions.set(node.array, parent);
  const parentType = parent.descriptor ?? parent.dataType;
  const array = arrayType(parentType, ctx.types);
  if (!array) {
    report(ctx, "type.not-array", { type: parentType }, node.array.span);
    return null;
  }
  if (array.dimensions.length !== node.indices.length) {
    report(
      ctx,
      "type.array-index-count",
      { expected: array.dimensions.length, found: node.indices.length },
      node.span,
    );
    return null;
  }
  node.indices.forEach((index, i) => {
    const info = ctx.rules.expression(ctx, index);
    if (!info) return;
    const type = info.descriptor ?? info.dataType;
    if (info.nullReference) {
      report(ctx, "type.invalid-reference-target", {}, index.span);
      return;
    }
    if (
      !isIntegerType(info.dataType) ||
      isEnum(ctx, info) ||
      isAggregateType(type, ctx.types) ||
      referenceLike(type, ctx.types)
    ) {
      report(ctx, "type.array-index-not-integer", { type }, index.span);
      return;
    }
    const d = array.dimensions[i]!;
    if (
      info.constant !== undefined &&
      d !== "*" &&
      (BigInt(info.constant) < BigInt(d.lower) || BigInt(info.constant) > BigInt(d.upper))
    )
      report(ctx, "type.invalid-constant", {}, index.span);
  });
  if (!instance && typeof array.element !== "string" && array.element.kind === "functionBlock") {
    report(ctx, "fb.instance-as-value", { name: rootName(node).name }, node.span);
    return null;
  }
  return { dataType: baseType(ctx, array.element), descriptor: array.element };
}

function namedReference(
  ctx: CheckerContext,
  node: Extract<AST.AssignmentTarget, { kind: "name" | "member" }>,
  write: boolean,
  instance: boolean,
): ExpressionInfo | null {
  const name = node.kind === "name" ? node.name : node.instance;
  const constant = ctx.constants.get(name.key);
  if (constant) {
    if (!memberAccessible(ctx, name)) return null;
    if (write) {
      report(ctx, "decl.constant-not-writable", { name: name.name }, name.span);
      return null;
    }
    if (constant.value === undefined) {
      if (!constant.initializerProcessed)
        report(ctx, "decl.constant-order", { name: name.name }, name.span);
      return null;
    }
    if (node.kind === "name")
      return {
        dataType: constant.type,
        descriptor: constant.descriptor,
        constant: constant.value,
      };
    const bit = bitIndex(ctx, constant.type, node.member);
    return bit === null
      ? null
      : { dataType: "BOOL", constant: !!((BigInt(constant.value) >> BigInt(bit)) & 1n) };
  }
  if (
    ctx.ast.owner?.declarations.some(
      (d) => d.section === "VAR_IN_OUT" && d.names.some((n) => n.key === name.key),
    )
  ) {
    report(ctx, "method.instance-in-out", { name: name.name }, name.span);
    return null;
  }
  if (
    ctx.ast.owner?.declarations.some(
      (d) => d.section === "VAR_TEMP" && d.names.some((n) => n.key === name.key),
    )
  ) {
    report(ctx, "name.undeclared", { name: name.name }, name.span);
    return null;
  }
  const symbol = resolve(ctx, name);
  if (!symbol) return null;
  if (write && forControlWrite(ctx, symbol, name)) return null;
  if (write && symbol === ctx.state.result) ctx.state.resultMayBeAssigned = true;
  if (node.kind === "name") {
    if (!isScalar(symbol.type) && !instance) {
      report(ctx, "fb.instance-as-value", { name: name.name }, node.span);
      return null;
    }
    return {
      dataType: isScalar(symbol.type) ? symbol.type : "INT",
      descriptor:
        symbol.descriptor ??
        (isScalar(symbol.type) ? undefined : { kind: "functionBlock", name: symbol.type }),
    };
  }
  if (symbol.descriptor && structureType(symbol.descriptor, ctx.types)) {
    return field(ctx, symbol.descriptor, node.member);
  }
  if (
    isScalar(symbol.type) &&
    (/^\d+$/.test(node.member.key) || ctx.constants.has(node.member.key))
  ) {
    const bit = bitIndex(ctx, symbol.descriptor ?? symbol.type, node.member);
    if (bit === null) return null;
    ctx.references.set(node.member, { variable: symbol.id, bit });
    return { dataType: "BOOL" };
  }
  if (symbol.descriptor && arrayType(symbol.descriptor, ctx.types)) {
    report(ctx, "fb.not-function-block", { name: name.name }, name.span);
    return null;
  }
  return blockMember(ctx, symbol, node.member, write, name);
}
