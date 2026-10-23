import {
  coerceValue,
  arrayType,
  structureType,
  sameScalarType,
  type StructureVariable,
  type ArrayVariable,
  type InitialValue,
  truncateString,
  isCharacterType,
  validateValue,
  isLongType,
  isCalendarType,
  scalarBase,
  validateDeclaredValue,
  validateScalar,
  type TypeDescriptor,
  type TypeTable,
} from "@benchtop-plc/core";
import type {
  AssignmentTarget,
  CaseStatement,
  LiteralExpression,
  LongType,
  BitReference,
  FunctionBlockMemberReference,
  UserFunctionBlockMemberReference,
  InstanceStorage,
  IoImage,
  ProgramIR,
  ScalarValue,
  ScalarVariable,
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

/** Scan-stage extension point for host integrations. */
export interface ScanMemory {
  read(variable: number): ScalarValue;
  write(variable: number, value: ScalarValue): void;
}

type ScalarCell = (
  { kind: "scalar"; value: TypedValue } | { kind: "long"; dataType: LongType; value: bigint }
) & { descriptor: TypeDescriptor };
interface UserBlockCell {
  kind: "userFunctionBlock";
  frame: MemoryFrame;
  block: number;
  path: string;
  resetTemporaries(): void;
}
export interface AggregateValue {
  dataType: TypeDescriptor;
  elements: (ScalarValue | AggregateValue)[];
}
export function isAggregateValue(
  value: ScalarValue | AggregateValue | null,
): value is AggregateValue {
  return value !== null && typeof value === "object";
}
type AggregateCell = { kind: "aggregate"; descriptor: TypeDescriptor; elements: Cell[] };
type ValueCell = ScalarCell | AggregateCell;
type Cell =
  | AggregateCell
  | { kind: "unbound" }
  | ScalarCell
  | { kind: "functionBlock"; instance: FunctionBlockInstance }
  | UserBlockCell;

function initialCell(
  variable: ScalarVariable | ArrayVariable | StructureVariable,
  types: TypeTable,
): ValueCell {
  if (variable.kind === "array" || variable.kind === "structure") {
    const create = (type: TypeDescriptor, value: InitialValue): ValueCell => {
      const array = arrayType(type, types);
      const structure = structureType(type, types);
      if (array || structure)
        return {
          kind: "aggregate",
          descriptor: type,
          elements: (value as InitialValue[]).map((v, i) =>
            create(structure ? structure.members[i]!.dataType : array!.element, v),
          ),
        };
      return initialCell(
        { ...variable, kind: "scalar", dataType: type, initialValue: value } as ScalarVariable,
        types,
      );
    };
    return create(variable.dataType, variable.initialValue);
  }
  const dataType = scalarBase(variable.dataType, types);
  validateValue(dataType, variable.initialValue);
  validateDeclaredValue(variable.dataType, variable.initialValue, types);
  return isLongType(dataType)
    ? {
        kind: "long",
        dataType,
        value: BigInt(variable.initialValue),
        descriptor: variable.dataType,
      }
    : {
        kind: "scalar",
        value: typed(dataType, variable.initialValue),
        descriptor: variable.dataType,
      };
}

/** Mutable scalar/FB cells; function frames never perform load-time validation. */
export class MemoryFrame implements ScanMemory {
  constructor(
    protected readonly cells: Cell[],
    protected readonly types: TypeTable = [],
  ) {}

  asAggregateCell(descriptor: TypeDescriptor): Cell {
    return { kind: "aggregate", descriptor, elements: this.cells };
  }

  descriptor(variable: number): TypeDescriptor {
    const cell = this.cells[variable];
    if (!cell || !("descriptor" in cell)) throw new Error("Expected value storage");
    return cell.descriptor;
  }

  element(variable: number, offset: number): MemoryFrame {
    const cell = this.cells[variable];
    if (cell?.kind !== "aggregate" || !cell.elements[offset])
      throw new RangeError("Invalid aggregate storage");
    return new MemoryFrame([cell.elements[offset]!], this.types);
  }

  aggregateValue(variable: number): AggregateValue {
    const cell = this.cells[variable];
    if (cell?.kind !== "aggregate") throw new Error("Expected aggregate");
    return {
      dataType: cell.descriptor,
      elements: cell.elements.map((child, i) => {
        const frame = this.element(variable, i);
        return child.kind === "aggregate" ? frame.aggregateValue(0) : frame.read(0);
      }),
    };
  }

  assignAggregate(variable: number, values: AggregateValue): void {
    // Open-array formals can bind different actual types. Check the concrete
    // descriptors before changing any destination leaf.
    if (!sameScalarType(this.descriptor(variable), values.dataType, this.types))
      throw new RangeError("Incompatible aggregate copy");
    values.elements.forEach((value, i) => {
      const frame = this.element(variable, i);
      if (isAggregateValue(value)) frame.assignAggregate(0, value);
      else frame.write(0, value);
    });
  }

  /** Share the actual cell, including when it is already an in-out alias. */
  bind(variable: number, caller: MemoryFrame, actual: number): void {
    const cell = caller.cells[actual];
    if (!cell || (cell.kind !== "scalar" && cell.kind !== "long" && cell.kind !== "aggregate"))
      throw new Error("Expected value in-out actual");
    this.cells[variable] = cell;
  }

  unbind(variables: readonly number[]): void {
    for (const variable of variables) this.cells[variable] = { kind: "unbound" };
  }

  private scalar(variable: number): TypedValue {
    const cell = this.cells[variable];
    if (cell?.kind === "long") return typed(cell.dataType, cell.value);
    if (!cell || cell.kind !== "scalar") throw new Error("Expected scalar variable");
    return cell.value;
  }

  block(variable: number): FunctionBlockInstance {
    const cell = this.cells[variable];
    if (!cell || cell.kind !== "functionBlock") throw new Error("Expected function block");
    return cell.instance;
  }

  userBlock(variable: number): UserBlockCell {
    const cell = this.cells[variable];
    if (!cell || cell.kind !== "userFunctionBlock") throw new Error("Expected user function block");
    return cell;
  }

  resetTemporaries(storage: readonly InstanceStorage[]): void {
    storage.forEach((slot, index) => {
      if (slot.kind === "temporary") this.cells[index] = initialCell(slot.variable, this.types);
    });
  }

  read(variable: number): ScalarValue {
    const cell = this.cells[variable];
    return cell?.kind === "long" ? cell.value : this.scalar(variable).value;
  }

  write(variable: number, value: ScalarValue): void {
    const cell = this.cells[variable];
    if (cell?.kind === "long" || cell?.kind === "scalar") {
      value = truncateString(cell.descriptor, value, this.types);
      validateDeclaredValue(cell.descriptor, value, this.types);
    }
    if (cell?.kind === "long") {
      cell.value = BigInt(coerceValue(cell.dataType, value));
      return;
    }
    const scalar = this.scalar(variable);
    scalar.value = coerceValue(scalar.dataType, value);
  }

  value(
    ref:
      | VariableReference
      | BitReference
      | FunctionBlockMemberReference
      | UserFunctionBlockMemberReference,
  ): TypedValue {
    if (ref.kind === "bit")
      return {
        dataType: "BOOL",
        value: (BigInt(this.read(ref.variable)) & (1n << BigInt(ref.bit))) !== 0n,
      };
    if (ref.kind === "variable") return { ...this.scalar(ref.variable) };
    if (ref.kind === "userFbMember")
      return typed(
        scalarBase(ref.dataType, this.types),
        this.userBlock(ref.variable).frame.read(ref.member),
      );
    const instance = this.block(ref.variable);
    const value = (ref.port === "input" ? instance.inputs : instance.outputs)[ref.member];
    if (!value) throw new Error("Expected function block port");
    return { ...value };
  }

  assign(
    target: Exclude<AssignmentTarget, { kind: "index" | "elementBit" | "structureMember" }>,
    value: ScalarValue,
  ): TypedValue {
    if (target.kind === "bit") {
      const pattern = BigInt(this.read(target.variable)),
        mask = 1n << BigInt(target.bit);
      this.write(target.variable, value ? pattern | mask : pattern & ~mask);
    } else if (target.kind === "variable") this.write(target.variable, value);
    else if (target.kind === "userFbMember")
      this.userBlock(target.variable).frame.write(target.member, value);
    else this.input(target.variable, target.member, value);
    return this.value(target);
  }

  input(variable: number, index: number, value: ScalarValue): void {
    const inputs = this.block(variable).inputs;
    const input = inputs[index];
    if (!input) throw new Error("Expected function block input");
    inputs[index] = typed(input.dataType, value);
  }
}

export class Memory extends MemoryFrame {
  private readonly functionInitialCells: readonly ValueCell[][];
  private readonly instanceCells = new Map<number, UserBlockCell>();

  constructor(
    readonly ir: ProgramIR,
    library?: RuntimeLibrary,
  ) {
    // Check literals even in branches that are not executed. No untrusted long value
    // may be normalized merely because BigInt accepts its syntax.
    const validateLiterals = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (
        "kind" in node &&
        node.kind === "literal" &&
        "dataType" in node &&
        "value" in node &&
        typeof node.dataType === "string" &&
        (isLongType(node.dataType) ||
          isCalendarType(node.dataType) ||
          isCharacterType(node.dataType))
      )
        validateValue(node.dataType, node.value);
      if (
        "kind" in node &&
        node.kind === "literal" &&
        "dataType" in node &&
        typeof node.dataType === "object"
      ) {
        const literal = node as LiteralExpression;
        validateScalar(literal.dataType, literal.value, ir.types);
      }
      if ("kind" in node && node.kind === "case") {
        // The IR shape is compiler-checked; value validation also covers label payloads.
        const statement = node as CaseStatement;
        const type = scalarBase(statement.selector.dataType, ir.types);
        if (isLongType(type)) {
          for (const branch of statement.branches) {
            for (const label of branch.labels) {
              if (label.kind === "value") validateValue(type, label.value);
              else {
                validateValue(type, label.lower);
                validateValue(type, label.upper);
              }
            }
          }
        }
      }
      for (const child of Object.values(node)) validateLiterals(child);
    };
    validateLiterals(ir.body);
    const functionInitialCells = (ir.functions ?? []).map((fn) => {
      validateLiterals(fn.body);
      return fn.variables.map((variable) => initialCell(variable, ir.types ?? []));
    });
    super(
      ir.variables.map((variable): Cell => {
        if (variable.kind === "scalar") return initialCell(variable, ir.types ?? []);
        if (!library) throw new Error("A runtime library is required for function blocks");
        return { kind: "functionBlock", instance: library.createFunctionBlock(variable.fbType) };
      }),
      ir.types ?? [],
    );
    for (const block of ir.functionBlocks ?? []) validateLiterals(block.body);
    this.functionInitialCells = functionInitialCells;
  }

  private frame(storage: readonly InstanceStorage[]): MemoryFrame {
    return new MemoryFrame(
      storage.map((slot) => {
        if (slot.kind === "inOut") return { kind: "unbound" };
        if (slot.kind === "variable") return this.cells[slot.variable]!;
        if (slot.kind === "temporary") return initialCell(slot.variable, this.types);
        if (slot.kind === "array" || slot.kind === "structure")
          return this.frame(slot.elements).asAggregateCell(slot.dataType);
        let cell = this.instanceCells.get(slot.instance);
        if (!cell) {
          const instance = this.ir.instances![slot.instance]!;
          const frame = this.frame(instance.storage);
          cell = {
            kind: "userFunctionBlock",
            frame,
            block: instance.block,
            path: instance.path,
            resetTemporaries: () => frame.resetTemporaries(instance.storage),
          };
          this.instanceCells.set(slot.instance, cell);
        }
        return cell;
      }),
      this.types,
    );
  }

  /** Fresh PROGRAM temporaries; persistent instance frames alias monitored cells. */
  programFrame(): MemoryFrame {
    return this.ir.storage ? this.frame(this.ir.storage) : this;
  }

  /** Clone validated initial cells, keeping each invocation independent. */
  functionFrame(index: number): MemoryFrame {
    const initial = this.functionInitialCells[index];
    if (!initial) throw new Error("Missing function locals");
    return new MemoryFrame(
      initial.map(function clone(cell: Cell): ValueCell {
        if (cell.kind === "aggregate")
          return {
            kind: "aggregate",
            descriptor: cell.descriptor,
            elements: cell.elements.map(clone),
          };
        if (cell.kind === "long") return { ...cell };
        if (cell.kind === "scalar") return { ...cell, value: { ...cell.value } };
        throw new Error("Instance in function initial storage");
      }),
      this.types,
    );
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

  snapshot(ids = this.cells.map((_, i) => i)): VariableSnapshot[] {
    return ids.map((id): VariableSnapshot => {
      const cell = this.cells[id]!;
      if (cell.kind === "long") return { kind: "scalar", ...typed(cell.dataType, cell.value) };
      if (cell.kind === "scalar") return { kind: "scalar", ...cell.value };
      if (cell.kind !== "functionBlock") throw new Error("User instance in monitored storage");
      return {
        kind: "functionBlock",
        inputs: cell.instance.inputs.map((value) => ({ ...value })),
        outputs: cell.instance.outputs.map((value) => ({ ...value })),
      };
    });
  }
}
