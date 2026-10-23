import {
  coerceValue,
  arrayType,
  structureType,
  isAggregateType,
  arrayIndices,
  scalarBase,
  enumerationType,
  isCalendarType,
  getStandardFunctionSignature,
  isLongType,
  isIntegerType,
  isFunctionBlockType as isBlock,
} from "@benchtop-plc/core";
import { commonType, stringArgumentType } from "./type-rules.js";
import type * as IR from "@benchtop-plc/core";
import type * as AST from "./ast.js";
import { rootName } from "./ast.js";
import type { CheckedProgram, UserCallInfo } from "./checked.js";

/** Missing side-table entries indicate a compiler bug, never a source diagnostic. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Incomplete checked AST");
  return value;
}

const span = (node: IR.SourceNode): IR.SourceSpan => ({ ...node.span });

class Lowerer {
  constructor(private readonly checked: CheckedProgram) {}

  run(): Omit<IR.ProgramIR, "variables"> & { variables: IR.LocalVariable[] } {
    const ast = this.checked.ast;
    return {
      kind: "program",
      name: ast.name.name,
      span: span(ast),
      variables: ast.declarations
        .filter((declaration) => !declaration.constant)
        .flatMap((declaration) => declaration.names.map((name) => this.variable(declaration, name)))
        .concat(
          this.checked.result
            ? [
                {
                  kind: "scalar",
                  name: ast.name.name,
                  key: ast.name.key,
                  span: span(ast.name),
                  dataType: this.checked.result.descriptor ?? this.checked.result.type,
                  initialValue: this.checked.result.initialValue,
                } as IR.ScalarVariable,
              ]
            : [],
        ),
      body: this.statements(ast.body),
    };
  }

  private userCall(node: IR.SourceNode, call: UserCallInfo): IR.UserFunctionCall {
    return {
      kind: "userFunctionCall",
      function: call.function,
      dataType: call.resultDescriptor ?? call.result,
      span: span(node),
      inputs: call.inputs.map((input) => ({
        variable: input.variable,
        value: this.widen(this.expression(input.value), input.dataType),
      })),
      ...(call.inOuts.length ? { inOuts: this.inOutBindings(call.inOuts) } : {}),
      outputs: call.outputs.map((output) => ({
        variable: output.variable,
        target: this.target(output.target),
      })),
    };
  }

  private inOutBindings(bindings: UserCallInfo["inOuts"]): IR.InOutBinding[] {
    return bindings.map(({ variable, actual }) => {
      const reference = this.reference(actual);
      if (reference.kind !== "variable") throw new Error("Checked in-out is not a variable");
      return { variable, actual: reference };
    });
  }

  private variable(declaration: AST.Declaration, name: AST.Identifier): IR.LocalVariable {
    const id = required(this.checked.references.get(name)).variable;
    const symbol = required(this.checked.symbols[id]);
    const base = { name: name.name, key: name.key, span: span(declaration) };
    if (symbol.descriptor && isAggregateType(symbol.descriptor, this.checked.types))
      return {
        ...base,
        kind: structureType(symbol.descriptor, this.checked.types) ? "structure" : "array",
        dataType: symbol.descriptor,
        initialValue: required(symbol.aggregateValues),
      } as IR.ArrayVariable | IR.StructureVariable;
    if (symbol.userBlock !== undefined)
      return { ...base, kind: "userFunctionBlock", block: symbol.userBlock, initialValue: null };
    if (isBlock(symbol.type))
      return { ...base, kind: "functionBlock", fbType: symbol.type, initialValue: null };
    if (symbol.type === "BOOL") {
      const address = declaration.address;
      return {
        ...base,
        kind: "scalar",
        dataType: "BOOL",
        initialValue: Boolean(symbol.initialValue),
        ...(address
          ? // The checker has already restricted direct addresses to byte 0, bits 0–7.
            { address: { area: address.area, byte: 0 as const, bit: address.bit as IR.IoBit } }
          : {}),
      };
    }
    return {
      ...base,
      kind: "scalar",
      dataType: symbol.descriptor ?? (symbol.type as IR.DataType),
      initialValue: coerceValue(
        symbol.type as IR.DataType,
        required(symbol.initialValue ?? undefined),
      ),
    } as IR.ScalarVariable;
  }

  private reference(
    node: AST.AssignmentTarget,
  ):
    | IR.StructureMemberReference
    | IR.IndexReference
    | IR.ElementBitReference
    | IR.VariableReference
    | IR.BitReference
    | IR.FunctionBlockMemberReference
    | IR.UserFunctionBlockMemberReference {
    const info = required(this.checked.expressions.get(node));
    const dataType = info.descriptor ?? info.dataType;
    if (node.kind === "index") {
      const array = this.reference(node.array);
      if (array.kind !== "variable" && array.kind !== "index" && array.kind !== "structureMember")
        throw new Error("Checked array base");
      return {
        kind: "index",
        ...(typeof dataType !== "string" && dataType.kind === "functionBlock"
          ? {
              instanceName:
                this.checked.symbols[this.checked.references.get(rootName(node))!.variable]!.name
                  .key,
            }
          : {}),
        array,
        indices: node.indices.map((index) => this.expression(index)),
        dataType,
        span: span(node),
      };
    }
    if (
      (node.kind === "field" && !this.checked.references.get(node.member)?.port) ||
      (node.kind === "member" && this.checked.references.get(node.member)?.structure)
    ) {
      const selector = required(this.checked.references.get(node.member));
      const object =
        node.kind === "field"
          ? this.reference(node.object)
          : {
              kind: "variable" as const,
              variable: required(this.checked.references.get(node.instance)).variable,
              dataType: required(
                this.checked.symbols[required(this.checked.references.get(node.instance)).variable],
              ).descriptor!,
              span: span(node.instance),
            };
      if (
        object.kind !== "variable" &&
        object.kind !== "index" &&
        object.kind !== "structureMember"
      )
        throw new Error("Checked structure base");
      return selector.bit !== undefined
        ? {
            kind: "elementBit",
            element: object as IR.IndexReference | IR.StructureMemberReference,
            bit: selector.bit,
            dataType: "BOOL",
            span: span(node),
          }
        : {
            kind: "structureMember",
            object,
            member: required(selector.member),
            dataType,
            span: span(node),
          };
    }
    if (node.kind === "elementBit") {
      const element = this.reference(node.element);
      if (element.kind !== "index") throw new Error("Checked element");
      return {
        kind: "elementBit",
        element,
        bit: required(this.checked.references.get(node.member)?.bit),
        dataType: "BOOL",
        span: span(node),
      };
    }
    if (node.kind === "name")
      return {
        kind: "variable",
        variable: required(this.checked.references.get(node.name)).variable,
        dataType,
        span: span(node),
      };
    const reference = required(this.checked.references.get(node.member));
    if (reference.bit !== undefined)
      return {
        kind: "bit",
        variable: reference.variable,
        bit: reference.bit,
        dataType: "BOOL",
        span: span(node),
      };
    const member = {
      variable: reference.variable,
      ...(node.kind === "field"
        ? { instance: this.reference(node.object) as IR.IndexReference }
        : {}),
      port: required(reference.port),
      member: required(reference.member),
      dataType,
      span: span(node),
    };
    return reference.userBlock
      ? { kind: "userFbMember", ...member }
      : { kind: "fbMember", ...member };
  }

  private target(node: AST.AssignmentTarget): IR.AssignmentTarget {
    const reference = this.reference(node);
    if (
      reference.kind === "variable" ||
      reference.kind === "bit" ||
      reference.kind === "index" ||
      reference.kind === "structureMember" ||
      reference.kind === "elementBit"
    )
      return reference;
    if (reference.port !== "input") throw new Error("Checked assignment targets an FB output");
    return { ...reference, port: "input" };
  }

  private widen(expression: IR.Expression, target: IR.TypeDescriptor): IR.Expression {
    if (
      isAggregateType(target, this.checked.types) ||
      isAggregateType(expression.dataType, this.checked.types)
    )
      return expression;
    const to = scalarBase(target, this.checked.types);
    const from = scalarBase(expression.dataType, this.checked.types);
    if (!isLongType(to) || from === to) return expression;
    return {
      kind: "functionCall",
      function: `${from}_TO_${to}` as IR.ConversionFunction,
      args: [expression],
      dataType: to,
      span: { ...expression.span },
    };
  }

  private usesNamedConstant(node: AST.Expression): boolean {
    switch (node.kind) {
      case "structureInitializer":
      case "arrayInitializer":
      case "index":
      case "field":
      case "elementBit":
        return false;
      case "name":
      case "member":
        return this.checked.expressions.get(node)?.constant !== undefined;
      case "unary":
        return this.usesNamedConstant(node.operand);
      case "binary":
        return this.usesNamedConstant(node.left) || this.usesNamedConstant(node.right);
      case "group":
        return this.usesNamedConstant(node.expression);
      case "functionCall":
        return node.args.some((arg) => this.usesNamedConstant(arg));
      case "enumeration":
        return true;
      case "literal":
        return false;
    }
  }

  private expression(node: AST.Expression): IR.Expression {
    const info = required(this.checked.expressions.get(node));
    const base = { dataType: info.descriptor ?? info.dataType, span: span(node) };
    const literal = (): IR.LiteralExpression =>
      ({
        ...base,
        kind: "literal",
        value: coerceValue(info.dataType, required(info.constant)),
      }) as IR.LiteralExpression;
    if (
      info.untyped ||
      (info.constant !== undefined &&
        (this.usesNamedConstant(node) ||
          enumerationType(info.descriptor ?? info.dataType, this.checked.types)))
    )
      return literal();
    switch (node.kind) {
      case "enumeration":
      case "literal":
        return literal();
      case "structureInitializer":
      case "arrayInitializer":
        throw new Error("Initializer is not a body expression");
      case "index":
      case "field":
      case "elementBit":
      case "name":
      case "member":
        return this.reference(node);
      case "group":
        // IR has no grouping node; its root retains the full parenthesized source construct.
        return { ...this.expression(node.expression), span: span(node) };
      case "unary":
        return {
          ...base,
          kind: "unary",
          operator: node.operator,
          operand: this.expression(node.operand),
        };
      case "binary": {
        const left = this.expression(node.left),
          right = this.expression(node.right);
        const leftType = scalarBase(left.dataType, this.checked.types),
          rightType = scalarBase(right.dataType, this.checked.types);
        const scaling =
          (node.operator === "*" || node.operator === "/") &&
          (left.dataType === "TIME" || left.dataType === "LTIME");
        const common =
          node.operator === "**" || scaling || isCalendarType(leftType)
            ? null
            : commonType([leftType, rightType]);
        return {
          ...base,
          kind: "binary",
          operator: node.operator,
          left: common ? this.widen(left, common) : left,
          right: common ? this.widen(right, common) : right,
        };
      }
      case "functionCall": {
        const user = this.checked.userCalls.get(node);
        if (user) {
          const call = this.userCall(node, user);
          if (call.dataType === null) throw new Error("Checked expression has no result");
          return { ...call, dataType: call.dataType };
        }
        const name = required(this.checked.functions.get(node));
        const inputs = required(this.checked.functionArguments.get(node));
        const signature = getStandardFunctionSignature(name);
        const start = signature.genericStart;
        const argumentTypes = inputs.map((arg, index) =>
          stringArgumentType(
            required(this.checked.expressions.get(arg)).dataType,
            signature.arguments[Math.min(index, signature.arguments.length - 1)]!,
          ),
        );
        const common =
          start === undefined ? null : commonType(argumentTypes.slice(start, signature.genericEnd));
        return {
          ...base,
          kind: "functionCall",
          function: name,
          ...(node.inputNames
            ? { evaluationOrder: node.args.map((arg) => inputs.indexOf(arg)) }
            : {}),
          ...(node.outputs?.length
            ? {
                outputs: node.outputs.map((output) => ({
                  output: required(signature.outputs).findIndex(
                    ([name]) => name === output.name.key,
                  ),
                  target: this.target(output.target),
                  span: span(output),
                })),
              }
            : {}),
          args: inputs.map((arg, index) => {
            const expression = this.expression(arg);
            const accepted = signature.arguments[Math.min(index, signature.arguments.length - 1)];
            if (
              start !== undefined &&
              index >= start &&
              index < (signature.genericEnd ?? inputs.length) &&
              common
            )
              return this.widen(expression, common);
            if (accepted?.length === 1) return this.widen(expression, accepted[0]!);
            return this.widen(expression, argumentTypes[index]!);
          }),
        };
      }
    }
  }

  private blockCall(
    node: AST.FunctionCall | AST.FunctionBlockCall,
  ): IR.FunctionBlockCallStatement | IR.UserFunctionBlockCallStatement {
    const name = node.kind === "fbCall" ? node.instance : node.name;
    const variable = required(this.checked.references.get(name)).variable;
    const symbol = required(this.checked.symbols[variable]);
    const inputs =
      node.kind === "fbCall"
        ? node.inputs
        : node.args.map((value, index) => ({
            name: node.inputNames![index]!,
            value,
            span: {
              ...node.inputNames![index]!.span,
              endLine: value.span.endLine,
              endColumn: value.span.endColumn,
            },
          }));
    const inOuts = this.checked.blockInOuts.get(node) ?? [];
    return {
      ...(inOuts.length ? { inOuts: this.inOutBindings(inOuts) } : {}),
      span: span(node),
      kind: symbol.userBlock === undefined ? "fbCall" : "userFbCall",
      variable,
      ...(node.kind === "functionCall" && node.instance
        ? { instance: this.reference(node.instance) as IR.IndexReference }
        : {}),
      inputs: inputs
        .filter((input) => !inOuts.some((binding) => binding.actual === input.value))
        .map((input) => {
          const reference = required(this.checked.references.get(input.name));
          const expected = required(this.checked.blockInputTypes.get(input.name));
          return {
            name: input.name.key,
            input: required(reference.member),
            value: this.widen(this.expression(input.value), expected),
            span: span(input),
          };
        }),
      ...(node.kind === "functionCall" && node.outputs?.length
        ? {
            outputs: node.outputs.map((output) => ({
              output: required(required(this.checked.references.get(output.name)).member),
              target: this.target(output.target),
              span: span(output),
            })),
          }
        : {}),
    };
  }

  private integerConstant(node: AST.Expression, target: IR.TypeDescriptor): number | string {
    const info = required(this.checked.expressions.get(node));
    const to = scalarBase(target, this.checked.types);
    return isLongType(to)
      ? coerceValue(to, required(info.constant))
      : Number(required(info.constant));
  }

  private statements(nodes: AST.Statement[]): IR.Statement[] {
    return nodes.map((node) => this.statement(node));
  }

  private statement(node: AST.Statement): IR.Statement {
    const base = { span: span(node) };
    switch (node.kind) {
      case "assignment":
        return {
          ...base,
          kind: "assignment",
          target: this.target(node.target),
          value: this.widen(this.expression(node.value), this.target(node.target).dataType),
        };
      case "call": {
        const resolved = this.checked.references.get(node.call.name);
        const symbol = resolved && this.checked.symbols[resolved.variable];
        if (
          node.call.instance ||
          (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined))
        )
          return { ...this.blockCall(node.call), span: span(node) };
        const user = this.checked.userCalls.get(node.call);
        if (user) return { ...base, kind: "call", call: this.userCall(node.call, user) };
        const call = this.expression(node.call);
        if (call.kind !== "functionCall") throw new Error("Expected a checked function call");
        return { ...base, kind: "call", call };
      }
      case "fbCall": {
        const user = this.checked.userCalls.get(node);
        if (user) return { ...base, kind: "call", call: this.userCall(node, user) };
        return this.blockCall(node);
      }
      case "if": {
        const branch = (arm: AST.ConditionalBranch): IR.ConditionalBranch => ({
          condition: this.expression(arm.condition),
          body: this.statements(arm.body),
          span: span(arm),
        });
        return {
          ...base,
          kind: "if",
          branches: [branch(node.branches[0]), ...node.branches.slice(1).map(branch)],
          elseBody: this.statements(node.elseBody),
        };
      }
      case "case": {
        const selector = this.expression(node.selector);
        const label = (item: AST.CaseLabel): IR.CaseLabel =>
          item.kind === "value"
            ? {
                kind: "value",
                value: this.integerConstant(item.value, selector.dataType),
                span: span(item),
              }
            : {
                kind: "range",
                lower: this.integerConstant(item.lower, selector.dataType),
                upper: this.integerConstant(item.upper, selector.dataType),
                span: span(item),
              };
        return {
          ...base,
          kind: "case",
          selector,
          branches: node.branches.map((arm) => ({
            labels: [label(arm.labels[0]), ...arm.labels.slice(1).map(label)],
            body: this.statements(arm.body),
            span: span(arm),
          })),
          elseBody: this.statements(node.elseBody),
        };
      }
      case "for": {
        const variable = required(this.checked.references.get(node.variable)).variable;
        const dataType = required(this.checked.symbols[variable]).type;
        if (!isIntegerType(dataType)) throw new Error("Checked FOR variable is not an integer");
        return {
          ...base,
          kind: "for",
          variable: { kind: "variable", variable, dataType, span: span(node.variable) },
          from: this.expression(node.from),
          to: this.expression(node.to),
          step: node.step
            ? this.expression(node.step)
            : ({
                kind: "literal",
                dataType,
                value: coerceValue(dataType, 1),
                span: span(node.variable),
              } as IR.LiteralExpression),
          body: this.statements(node.body),
        };
      }
      case "while":
        return {
          ...base,
          kind: "while",
          condition: this.expression(node.condition),
          body: this.statements(node.body),
        };
      case "repeat":
        return {
          ...base,
          kind: "repeat",
          body: this.statements(node.body),
          until: this.expression(node.until),
        };
      case "exit":
      case "return":
        return { ...base, kind: node.kind };
    }
  }
}

function sections(checked: CheckedProgram): AST.Declaration["section"][] {
  return checked.ast.declarations
    .filter((declaration) => !declaration.constant)
    .flatMap((declaration) => declaration.names.map(() => declaration.section));
}

export function lowerFunctionBlock(checked: CheckedProgram): IR.UserFunctionBlockIR {
  const ir = new Lowerer(checked).run();
  const parameters = sections(checked);
  return {
    name: ir.name,
    span: ir.span,
    body: ir.body,
    variables: ir.variables,
    inputs: parameters.flatMap((section, index) => (section === "VAR_INPUT" ? [index] : [])),
    outputs: parameters.flatMap((section, index) => (section === "VAR_OUTPUT" ? [index] : [])),
    ...(parameters.includes("VAR_IN_OUT")
      ? {
          inOuts: parameters.flatMap((section, index) => (section === "VAR_IN_OUT" ? [index] : [])),
        }
      : {}),
    temporaries: parameters.flatMap((section, index) => (section === "VAR_TEMP" ? [index] : [])),
  };
}

/** Expand storage only: every body remains shared in its POU definition. */
export function lower(
  checked: CheckedProgram,
  blocks: IR.UserFunctionBlockIR[] = [],
): IR.ProgramIR {
  const layout = new Lowerer(checked).run();
  const variables: IR.Variable[] = [];
  const instances: IR.UserFunctionBlockStorage[] = [];
  const composites: NonNullable<IR.ProgramIR["composites"]> = [];
  const allocate = (
    locals: IR.LocalVariable[],
    temporaries: readonly number[],
    inOuts: readonly number[],
    prefix: string,
  ): IR.InstanceStorage[] =>
    locals.map((variable, slot) => {
      if (inOuts.includes(slot)) return { kind: "inOut" };
      if (temporaries.includes(slot)) {
        if (
          variable.kind !== "scalar" &&
          variable.kind !== "array" &&
          variable.kind !== "structure"
        )
          throw new Error("Checked temporary is an instance");
        return { kind: "temporary", variable };
      }
      const path = prefix + variable.key;
      if (variable.kind === "userFunctionBlock") {
        const definition = required(blocks[variable.block]);
        const instance = instances.length;
        const storage: IR.UserFunctionBlockStorage = { block: variable.block, path, storage: [] };
        instances.push(storage);
        storage.storage = allocate(
          definition.variables,
          definition.temporaries,
          definition.inOuts ?? [],
          `${path}.`,
        );
        return { kind: "instance", instance };
      }
      if (variable.kind === "array" || variable.kind === "structure") {
        const expand = (
          type: IR.TypeDescriptor,
          initial: IR.InitialValue,
          segments: string[],
        ): IR.InstanceStorage => {
          const array = arrayType(type, checked.types);
          const structure = structureType(type, checked.types);
          if (array || structure) {
            composites.push({
              name: segments.reduce(
                (path, segment) => path + (segment.startsWith("[") || !path ? "" : ".") + segment,
                "",
              ),
              path: segments,
              dataType: type,
            });
            return {
              kind: structure ? "structure" : "array",
              dataType: type,
              elements: (initial as IR.InitialValue[]).map((value, index) =>
                expand(structure ? structure.members[index]!.dataType : array!.element, value, [
                  ...segments,
                  structure
                    ? structure.members[index]!.name.toUpperCase()
                    : `[${arrayIndices(array!, index).join(",")}]`,
                ]),
              ),
            };
          }
          const id = variables.length;
          const name = segments.reduce(
            (path, segment) => path + (segment.startsWith("[") || !path ? "" : ".") + segment,
            "",
          );
          if (typeof type !== "string" && type.kind === "functionBlock") {
            const leaf =
              type.block !== undefined
                ? { kind: "userFunctionBlock" as const, block: type.block, initialValue: null }
                : {
                    kind: "functionBlock" as const,
                    fbType: type.name as IR.FunctionBlockType,
                    initialValue: null,
                  };
            return allocate([{ ...leaf, name, key: name, span: span(variable) }], [], [], "")[0]!;
          }
          variables.push({
            kind: "scalar",
            name,
            key: name.toUpperCase(),
            path: segments,
            dataType: type,
            initialValue: initial,
            span: span(variable),
          } as IR.ScalarVariable);
          return { kind: "variable", variable: id };
        };
        return expand(
          variable.dataType,
          variable.initialValue,
          path.match(/[^.[\]]+|\[[^\]]+\]/g)!,
        );
      }
      const id = variables.length;
      const segments = path.match(/[^.[\]]+|\[[^\]]+\]/g)!;
      variables.push(
        path.includes("[")
          ? { ...variable, name: path, key: path, path: segments }
          : prefix
            ? { ...variable, name: path, key: path }
            : variable,
      );
      return { kind: "variable", variable: id };
    });
  const temporarySlots = sections(checked).flatMap((section, index) =>
    section === "VAR_TEMP" ? [index] : [],
  );
  const storage = allocate(layout.variables, temporarySlots, [], "");
  return {
    kind: "program",
    name: layout.name,
    span: layout.span,
    ...(checked.types.length
      ? { types: JSON.parse(JSON.stringify(checked.types)) as IR.TypeTable }
      : {}),
    variables,
    ...(composites.length ? { composites } : {}),
    body: layout.body,
    ...(blocks.length ? { functionBlocks: blocks } : {}),
    ...(instances.length ||
    temporarySlots.length ||
    layout.variables.some((v) => v.kind === "array" || v.kind === "structure")
      ? { storage, instances }
      : {}),
  };
}

export function lowerFunction(checked: CheckedProgram): IR.UserFunctionIR {
  const ir = new Lowerer(checked).run();
  const parameters = sections(checked);
  return {
    name: ir.name,
    span: ir.span,
    body: ir.body,
    variables: ir.variables.map((variable) => {
      if (variable.kind !== "scalar" && variable.kind !== "array" && variable.kind !== "structure")
        throw new Error("Checked function contains an FB");
      return variable;
    }),
    inputs: parameters.flatMap((section, index) => (section === "VAR_INPUT" ? [index] : [])),
    outputs: parameters.flatMap((section, index) => (section === "VAR_OUTPUT" ? [index] : [])),
    ...(parameters.includes("VAR_IN_OUT")
      ? {
          inOuts: parameters.flatMap((section, index) => (section === "VAR_IN_OUT" ? [index] : [])),
        }
      : {}),
    ...(checked.result ? { result: checked.result.id } : {}),
  };
}
