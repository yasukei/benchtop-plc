import { isFunctionBlockType as isBlock } from "@benchtop-plc/core";
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
      initialValue: Number(symbol.initialValue),
    };
  }

  private reference(
    node: AST.AssignmentTarget,
  ): IR.VariableReference | IR.FunctionBlockMemberReference {
    const dataType = required(this.checked.expressions.get(node)).dataType;
    if (node.kind === "name")
      return {
        kind: "variable",
        variable: required(this.checked.references.get(node.name)).variable,
        dataType,
        span: span(node),
      };
    const reference = required(this.checked.references.get(node.member));
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
    if (reference.kind === "variable") return reference;
    if (reference.port !== "input") throw new Error("Checked assignment targets an FB output");
    return { ...reference, port: "input" };
  }

  private expression(node: AST.Expression): IR.Expression {
    const info = required(this.checked.expressions.get(node));
    const base = { dataType: info.dataType, span: span(node) };
    switch (node.kind) {
      case "literal":
        // Only literal representation is normalized here. Executable operators stay in the tree.
        return info.dataType === "BOOL"
          ? {
              kind: "literal",
              dataType: "BOOL",
              value: Boolean(required(info.constant)),
              span: span(node),
            }
          : {
              ...base,
              kind: "literal",
              dataType: info.dataType,
              value: Number(required(info.constant)),
            };
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
      case "binary":
        return {
          ...base,
          kind: "binary",
          operator: node.operator,
          left: this.expression(node.left),
          right: this.expression(node.right),
        };
      case "functionCall":
        return {
          ...base,
          kind: "functionCall",
          function: required(this.checked.functions.get(node)),
          args: node.args.map((arg) => this.expression(arg)),
        };
    }
  }

  private integerConstant(node: AST.Expression): number {
    return Number(required(required(this.checked.expressions.get(node)).constant));
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
          value: this.expression(node.value),
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
        const label = (item: AST.CaseLabel): IR.CaseLabel =>
          item.kind === "value"
            ? { kind: "value", value: this.integerConstant(item.value), span: span(item) }
            : {
                kind: "range",
                lower: this.integerConstant(item.lower),
                upper: this.integerConstant(item.upper),
                span: span(item),
              };
        return {
          ...base,
          kind: "case",
          selector: this.expression(node.selector),
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
        if (dataType !== "INT" && dataType !== "UINT" && dataType !== "DINT")
          throw new Error("Checked FOR variable is not an integer");
        return {
          ...base,
          kind: "for",
          variable: { kind: "variable", variable, dataType, span: span(node.variable) },
          from: this.expression(node.from),
          to: this.expression(node.to),
          step: node.step
            ? this.expression(node.step)
            : { kind: "literal", dataType: "INT", value: 1, span: span(node.variable) },
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
