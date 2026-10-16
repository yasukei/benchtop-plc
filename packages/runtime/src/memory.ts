import { coerceValue } from "@benchtop-plc/core";
import type {
  AssignmentTarget,
  FunctionBlockMemberReference,
  IoImage,
  ProgramIR,
  ScalarValue,
  TypedValue,
  VariableReference,
  VariableSnapshot,
} from "@benchtop-plc/core";
import type { FunctionBlockInstance, RuntimeLibrary } from "./library.js";

export function typed(dataType: TypedValue["dataType"], value: ScalarValue): TypedValue {
  // coerceValue preserves the discriminator/value relationship.
  return { dataType, value: coerceValue(dataType, value) } as TypedValue;
}

export function emptyImage(): IoImage {
  return [false, false, false, false, false, false, false, false];
}

/** Scan-stage extension point; debug command handling belongs to issue #10. */
export interface ScanMemory {
  read(variable: number): ScalarValue;
  write(variable: number, value: ScalarValue): void;
}

type Cell =
  | { kind: "scalar"; value: TypedValue }
  | { kind: "functionBlock"; instance: FunctionBlockInstance };

export class Memory implements ScanMemory {
  private readonly cells: Cell[];

  constructor(
    readonly ir: ProgramIR,
    library?: RuntimeLibrary,
  ) {
    this.cells = ir.variables.map((variable) => {
      if (variable.kind === "scalar") {
        return { kind: "scalar", value: typed(variable.dataType, variable.initialValue) };
      }
      if (!library) throw new Error("A runtime library is required for function blocks");
      return { kind: "functionBlock", instance: library.createFunctionBlock(variable.fbType) };
    });
  }

  private scalar(variable: number): TypedValue {
    const cell = this.cells[variable];
    if (!cell || cell.kind !== "scalar") throw new Error("Expected scalar variable");
    return cell.value;
  }

  block(variable: number): FunctionBlockInstance {
    const cell = this.cells[variable];
    if (!cell || cell.kind !== "functionBlock") throw new Error("Expected function block");
    return cell.instance;
  }

  read(variable: number): ScalarValue {
    return this.scalar(variable).value;
  }

  write(variable: number, value: ScalarValue): void {
    const scalar = this.scalar(variable);
    scalar.value = coerceValue(scalar.dataType, value);
  }

  value(ref: VariableReference | FunctionBlockMemberReference): TypedValue {
    if (ref.kind === "variable") return { ...this.scalar(ref.variable) };
    const instance = this.block(ref.variable);
    const value = (ref.port === "input" ? instance.inputs : instance.outputs)[ref.member];
    if (!value) throw new Error("Expected function block port");
    return { ...value };
  }

  assign(target: AssignmentTarget, value: ScalarValue): TypedValue {
    if (target.kind === "variable") this.write(target.variable, value);
    else this.input(target.variable, target.member, value);
    return this.value(target);
  }

  input(variable: number, index: number, value: ScalarValue): void {
    const inputs = this.block(variable).inputs;
    const input = inputs[index];
    if (!input) throw new Error("Expected function block input");
    inputs[index] = typed(input.dataType, value);
  }

  readInputs(image: IoImage): void {
    this.ir.variables.forEach((variable, index) => {
      if (variable.kind === "scalar" && variable.address?.area === "I") {
        this.write(index, image[variable.address.bit]);
      }
    });
  }

  outputImage(): IoImage {
    const image = emptyImage();
    this.ir.variables.forEach((variable, index) => {
      if (variable.kind === "scalar" && variable.address?.area === "Q") {
        image[variable.address.bit] = Boolean(this.read(index));
      }
    });
    return image;
  }

  clearOutputs(): void {
    this.ir.variables.forEach((variable, index) => {
      if (variable.kind === "scalar" && variable.address?.area === "Q") this.write(index, false);
    });
  }

  snapshot(): VariableSnapshot[] {
    return this.cells.map((cell) =>
      cell.kind === "scalar"
        ? { kind: "scalar", ...cell.value }
        : {
            kind: "functionBlock",
            inputs: cell.instance.inputs.map((value) => ({ ...value })),
            outputs: cell.instance.outputs.map((value) => ({ ...value })),
          },
    );
  }
}
