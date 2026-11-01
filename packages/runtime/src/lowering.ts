import {
  integerRanges,
  isAggregateType,
  referenceLike,
  type AssignmentTarget,
  type Expression,
  type FunctionBlockCallStatement,
  type FunctionCallExpression,
  type InlineValue,
  type IntegerType,
  type ProgramIR,
  type ConfigurationIR,
  type ScalarValue,
  type SourceSpan,
  type Statement,
  type StorageReference,
  type TypedValue,
  type UserFunctionBlockCallStatement,
  type UserFunctionCall,
} from "@benchtop-plc/core";
import type { CallStackFrame } from "./call-stack.js";
import type { Memory, MemoryFrame, ReferenceAddress, StoredValue } from "./memory.js";

export type Location = { frame: MemoryFrame; variable: number };
export interface Receiver {
  frame: MemoryFrame;
  block: number;
  path: string;
  referenceAddress: () => ReferenceAddress;
}

/** Internal operations used by lowered instructions; not part of the runtime API. */
export interface ExecutionContext {
  readonly memory: MemoryFrame;
  readonly programMemory: Memory;
  location(ref: StorageReference): Location;
  invalidValue(error: RangeError, span: SourceSpan): Error;
  captureReceiver(call: UserFunctionCall, frame: ExecutionFrame): void;
  userCall(call: UserFunctionCall): StoredValue;
  argumentValue(expr: Expression): StoredValue;
  standardCall(expr: FunctionCallExpression, defer?: boolean): ScalarValue;
  expression(expr: Expression): ScalarValue;
  fault(code: "runtime.for-by-zero", span: SourceSpan): never;
  assign(target: AssignmentTarget, value: ScalarValue): TypedValue;
  iteration(span: SourceSpan): void;
  superCall(block: number): void;
  blockCall(call: FunctionBlockCallStatement | UserFunctionBlockCallStatement): void;
  annotateBlock(call: FunctionBlockCallStatement | UserFunctionBlockCallStatement): void;
  statement(statement: Statement): void;
}

export type Instruction = {
  statement?: Statement;
  run: (vm: ExecutionContext, frame: ExecutionFrame) => void;
};

export interface ExecutionFrame extends CallStackFrame {
  code: Instruction[];
  pc: number;
  statement?: Statement;
  values: Map<Expression | UserFunctionCall, StoredValue>;
  locations: Map<StorageReference, Location>;
  loops: Map<Statement, { to: bigint; step: bigint }>;
  receivers?: Map<UserFunctionCall, Receiver | undefined>;
  blockAnnotations?: Map<FunctionBlockCallStatement, InlineValue[]>;
  completed?: Map<
    | UserFunctionCall
    | import("@benchtop-plc/core").FunctionCallExpression
    | FunctionBlockCallStatement
    | UserFunctionBlockCallStatement,
    (index: number) => () => void
  >;
  copies?: (() => void)[];
  finish?: (abandoned: boolean, span?: SourceSpan) => void;
}

const lowered = new WeakMap<readonly Statement[], Instruction[]>();
const calls = new WeakMap<object, boolean>();

/** Cache positive and negative results, including shared subtrees and binding wrappers. */
function hasCall(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const cached = calls.get(value);
  if (cached !== undefined) return cached;
  const result =
    ("kind" in value && value.kind === "userFunctionCall") ||
    Object.entries(value).some(
      ([key, child]) => key !== "dataType" && key !== "span" && hasCall(child),
    );
  calls.set(value, result);
  return result;
}

export function prepare(ir: ProgramIR | ConfigurationIR): void {
  for (const program of ir.kind === "configuration" ? ir.programs : [ir]) lower(program.body);
  for (const fn of ir.functions ?? []) lower(fn.body);
  for (const block of ir.functionBlocks ?? []) {
    lower(block.body);
    for (const method of block.methods ?? []) if ("body" in method) lower(method.body);
  }
}

export function lower(body: readonly Statement[]): Instruction[] {
  const cached = lowered.get(body);
  if (cached) return cached;
  const code: Instruction[] = [];
  lowered.set(body, code);
  const emit = (run: Instruction["run"]) => {
    code.push({ run });
  };
  const address = (ref: StorageReference): void => {
    if (ref.kind === "index") {
      address(ref.array);
      for (const index of ref.indices) valueAlways(index);
    } else if (ref.kind === "dereference") value(ref.reference);
    else if (ref.kind === "structureMember") address(ref.object);
    else if (ref.kind === "userFbMember" && ref.instance) address(ref.instance);
    emit((vm, frame) => {
      frame.locations.set(ref, vm.location(ref));
    });
  };
  const target = (ref: AssignmentTarget): void => {
    if (ref.kind === "elementBit") address(ref.element);
    else if (ref.kind === "fbMember") {
      if (ref.instance) address(ref.instance);
    } else if (ref.kind !== "bit") address(ref);
  };
  const argumentsFor = (
    inputs: { value: Expression }[],
    inOuts: readonly import("@benchtop-plc/core").InOutBinding[],
  ): void => {
    const args = [
      ...inputs.map((input) => ({ span: input.value.span, run: () => valueAlways(input.value) })),
      ...inOuts.map((binding) => ({
        span: binding.actual.span,
        run: () => address(binding.actual),
      })),
    ].sort((a, b) => a.span.line - b.span.line || a.span.column - b.span.column);
    for (const arg of args) arg.run();
  };
  const emitExpression = (expr: Expression | UserFunctionCall, run: Instruction["run"]): void => {
    emit((vm, frame) => {
      try {
        run(vm, frame);
      } catch (error) {
        if (error instanceof RangeError && expr.dataType !== null)
          throw vm.invalidValue(error, expr.span);
        throw error;
      }
    });
  };
  const value = (expr: Expression | UserFunctionCall): void => {
    // Call-free expressions stay tree operations; only paths that can enter a body
    // need operand slots and continuations.
    if (!hasCall(expr)) return;
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- hasCall excludes literals, variables, bits and null before continuation compilation.
    switch (expr.kind) {
      case "userFunctionCall":
        if (expr.method?.receiver) address(expr.method.receiver);
        // Capture the receiver before evaluating arguments, which may change references.
        emitExpression(expr, (vm, frame) => {
          vm.captureReceiver(expr, frame);
        });
        argumentsFor(expr.inputs, expr.inOuts ?? []);
        emitExpression(expr, (vm) => {
          vm.userCall(expr);
        });
        for (const [index, output] of expr.outputs.entries()) {
          emitExpression(expr, (_vm, frame) => {
            (frame.copies ??= []).push(frame.completed!.get(expr)!(index));
          });
          target(output.target);
          emitExpression(expr, (_vm, frame) => {
            frame.copies!.pop()!();
          });
        }
        emitExpression(expr, (_vm, frame) => {
          frame.completed?.delete(expr);
        });
        return;
      case "binary":
        valueAlways(expr.left);
        valueAlways(expr.right);
        break;
      case "unary":
        valueAlways(expr.operand);
        break;
      case "functionCall":
        for (const index of expr.evaluationOrder ?? expr.args.map((_, index) => index))
          valueAlways(expr.args[index]!);
        emitExpression(expr, (vm, frame) => {
          frame.values.set(
            expr,
            referenceLike(expr.dataType, vm.programMemory.ir.types) ||
              isAggregateType(expr.dataType, vm.programMemory.ir.types)
              ? vm.argumentValue(expr)
              : vm.standardCall(expr, true),
          );
        });
        for (const [index, output] of (expr.outputs ?? []).entries()) {
          emitExpression(expr, (_vm, frame) => {
            (frame.copies ??= []).push(frame.completed!.get(expr)!(index));
          });
          target(output.target);
          emitExpression(expr, (_vm, frame) => {
            frame.copies!.pop()!();
          });
        }
        emitExpression(expr, (_vm, frame) => {
          frame.completed?.delete(expr);
        });
        return;
      case "index":
      case "dereference":
      case "structureMember":
      case "userFbMember":
        address(expr);
        break;
      case "fbMember":
        if (expr.instance) address(expr.instance);
        break;
      case "elementBit":
        address(expr.element);
        break;
      case "referenceOf":
        if (expr.target.kind === "fbMember") {
          if (expr.target.instance) address(expr.target.instance);
        } else address(expr.target);
        break;
      case "instanceReference":
        if (expr.target) address(expr.target);
        break;
      case "arrayBound":
        if (["variable", "index", "structureMember", "userFbMember"].includes(expr.array.kind))
          address(expr.array as StorageReference);
        else valueAlways(expr.array);
        break;
    }
    emitExpression(expr, (vm, frame) => {
      frame.values.set(expr, vm.argumentValue(expr));
    });
  };
  const valueAlways = (expr: Expression): void => {
    value(expr);
    if (!hasCall(expr))
      emit((vm, frame) => {
        frame.values.set(expr, vm.argumentValue(expr));
      });
  };
  const jump = (destination: () => number) =>
    emit((_vm, frame) => {
      frame.pc = destination();
    });
  const list = (statements: readonly Statement[], exit?: () => number): void => {
    for (const statement of statements) {
      code.push({ statement, run: () => {} });
      // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- Assignments and calls are compiled by this control-flow switch's default branch.
      switch (statement.kind) {
        case "if": {
          const ends: { destination: number }[] = [];
          for (const branch of statement.branches) {
            value(branch.condition);
            const next = { destination: 0 };
            emit((vm, frame) => {
              if (!vm.expression(branch.condition)) frame.pc = next.destination;
            });
            list(branch.body, exit);
            const end = { destination: 0 };
            ends.push(end);
            jump(() => end.destination);
            next.destination = code.length;
          }
          list(statement.elseBody, exit);
          for (const end of ends) end.destination = code.length;
          break;
        }
        case "case": {
          value(statement.selector);
          const starts: number[] = [];
          let otherwise = 0;
          emit((vm, frame) => {
            const selector = BigInt(vm.expression(statement.selector));
            const index = statement.branches.findIndex((branch) =>
              branch.labels.some((label) =>
                label.kind === "value"
                  ? selector === BigInt(label.value)
                  : selector >= BigInt(label.lower) && selector <= BigInt(label.upper),
              ),
            );
            frame.pc = index < 0 ? otherwise : starts[index]!;
          });
          const ends: { destination: number }[] = [];
          for (const branch of statement.branches) {
            starts.push(code.length);
            list(branch.body, exit);
            const end = { destination: 0 };
            ends.push(end);
            jump(() => end.destination);
          }
          otherwise = code.length;
          list(statement.elseBody, exit);
          for (const end of ends) end.destination = code.length;
          break;
        }
        case "for": {
          valueAlways(statement.from);
          valueAlways(statement.to);
          valueAlways(statement.step);
          emit((vm, frame) => {
            const from = vm.expression(statement.from),
              to = BigInt(vm.expression(statement.to)),
              step = BigInt(vm.expression(statement.step));
            if (step === 0n) vm.fault("runtime.for-by-zero", statement.step.span);
            vm.assign(statement.variable, from);
            frame.loops.set(statement, { to, step });
          });
          const check = code.length;
          let end = 0;
          emit((vm, frame) => {
            const { to, step } = frame.loops.get(statement)!;
            const current = BigInt(vm.memory.read(statement.variable.variable));
            if (step > 0n ? current > to : current < to) frame.pc = end;
            else vm.iteration(statement.span);
          });
          list(statement.body, () => end);
          emit((vm, frame) => {
            const next =
              BigInt(vm.memory.read(statement.variable.variable)) +
              frame.loops.get(statement)!.step;
            const [min, max] = integerRanges[statement.variable.dataType as IntegerType];
            // End before assignment can wrap the control variable back into the loop.
            if (next < BigInt(min) || next > BigInt(max)) frame.pc = end;
            else vm.assign(statement.variable, next);
          });
          jump(() => check);
          end = code.length;
          break;
        }
        case "while":
        case "repeat": {
          let end = 0;
          const check = code.length;
          if (statement.kind === "while") {
            emit((_vm, frame) => {
              frame.statement = statement;
              frame.values.clear();
              frame.locations.clear();
            });
            value(statement.condition);
            emit((vm, frame) => {
              if (!vm.expression(statement.condition)) frame.pc = end;
            });
          }
          emit((vm) => {
            vm.iteration(statement.span);
          });
          list(statement.body, () => end);
          if (statement.kind === "repeat") {
            emit((_vm, frame) => {
              frame.statement = statement;
              frame.values.clear();
              frame.locations.clear();
            });
            value(statement.until);
            emit((vm, frame) => {
              if (!vm.expression(statement.until)) frame.pc = check;
            });
          } else jump(() => check);
          end = code.length;
          break;
        }
        case "exit":
          if (exit) jump(exit);
          break;
        case "return":
          emit((_vm, frame) => {
            frame.pc = frame.code.length;
          });
          break;
        case "superCall":
          emit((vm) => {
            vm.superCall(statement.block);
          });
          break;
        case "userFbCall":
        case "fbCall":
          if (statement.instance) address(statement.instance);
          if (statement.kind === "userFbCall")
            argumentsFor(statement.inputs, statement.inOuts ?? []);
          else for (const input of statement.inputs) valueAlways(input.value);
          emit((vm) => {
            vm.blockCall(statement);
          });
          for (const [index, output] of (statement.outputs ?? []).entries()) {
            emit((_vm, frame) => {
              (frame.copies ??= []).push(frame.completed!.get(statement)!(index));
            });
            if (hasCall(output.target)) target(output.target);
            emit((_vm, frame) => {
              frame.copies!.pop()!();
            });
          }
          emit((vm, frame) => {
            vm.annotateBlock(statement);
            frame.completed?.delete(statement);
          });
          break;
        default:
          if (statement.kind === "assignment") {
            if (hasCall(statement.target)) {
              valueAlways(statement.value);
              target(statement.target);
            } else value(statement.value);
          } else if (statement.kind === "call") value(statement.call);
          emit((vm) => {
            vm.statement(statement);
          });
      }
    }
  };
  list(body);
  return code;
}
