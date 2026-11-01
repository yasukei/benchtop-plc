import type { DiagnosticArgs } from "@benchtop-plc/core";
import {
  enumerationType,
  interfaceType,
  isAggregateType,
  isFunctionBlockType as isBlock,
  referenceLike,
  subrangeType,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import { isInteger } from "../type-rules.js";

import { assignment } from "./assignment.js";
import { blockCall, superBodyCall } from "./block-calls.js";
import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { failedPreset } from "./overloads.js";
import { checkReference, forControlWrite, resolve } from "./references.js";
import { aggregate, instanceReference, isEnum, isScalar } from "./type-identity.js";

export function condition(
  ctx: CheckerContext,
  node: AST.Expression,
  statement: DiagnosticArgs["type.condition-not-bool"]["statement"],
): void {
  const info = ctx.rules.expression(ctx, node, "BOOL");
  if (info && info.dataType !== "BOOL")
    report(ctx, "type.condition-not-bool", { statement }, node.span);
}

export function checkStatements(
  ctx: CheckerContext,
  statements: AST.Statement[],
  depth: number,
): void {
  for (const node of statements) {
    switch (node.kind) {
      case "assignment":
        checkAssignmentStatement(ctx, node);
        break;
      case "call":
        checkCallStatement(ctx, node);
        break;
      case "fbCall":
        checkFbCallStatement(ctx, node);
        break;
      case "if":
        node.branches.forEach((branch, index) => {
          condition(ctx, branch.condition, index === 0 ? "IF" : "ELSIF");
          checkStatements(ctx, branch.body, depth);
        });
        checkStatements(ctx, node.elseBody, depth);
        break;
      case "case":
        checkCaseStatement(ctx, node, depth);
        break;
      case "for":
        checkForStatement(ctx, node, depth);
        break;
      case "while":
        condition(ctx, node.condition, "WHILE");
        checkStatements(ctx, node.body, depth + 1);
        break;
      case "repeat":
        checkStatements(ctx, node.body, depth + 1);
        condition(ctx, node.until, "REPEAT");
        break;
      case "exit":
        if (depth === 0) report(ctx, "flow.exit-outside-loop", {}, node.span);
        break;
      case "return":
        break;
    }
  }
}

function checkAssignmentStatement(
  ctx: CheckerContext,
  node: Extract<AST.Statement, { kind: "assignment" }>,
): void {
  const failed = failedPreset(ctx, node.target);
  const target = checkReference(ctx, node.target, true),
    value = ctx.rules.expression(
      ctx,
      node.value,
      failed || node.attempt ? undefined : (target?.descriptor ?? target?.dataType),
    );
  if (target) ctx.expressions.set(node.target, target);
  if (node.attempt) {
    const variableSource = (value: AST.Expression): boolean =>
      value.kind === "group"
        ? variableSource(value.expression)
        : ["name", "member", "field", "index", "dereference"].includes(value.kind);
    if (
      !target ||
      !value ||
      !(
        interfaceType(target.descriptor ?? target.dataType, ctx.types) ||
        instanceReference(ctx, target.descriptor ?? target.dataType)
      ) ||
      !(
        value.nullReference ||
        instanceReference(ctx, value.descriptor ?? value.dataType) ||
        (variableSource(node.value) && interfaceType(value.descriptor ?? value.dataType, ctx.types))
      )
    )
      report(ctx, "interface.assignment-attempt", {}, node.span);
    return;
  }
  if (target && value && !failed)
    assignment(ctx, target.descriptor ?? target.dataType, value, node.value.span);
  return;
}

function checkCallStatement(
  ctx: CheckerContext,
  node: Extract<AST.Statement, { kind: "call" }>,
): void {
  if (node.call.name.key === "SUPER") {
    superBodyCall(ctx, node.call);
    return;
  }
  const symbol = ctx.names.get(node.call.name.key);
  if (
    (!node.call.receiver ||
      (node.call.receiver.kind === "name" &&
        node.call.receiver.name.key === "THIS" &&
        (ctx.ast.owner !== undefined || ["functionBlock", "class"].includes(ctx.ast.kind)))) &&
    (node.call.instance || (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined)))
  )
    blockCall(ctx, node.call);
  else {
    const info = ctx.rules.functionCall(ctx, node.call, true);
    if (info) ctx.expressions.set(node.call, info);
  }
  return;
}

function checkFbCallStatement(
  ctx: CheckerContext,
  node: Extract<AST.Statement, { kind: "fbCall" }>,
): void {
  if (node.instance.key === "SUPER") {
    superBodyCall(ctx, node);
    return;
  }
  const call: AST.FunctionCall = {
    kind: "functionCall",
    name: node.instance,
    args: node.inputs.map((input) => input.value),
    inputNames: node.inputs.map((input) => input.name),
    span: node.span,
  };
  if (
    ctx.pous.has(node.instance.key) ||
    (ctx.ast.owner ?? ctx.ast).methods?.some((m) => m.name.key === node.instance.key) ||
    node.instance.key === "THIS"
  ) {
    ctx.rules.functionCall(ctx, call, true);
    const info = ctx.userCalls.get(call);
    if (info) {
      ctx.userCalls.delete(call);
      ctx.userCalls.set(node, info);
    }
  } else {
    blockCall(ctx, call);
    const bindings = ctx.blockInOuts.get(call);
    if (bindings) {
      ctx.blockInOuts.delete(call);
      ctx.blockInOuts.set(node, bindings);
    }
  }
  return;
}

function checkCaseStatement(
  ctx: CheckerContext,
  node: Extract<AST.Statement, { kind: "case" }>,
  depth: number,
): void {
  const selector = ctx.rules.expression(ctx, node.selector);
  if (
    selector &&
    (!isInteger(selector.dataType) ||
      aggregate(ctx, selector) ||
      referenceLike(selector.descriptor ?? selector.dataType, ctx.types))
  )
    report(ctx, "type.case-selector-not-integer", { type: selector.dataType }, node.selector.span);
  for (const branch of node.branches) {
    for (const label of branch.labels)
      for (const value of label.kind === "value" ? [label.value] : [label.lower, label.upper]) {
        const info = ctx.rules.expression(ctx, value, selector?.descriptor ?? selector?.dataType);
        if (!info) continue;
        if (!isInteger(info.dataType))
          report(ctx, "type.case-label-not-integer", { type: info.dataType }, value.span);
        else {
          if (selector && isInteger(selector.dataType))
            assignment(ctx, selector.descriptor ?? selector.dataType, info, value.span);
          if (selector && isEnum(ctx, selector) && label.kind === "range")
            report(ctx, "type.invalid-constant", {}, label.span);
          if (info.constant === undefined)
            report(ctx, "type.case-label-not-constant", {}, value.span);
        }
      }
    checkStatements(ctx, branch.body, depth);
  }
  checkStatements(ctx, node.elseBody, depth);
  return;
}

function checkForStatement(
  ctx: CheckerContext,
  node: Extract<AST.Statement, { kind: "for" }>,
  depth: number,
): void {
  const constant = ctx.constants.has(node.variable.key);
  if (constant)
    report(ctx, "decl.constant-not-writable", { name: node.variable.name }, node.variable.span);
  const symbol = constant ? null : resolve(ctx, node.variable);
  if (symbol) {
    if (symbol === ctx.state.result) ctx.state.resultMayBeAssigned = true;
    forControlWrite(ctx, symbol, node.variable);
    if (!isScalar(symbol.type))
      report(ctx, "fb.instance-as-value", { name: node.variable.name }, node.variable.span);
    else if (symbol.descriptor && subrangeType(symbol.descriptor, ctx.types))
      report(
        ctx,
        "type.for-variable-subrange",
        { name: node.variable.name, type: symbol.descriptor },
        node.variable.span,
      );
    else if (
      !isInteger(symbol.type) ||
      (symbol.descriptor &&
        (enumerationType(symbol.descriptor, ctx.types) ||
          referenceLike(symbol.descriptor, ctx.types) ||
          isAggregateType(symbol.descriptor, ctx.types)))
    )
      report(
        ctx,
        "type.for-variable-not-integer",
        { name: node.variable.name, type: symbol.descriptor ?? symbol.type },
        node.variable.span,
      );
  }
  for (const bound of ["from", "to", "step"] as const) {
    const value = node[bound];
    if (!value) continue;
    const type =
      symbol && isScalar(symbol.type) && isInteger(symbol.type) ? symbol.type : undefined;
    const info = ctx.rules.expression(ctx, value, type);
    if (info && type && isInteger(info.dataType) && !aggregate(ctx, info))
      assignment(ctx, type, info, value.span);
    if (info && (!isInteger(info.dataType) || isEnum(ctx, info) || aggregate(ctx, info)))
      report(ctx, "type.for-bound-not-integer", { bound, type: info.dataType }, value.span);
  }
  const alreadyActive = symbol && ctx.activeForVariables.has(symbol.id);
  if (symbol) ctx.activeForVariables.add(symbol.id);
  checkStatements(ctx, node.body, depth + 1);
  if (symbol && !alreadyActive) ctx.activeForVariables.delete(symbol.id);
  return;
}
