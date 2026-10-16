import { coerceValue, standardFunctionBlocks } from "@benchtop-plc/core";
import type { FunctionBlockPort, FunctionBlockType, ScalarValue } from "@benchtop-plc/core";
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

  constructor(private readonly type: "TON" | "TOF" | "TP") {
    super(type);
  }

  execute(scanStartMs: number): void {
    const input = Boolean(this.input(0));
    const preset = Math.max(0, Number(this.input(1)));
    if (this.type === "TON" && !input) this.reset();
    else if (this.type === "TOF" && input) this.reset();
    else if (
      this.started === null &&
      (this.type === "TON" ||
        (this.type === "TOF" ? this.previous && !input : !this.previous && input))
    ) {
      this.started = scanStartMs;
    }

    let elapsed = 0;
    if (this.started !== null) {
      elapsed = Math.min(preset, Math.max(0, scanStartMs - this.started));
      if (elapsed >= preset) this.finished = true;
      if (this.finished) elapsed = preset;
    }
    const running = this.started !== null && !this.finished;
    const q =
      this.type === "TON"
        ? input && this.finished
        : this.type === "TOF"
          ? input || running
          : running;
    // A pulse ignores falling edges while active; it rearms only after completion and IN=FALSE.
    if (this.type === "TP" && this.finished && !input) {
      this.reset();
      elapsed = 0;
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

class Counter extends Block {
  private previous = false;
  private count = 0;

  constructor(private readonly type: "CTU" | "CTD") {
    super(type);
    if (type === "CTD") this.output(0, true);
  }

  execute(): void {
    const input = Boolean(this.input(0));
    const control = Boolean(this.input(1));
    const preset = Number(this.input(2));
    if (control) this.count = this.type === "CTU" ? 0 : preset;
    else if (input && !this.previous) {
      this.count =
        this.type === "CTU" ? Math.min(32767, this.count + 1) : Math.max(-32768, this.count - 1);
    }
    this.output(0, this.type === "CTU" ? this.count >= preset : this.count <= 0);
    this.output(1, this.count);
    // Reset/load takes priority but still samples the edge input.
    this.previous = input;
  }
}

export function createStandardFunctionBlock(type: FunctionBlockType): FunctionBlockInstance {
  switch (type) {
    case "TON":
    case "TOF":
    case "TP":
      return new Timer(type);
    case "R_TRIG":
    case "F_TRIG":
      return new Trigger(type);
    case "CTU":
    case "CTD":
      return new Counter(type);
  }
}
