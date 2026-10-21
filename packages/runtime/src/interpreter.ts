import {
  coerceValue,
  isCalendarType,
  calendarBinary,
  isIntegerType,
  isLongType,
  timeBinary,
  ltimeBinary,
  binaryValue,
  unaryValue,
  validateValue,
} from "@benchtop-plc/core";
import type {
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
        if (isLongType(expr.dataType) || isCalendarType(expr.dataType))
          validateValue(expr.dataType, expr.value);
        return expr.value;
      case "variable":
      case "bit":
      case "fbMember":
        return this.memory.value(expr).value;
      case "unary": {
        const value = this.expression(expr.operand);
        const result = unaryValue(expr.operator, value);
        return coerceValue(expr.dataType, result);
      }
      case "binary": {
        const left = this.expression(expr.left),
          right = this.expression(expr.right);
        if (expr.operator === "/" && Number(right) === 0) {
          this.fault("runtime.division-by-zero", expr.span);
        }
        if (isCalendarType(expr.left.dataType))
          return calendarBinary(
            expr.operator,
            expr.left.dataType,
            left,
            expr.right.dataType,
            right,
          );
        return expr.dataType === "LTIME"
          ? ltimeBinary(
              expr.operator as "+" | "-" | "*" | "/",
              BigInt(left),
              expr.right.dataType === "REAL" || expr.right.dataType === "LREAL"
                ? Number(right)
                : BigInt(right),
              expr.right.dataType,
            )
          : expr.dataType === "TIME"
            ? timeBinary(
                expr.operator as "+" | "-" | "*" | "/",
                Number(left),
                typeof right === "string" || typeof right === "bigint"
                  ? BigInt(right)
                  : Number(right),
                expr.right.dataType,
              )
            : coerceValue(
                expr.dataType,
                expr.operator === "*" && isIntegerType(expr.dataType) && !isLongType(expr.dataType)
                  ? Math.imul(Number(left), Number(right))
                  : binaryValue(expr.operator, left, right),
              );
      }
      case "functionCall": {
        if (!this.library) throw new Error("A runtime library is required for functions");
        const args = expr.args.map((arg) => this.expression(arg));
        if (["DIV", "DIV_TIME", "DIV_LTIME"].includes(expr.function) && Number(args[1]) === 0)
          this.fault("runtime.division-by-zero", expr.span);
        const outputs = new Map<number, ScalarValue>();
        const result = coerceValue(
          expr.dataType,
          this.library.callFunction(expr.function, args, expr.dataType, {
            argumentTypes: expr.args.map((arg) => arg.dataType),
            output: (index, value) => outputs.set(index, value),
          }),
        );
        for (const binding of expr.outputs ?? []) {
          const value = outputs.get(binding.output);
          if (value === undefined) throw new Error("Missing function output");
          this.memory.assign(binding.target, value);
        }
        return result;
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
      case "call":
        this.annotate(statement, [
          {
            dataType: statement.call.dataType,
            value: this.expression(statement.call),
          } as TypedValue,
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
        const selector = BigInt(this.expression(statement.selector));
        const branch = statement.branches.find((branch) =>
          branch.labels.some((label) =>
            label.kind === "value"
              ? selector === BigInt(label.value)
              : selector >= BigInt(label.lower) && selector <= BigInt(label.upper),
          ),
        );
        return this.execute(branch?.body ?? statement.elseBody);
      }
      case "for": {
        const from = this.expression(statement.from);
        const to = BigInt(this.expression(statement.to));
        const step = BigInt(this.expression(statement.step));
        if (step === 0n) this.fault("runtime.for-by-zero", statement.step.span);
        this.memory.assign(statement.variable, from);
        while (
          step > 0n
            ? BigInt(this.memory.read(statement.variable.variable)) <= to
            : BigInt(this.memory.read(statement.variable.variable)) >= to
        ) {
          if (!this.active()) return "abort";
          this.iteration(statement.span);
          const flow = this.execute(statement.body);
          if (flow === "exit") break;
          if (flow) return flow;
          this.memory.assign(
            statement.variable,
            BigInt(this.memory.read(statement.variable.variable)) + step,
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
