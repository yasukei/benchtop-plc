import type { TypeDescriptor } from "@benchtop-plc/core";
import {
  arrayType,
  interfaceType,
  isFunctionBlockType as isBlock,
  sameScalarType,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import type { ExpressionInfo, UserCallInfo } from "../checked.js";
import { isConstantDeclaration } from "../constants.js";
import { accessible } from "../inheritance.js";

import { assignment } from "./assignment.js";
import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { checkReference } from "./references.js";
import { baseType } from "./type-identity.js";
import { parameterType, resolveDescriptor } from "./types.js";

export function methodCall(
  ctx: CheckerContext,
  node: AST.FunctionCall,
  statement: boolean,
  owner?: AST.Program,
): ExpressionInfo | null {
  let target = owner;
  let receiver = node.receiver;
  const superCall = receiver?.kind === "name" && receiver.name.key === "SUPER";
  if (superCall) {
    receiver = undefined;
    target = owner?.baseType;
    if (!target) {
      report(ctx, "inheritance.super-context", {}, node.span);
      return null;
    }
  } else if (receiver?.kind === "name" && receiver.name.key === "THIS") {
    receiver = undefined;
    if (!owner) {
      report(ctx, "method.this-outside", {}, node.span);
      return null;
    }
    const symbol = ctx.names.get(node.name.key);
    if (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined)) {
      report(ctx, "fb.call-in-expression", { name: node.name.name }, node.span);
      return null;
    }
  } else if (receiver) {
    const info = checkReference(ctx, receiver, false, true);
    if (info) ctx.expressions.set(receiver, info);
    const type = info?.descriptor && (interfaceType(info.descriptor, ctx.types) ?? info.descriptor);
    target =
      typeof type === "object" && (type.kind === "functionBlock" || type.kind === "interface")
        ? ctx.pous.get(type.name)
        : undefined;
  }
  const index = target?.methods?.findIndex((m) => m.name.key === node.name.key) ?? -1;
  const method = index < 0 ? undefined : target?.methods?.[index];
  if (superCall && (!method || method.abstract || method.access === "PRIVATE")) {
    report(ctx, "inheritance.super-method", { name: node.name.name }, node.name.span);
    return null;
  }
  if (!target || !method) {
    report(ctx, "method.unknown", { name: node.name.name }, node.name.span);
    return null;
  }
  if (!accessible(method.access, method.owner ?? target, owner ?? ctx.ast)) {
    report(ctx, "access.hidden", { name: node.name.name }, node.name.span);
    return null;
  }
  const info = userFunctionCall(ctx, node, method, statement);
  const call = ctx.userCalls.get(node)!;
  call.function = index;
  call.method = {
    block: target.kind === "interface" ? -1 : ctx.blockIds.get(target.name.key)!,
    ...(receiver ? { receiver } : {}),
    ...(superCall ? { static: true } : {}),
  };
  if (target.kind === "interface") {
    call.method.interface = target.name.key;
    return info;
  }
  const offset = ctx.interfaces.get(method.owner ?? target)?.symbols.length ?? 0;
  for (const parameter of [...call.inputs, ...call.outputs, ...call.inOuts])
    parameter.variable += offset;
  return info;
}

export function userFunctionCall(
  ctx: CheckerContext,
  node: AST.FunctionCall,
  pou: AST.Program,
  statement: boolean,
): ExpressionInfo | null {
  const parameters = pou.declarations
    .filter((declaration) => !isConstantDeclaration(declaration))
    .flatMap((declaration) =>
      declaration.names.map((name) => ({
        name,
        type: parameterType(ctx, pou, declaration),
        section: declaration.section,
      })),
    )
    .map((parameter, variable) => ({ ...parameter, variable }));
  const inputs = parameters.filter((parameter) => parameter.section === "VAR_INPUT");
  const outputs = parameters.filter((parameter) => parameter.section === "VAR_OUTPUT");
  const inOuts = parameters.filter((parameter) => parameter.section === "VAR_IN_OUT");
  const result = pou.resultType
    ? (ctx.interfaces.get(pou)?.result?.descriptor ??
      resolveDescriptor(
        ctx,
        pou.resultType,
        pou.resultSubrange,
        pou.resultStringLength,
        pou.resultArray,
        pou.resultReference,
      ) ??
      null)
    : null;
  if (!statement && result === null)
    report(ctx, "call.no-result", { name: node.name.name }, node.span);
  const call: UserCallInfo = {
    function: ctx.functionIds.get(pou.name.key)!,
    inputs: [],
    outputs: [],
    inOuts: [],
    result: result ? baseType(ctx, result, ctx.types) : null,
    ...(result ? { resultDescriptor: result } : {}),
  };
  ctx.userCalls.set(node, call);
  const invalid = (name: AST.Identifier) =>
    report(
      ctx,
      "call.invalid-parameter",
      { name: node.name.name, parameter: name.name },
      name.span,
    );
  const formal = node.inputNames !== undefined || node.args.length === 0;
  if (!formal) {
    if (outputs.length || inOuts.length)
      report(ctx, "call.formal-required", { name: node.name.name }, node.span);
    if (node.args.length !== inputs.length)
      report(
        ctx,
        "call.argument-count",
        { name: node.name.name, min: inputs.length, max: inputs.length, found: node.args.length },
        node.span,
      );
  }
  const seen = new Set<string>();
  node.args.forEach((value, index) => {
    const name = node.inputNames?.[index];
    const parameter = formal
      ? [...inputs, ...inOuts].find((input) => input.name.key === name?.key)
      : inputs[index];
    if (name && (!parameter || seen.has(name.key))) invalid(name);
    if (name) seen.add(name.key);
    const type = parameter?.type;
    if (parameter?.section === "VAR_IN_OUT") {
      if (type && inOutActual(ctx, value, type))
        call.inOuts.push({ variable: parameter.variable, actual: value });
      return;
    }
    const info = ctx.rules.expression(ctx, value, type);
    if (parameter && type) {
      if (info) assignment(ctx, type, info, value.span);
      call.inputs.push({
        variable: parameter.variable,
        value,
        dataType: baseType(ctx, type, ctx.types),
      });
    }
  });
  for (const output of node.outputs ?? []) {
    const parameter = outputs.find((item) => item.name.key === output.name.key);
    if (!parameter || seen.has(output.name.key)) invalid(output.name);
    seen.add(output.name.key);
    const target = checkReference(ctx, output.target, true);
    if (target) {
      ctx.expressions.set(output.target, target);
      if (parameter?.type) {
        assignment(
          ctx,
          target.descriptor ?? target.dataType,
          { dataType: baseType(ctx, parameter.type, ctx.types), descriptor: parameter.type },
          output.target.span,
        );
        call.outputs.push({ variable: parameter.variable, target: output.target });
      }
    }
  }
  requireInOuts(ctx, inOuts, seen, node);
  if (result === null) return statement ? { dataType: "BOOL" } : null;
  return { dataType: baseType(ctx, result, ctx.types), descriptor: result };
}

export function inOutActual(
  ctx: CheckerContext,
  value: AST.Expression,
  type: TypeDescriptor,
): value is AST.AssignmentTarget {
  if (!["name", "member", "field", "index", "dereference"].includes(value.kind)) {
    report(ctx, "call.in-out-variable", {}, value.span);
    return false;
  }
  const actual = value as AST.AssignmentTarget;
  const info = checkReference(ctx, actual, true);
  if (!info) return false;
  const forbiddenSelector = (node: AST.AssignmentTarget): boolean => {
    if (node.kind === "name") return false;
    if (node.kind === "index") return forbiddenSelector(node.array);
    if (node.kind === "dereference") return false;
    if (node.kind === "elementBit") return true;
    const selector = ctx.references.get(node.member);
    return (
      !!selector?.port ||
      selector?.bit !== undefined ||
      (node.kind === "field" && forbiddenSelector(node.object))
    );
  };
  if (forbiddenSelector(actual)) {
    report(ctx, "call.in-out-variable", {}, value.span);
    return false;
  }
  ctx.expressions.set(value, info);
  const formalArray = arrayType(type, ctx.types);
  const actualArray = arrayType(info.descriptor ?? info.dataType, ctx.types);
  const matches = formalArray?.dimensions.every((d) => d === "*")
    ? !!actualArray &&
      actualArray.dimensions.length === formalArray.dimensions.length &&
      sameScalarType(actualArray.element, formalArray.element, ctx.types)
    : sameScalarType(info.descriptor ?? info.dataType, type, ctx.types);
  if (!matches) {
    report(
      ctx,
      "call.in-out-type",
      { from: info.descriptor ?? info.dataType, to: type },
      value.span,
    );
    return false;
  }
  return true;
}

export function requireInOuts(
  ctx: CheckerContext,
  parameters: { name: AST.Identifier }[],
  seen: ReadonlySet<string>,
  node: AST.FunctionCall,
): void {
  for (const parameter of parameters)
    if (!seen.has(parameter.name.key))
      report(
        ctx,
        "call.missing-in-out",
        { name: node.name.name, parameter: parameter.name.name },
        node.span,
      );
}
