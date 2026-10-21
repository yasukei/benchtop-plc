import {
  coerceValue,
  isCalendarType,
  getStandardFunctionSignature,
  isLongType,
  isIntegerType,
  isFunctionBlockType as isBlock,
} from "@benchtop-plc/core";
import { commonType } from "./type-rules.js";
import type * as IR from "@benchtop-plc/core";
import type * as AST from "./ast.js";
import type { CheckedProgram } from "./checked.js";

/** Missing side-table entries indicate a compiler bug, never a source diagnostic. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Incomplete checked AST");
  return value;
}

const span = (node: IR.SourceNode): IR.SourceSpan => ({ ...node.span });

class Lowerer {
  constructor(private readonly checked: CheckedProgram) {}

  run(): IR.ProgramIR {
    const ast = this.checked.ast;
    return {
      kind: "program",
      name: ast.name.name,
      span: span(ast),
      variables: ast.declarations.flatMap((declaration) =>
        declaration.names.map((name) => this.variable(declaration, name)),
      ),
      body: this.statements(ast.body),
    };
  }

  private variable(declaration: AST.Declaration, name: AST.Identifier): IR.Variable {
    const id = required(this.checked.references.get(name)).variable;
    const symbol = required(this.checked.symbols[id]);
    const base = { name: name.name, key: name.key, span: span(declaration) };
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
      dataType: symbol.type,
      initialValue: coerceValue(symbol.type, required(symbol.initialValue ?? undefined)),
    } as IR.ScalarVariable;
  }

  private reference(
    node: AST.AssignmentTarget,
  ): IR.VariableReference | IR.BitReference | IR.FunctionBlockMemberReference {
    const dataType = required(this.checked.expressions.get(node)).dataType;
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
    return {
      kind: "fbMember",
      variable: reference.variable,
      port: required(reference.port),
      member: required(reference.member),
      dataType,
      span: span(node),
    };
  }

  private target(node: AST.AssignmentTarget): IR.AssignmentTarget {
    const reference = this.reference(node);
    if (reference.kind === "variable" || reference.kind === "bit") return reference;
    if (reference.port !== "input") throw new Error("Checked assignment targets an FB output");
    return { ...reference, port: "input" };
  }

  private widen(expression: IR.Expression, to: IR.DataType): IR.Expression {
    if (!isLongType(to) || expression.dataType === to) return expression;
    return {
      kind: "functionCall",
      function: `${expression.dataType}_TO_${to}` as IR.ConversionFunction,
      args: [expression],
      dataType: to,
      span: { ...expression.span },
    };
  }

  private expression(node: AST.Expression): IR.Expression {
    const info = required(this.checked.expressions.get(node));
    const base = { dataType: info.dataType, span: span(node) };
    const literal = (): IR.LiteralExpression =>
      ({
        ...base,
        kind: "literal",
        value: coerceValue(info.dataType, required(info.constant)),
      }) as IR.LiteralExpression;
    if (info.untyped) return literal();
    switch (node.kind) {
      case "literal":
        return literal();
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
        const scaling =
          (node.operator === "*" || node.operator === "/") &&
          (left.dataType === "TIME" || left.dataType === "LTIME");
        const common =
          node.operator === "**" || scaling || isCalendarType(left.dataType)
            ? null
            : commonType([left.dataType, right.dataType]);
        return {
          ...base,
          kind: "binary",
          operator: node.operator,
          left: common ? this.widen(left, common) : left,
          right: common ? this.widen(right, common) : right,
        };
      }
      case "functionCall": {
        const name = required(this.checked.functions.get(node));
        const signature = getStandardFunctionSignature(name);
        const start = signature.genericStart;
        const common =
          start === undefined
            ? null
            : commonType(
                node.args
                  .slice(start)
                  .map((arg) => required(this.checked.expressions.get(arg)).dataType),
              );
        return {
          ...base,
          kind: "functionCall",
          function: name,
          args: node.args.map((arg, index) => {
            const expression = this.expression(arg);
            const accepted = signature.arguments[Math.min(index, signature.arguments.length - 1)];
            if (start !== undefined && index >= start && common)
              return this.widen(expression, common);
            if (accepted?.length === 1) return this.widen(expression, accepted[0]!);
            return expression;
          }),
        };
      }
    }
  }

  private integerConstant(node: AST.Expression, to: IR.DataType): number | string {
    const info = required(this.checked.expressions.get(node));
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
      case "fbCall":
        return {
          ...base,
          kind: "fbCall",
          variable: required(this.checked.references.get(node.instance)).variable,
          inputs: node.inputs.map((input) => ({
            name: input.name.key,
            input: required(required(this.checked.references.get(input.name)).member),
            value: this.expression(input.value),
            span: span(input),
          })),
        };
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

/** Lower only a successful check result; semantic Maps never escape into the plain-data IR. */
export function lower(checked: CheckedProgram): IR.ProgramIR {
  return new Lowerer(checked).run();
}
