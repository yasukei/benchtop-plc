import { coerceValue } from "@benchtop-plc/core";
import type {
  BinaryOperator,
  Diagnostic,
  Expression,
  ScalarValue,
  SourceSpan,
  Statement,
  StatementAnnotation,
  TypedValue,
} from "@benchtop-plc/core";
import type { RuntimeLibrary } from "./library.js";
import { Memory } from "./memory.js";

export const WATCHDOG_LIMIT = 200_000;
export class RuntimeFault extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.code);
  }
}

function binary(operator: BinaryOperator, left: ScalarValue, right: ScalarValue): ScalarValue {
  const a = Number(left),
    b = Number(right);
  switch (operator) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "MOD":
      return b === 0 ? 0 : a % b;
    case "AND":
      return typeof left === "boolean" ? left && Boolean(right) : a & b;
    case "OR":
      return typeof left === "boolean" ? left || Boolean(right) : a | b;
    case "XOR":
      return typeof left === "boolean" ? left !== right : a ^ b;
    case "=":
      return left === right;
    case "<>":
      return left !== right;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
  }
}

type Flow = "exit" | "return" | "abort" | undefined;

export class Interpreter {
  private iterations = 0;
  private readonly annotations = new Map<Statement, StatementAnnotation>();

  constructor(
    private readonly memory: Memory,
    private readonly scanStart: number,
    private readonly active: () => boolean,
    private readonly library?: RuntimeLibrary,
  ) {}

  private fault(code: "runtime.division-by-zero" | "runtime.for-by-zero", span: SourceSpan): never {
    throw new RuntimeFault({ code, severity: "error", span, args: {} });
  }

  private iteration(span: SourceSpan): void {
    if (++this.iterations > WATCHDOG_LIMIT) {
      throw new RuntimeFault({
        code: "runtime.watchdog",
        severity: "error",
        span,
        args: { limit: WATCHDOG_LIMIT },
      });
    }
  }

  expression(expr: Expression): ScalarValue {
    try {
      return this.evaluate(expr);
    } catch (error) {
      if (error instanceof RangeError)
        throw new RuntimeFault({
          code: "runtime.invalid-value",
          severity: "error",
          span: expr.span,
          args: {},
        });
      throw error;
    }
  }

  private evaluate(expr: Expression): ScalarValue {
    switch (expr.kind) {
      case "literal":
        return expr.value;
      case "variable":
      case "fbMember":
        return this.memory.value(expr).value;
      case "unary": {
        const value = this.expression(expr.operand);
        const result =
          expr.operator === "+"
            ? Number(value)
            : expr.operator === "-"
              ? -Number(value)
              : typeof value === "boolean"
                ? !value
                : ~value;
        return coerceValue(expr.dataType, result);
      }
      case "binary": {
        const left = this.expression(expr.left),
          right = this.expression(expr.right);
        if (expr.operator === "/" && Number(right) === 0) {
          this.fault("runtime.division-by-zero", expr.span);
        }
        return coerceValue(expr.dataType, binary(expr.operator, left, right));
      }
      case "functionCall": {
        if (!this.library) throw new Error("A runtime library is required for functions");
        return coerceValue(
          expr.dataType,
          this.library.callFunction(
            expr.function,
            expr.args.map((arg) => this.expression(arg)),
          ),
        );
      }
    }
  }

  private annotate(statement: Statement, values: TypedValue[]): void {
    this.annotations.set(statement, {
      span: { ...statement.span },
      values: values.map((value) => ({ ...value })),
    });
  }

  execute(body: readonly Statement[]): Flow {
    for (const statement of body) {
      if (!this.active()) return "abort";
      let flow: Flow;
      try {
        flow = this.statement(statement);
      } catch (error) {
        if (error instanceof RangeError)
          throw new RuntimeFault({
            code: "runtime.invalid-value",
            severity: "error",
            span: statement.span,
            args: {},
          });
        throw error;
      }
      if (flow) return flow;
    }
    return undefined;
  }

  private statement(statement: Statement): Flow {
    switch (statement.kind) {
      case "assignment":
        this.annotate(statement, [
          this.memory.assign(statement.target, this.expression(statement.value)),
        ]);
        break;
      case "fbCall": {
        for (const input of statement.inputs) {
          this.memory.input(statement.variable, input.input, this.expression(input.value));
        }
        const instance = this.memory.block(statement.variable);
        instance.execute(this.scanStart);
        for (const output of instance.outputs) {
          output.value = coerceValue(output.dataType, output.value);
        }
        this.annotate(statement, instance.outputs);
        break;
      }
      case "if": {
        const branch = statement.branches.find((branch) => this.expression(branch.condition));
        return this.execute(branch?.body ?? statement.elseBody);
      }
      case "case": {
        const selector = Number(this.expression(statement.selector));
        const branch = statement.branches.find((branch) =>
          branch.labels.some((label) =>
            label.kind === "value"
              ? selector === label.value
              : selector >= label.lower && selector <= label.upper,
          ),
        );
        return this.execute(branch?.body ?? statement.elseBody);
      }
      case "for": {
        const from = this.expression(statement.from);
        const to = Number(this.expression(statement.to));
        const step = Number(this.expression(statement.step));
        if (step === 0) this.fault("runtime.for-by-zero", statement.step.span);
        this.memory.assign(statement.variable, from);
        while (
          step > 0
            ? Number(this.memory.read(statement.variable.variable)) <= to
            : Number(this.memory.read(statement.variable.variable)) >= to
        ) {
          if (!this.active()) return "abort";
          this.iteration(statement.span);
          const flow = this.execute(statement.body);
          if (flow === "exit") break;
          if (flow) return flow;
          this.memory.assign(
            statement.variable,
            Number(this.memory.read(statement.variable.variable)) + step,
          );
        }
        break;
      }
      case "while":
        while (this.expression(statement.condition)) {
          if (!this.active()) return "abort";
          this.iteration(statement.span);
          const flow = this.execute(statement.body);
          if (flow === "exit") break;
          if (flow) return flow;
        }
        break;
      case "repeat":
        do {
          if (!this.active()) return "abort";
          this.iteration(statement.span);
          const flow = this.execute(statement.body);
          if (flow === "exit") break;
          if (flow) return flow;
        } while (!this.expression(statement.until));
        break;
      case "exit":
        return "exit";
      case "return":
        return "return";
    }
    return undefined;
  }

  annotationSnapshot(): Record<number, StatementAnnotation[]> {
    const result: Record<number, StatementAnnotation[]> = {};
    for (const annotation of this.annotations.values()) {
      (result[annotation.span.line] ??= []).push(annotation);
    }
    for (const entries of Object.values(result))
      entries.sort((a, b) => a.span.column - b.span.column);
    return result;
  }
}
