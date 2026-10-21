import { coerceValue, integerRanges, standardFunctionBlocks } from "@benchtop-plc/core";
import type {
  FunctionBlockPort,
  FunctionBlockType,
  IntegerType,
  ScalarValue,
} from "@benchtop-plc/core";
import type { FunctionBlockInstance } from "./library.js";
import { typed } from "./memory.js";

function ports(descriptors: readonly FunctionBlockPort[]) {
  return descriptors.map(([, type]) => typed(type, type === "BOOL" ? false : 0));
}

abstract class Block implements FunctionBlockInstance {
  readonly inputs;
  readonly outputs;

  constructor(type: FunctionBlockType) {
    this.inputs = ports(standardFunctionBlocks[type].inputs);
    this.outputs = ports(standardFunctionBlocks[type].outputs);
  }

  protected input(index: number): ScalarValue {
    return this.inputs[index]!.value;
  }

  protected output(index: number, value: ScalarValue): void {
    const output = this.outputs[index]!;
    output.value = coerceValue(output.dataType, value);
  }

  abstract execute(scanStartMs: number): void;
}

class Timer extends Block {
  private started: number | null = null;
  private previous = false;
  private finished = false;

  constructor(
    type: FunctionBlockType,
    private readonly kind: "TON" | "TOF" | "TP",
  ) {
    super(type);
    this.long = this.inputs[1]!.dataType === "LTIME";
  }

  private readonly long: boolean;

  execute(scanStartMs: number): void {
    const input = Boolean(this.input(0));
    const rawPreset = BigInt(this.input(1));
    const preset = rawPreset < 0n ? 0n : rawPreset;
    if (this.kind === "TON" && !input) this.reset();
    else if (this.kind === "TOF" && input) this.reset();
    else if (
      this.started === null &&
      (this.kind === "TON" ||
        (this.kind === "TOF" ? this.previous && !input : !this.previous && input))
    ) {
      this.started = scanStartMs;
    }

    let elapsed = 0n;
    if (this.started !== null) {
      const ms = Math.max(0, scanStartMs - this.started);
      // The injected clock supplies fractional milliseconds; long timers quantize to ns.
      elapsed = BigInt(this.long ? Math.round(ms * 1_000_000) : Math.floor(ms));
      if (elapsed > preset) elapsed = preset;
      if (elapsed >= preset) this.finished = true;
      if (this.finished) elapsed = preset;
    }
    const running = this.started !== null && !this.finished;
    const q =
      this.kind === "TON"
        ? input && this.finished
        : this.kind === "TOF"
          ? input || running
          : running;
    // A pulse ignores falling edges while active; it rearms only after completion and IN=FALSE.
    if (this.kind === "TP" && this.finished && !input) {
      this.reset();
      elapsed = 0n;
    }
    this.output(0, q);
    this.output(1, elapsed);
    this.previous = input;
  }

  private reset(): void {
    this.started = null;
    this.finished = false;
  }
}

class Trigger extends Block {
  private previous: boolean | undefined;

  constructor(private readonly type: "R_TRIG" | "F_TRIG") {
    super(type);
  }

  execute(): void {
    const input = Boolean(this.input(0));
    this.output(
      0,
      this.previous !== undefined &&
        (this.type === "R_TRIG" ? !this.previous && input : this.previous && !input),
    );
    this.previous = input;
  }
}

class Bistable extends Block {
  constructor(
    type: "SR" | "RS",
    private readonly setDominant = type === "SR",
  ) {
    super(type);
  }

  execute(): void {
    const set = Boolean(this.input(0));
    const reset = Boolean(this.input(1));
    const q = Boolean(this.outputs[0]!.value);
    this.output(0, this.setDominant ? set || (!reset && q) : !reset && (set || q));
  }
}

class Counter extends Block {
  private previousUp = false;
  private previousDown = false;
  private readonly minimum: bigint;
  private readonly maximum: bigint;

  constructor(
    type: FunctionBlockType,
    private readonly kind: "CTU" | "CTD" | "CTUD",
  ) {
    super(type);
    const countType = this.outputs.at(-1)!.dataType as IntegerType;
    const [min, max] = integerRanges[countType];
    this.minimum = BigInt(min);
    this.maximum = BigInt(max);
    if (kind === "CTD") this.output(0, true);
    if (kind === "CTUD") this.output(1, true);
  }

  execute(): void {
    let count = BigInt(this.outputs.at(-1)!.value);
    const combined = this.kind === "CTUD";
    const up = this.kind !== "CTD" && Boolean(this.input(0));
    const down = this.kind === "CTD" ? Boolean(this.input(0)) : combined && Boolean(this.input(1));
    const reset = this.kind !== "CTD" && Boolean(this.input(combined ? 2 : 1));
    const load = this.kind !== "CTU" && Boolean(this.input(combined ? 3 : 1));
    const preset = BigInt(this.input(combined ? 4 : 2));
    const riseUp = up && !this.previousUp;
    const riseDown = down && !this.previousDown;
    if (reset) count = 0n;
    else if (load) count = preset;
    else if (riseUp && !riseDown && count < this.maximum) count++;
    else if (riseDown && !riseUp && count > this.minimum) count--;
    if (combined) {
      this.output(0, count >= preset);
      this.output(1, count <= 0n);
      this.output(2, count);
    } else {
      this.output(0, this.kind === "CTU" ? count >= preset : count <= 0n);
      this.output(1, count);
    }
    // Reset/load and simultaneous edges still update both edge histories.
    this.previousUp = up;
    this.previousDown = down;
  }
}

export function createStandardFunctionBlock(type: FunctionBlockType): FunctionBlockInstance {
  const kind = type.split("_")[0];
  switch (kind) {
    case "TON":
    case "TOF":
    case "TP":
      return new Timer(type, kind);
    case "CTU":
    case "CTD":
    case "CTUD":
      return new Counter(type, kind);
  }
  switch (type) {
    case "R_TRIG":
    case "F_TRIG":
      return new Trigger(type);
    case "SR":
    case "RS":
      return new Bistable(type);
    default:
      throw new RangeError(`Unknown function block ${type}`);
  }
}
