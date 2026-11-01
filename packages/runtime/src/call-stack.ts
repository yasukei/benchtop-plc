import type {
  AnnotatedBody,
  CallFrame,
  CallVariable,
  Statement,
  StatementAnnotation,
} from "@benchtop-plc/core";
import { annotationLines } from "./annotations.js";
import type { MemoryFrame } from "./memory.js";

export interface FrameLocal {
  slot: number;
  name: string;
  inOut?: true;
}

/** The debugger only needs statement positions, local storage and invocation metadata. */
export interface CallStackFrame {
  debug?: { kind: CallFrame["kind"]; memory: MemoryFrame; locals: readonly FrameLocal[] };
  annotations?: Map<Statement, StatementAnnotation>;
  body?: Omit<AnnotatedBody, "lines" | "scanCount">;
  code: readonly { statement?: Statement }[];
  pc: number;
  statement?: Statement;
}

export function callFrames(stack: readonly CallStackFrame[], task: string): CallFrame[] {
  const frames = [...stack].reverse();
  return frames.flatMap((frame, index): CallFrame[] => {
    if (!frame.debug || !frame.body) return [];
    const { kind, memory, locals } = frame.debug;
    const span = (index === 0 ? frame.code[frame.pc]?.statement : frame.statement)?.span;
    if (!span) throw new Error("Missing call stack statement");
    const values = locals.map((local): CallVariable => {
      let actual: CallVariable["actual"];
      if (local.inOut) {
        const path = memory.debugPath(local.slot);
        if (path !== undefined) actual = { path };
        else {
          // Follow shared cells through any intermediate in-out aliases to the owner.
          for (const [callerIndex, caller] of frames.entries()) {
            if (!caller.debug) continue;
            for (const candidate of caller.debug.locals) {
              if (candidate.inOut) continue;
              const suffix = caller.debug.memory.debugSuffix(
                candidate.slot,
                memory.address(local.slot),
              );
              if (suffix !== undefined) {
                actual = { frame: callerIndex, name: candidate.name + suffix };
                break;
              }
            }
            if (actual) break;
          }
          if (!actual) throw new Error("Missing in-out actual on call stack");
        }
      }
      return {
        name: local.name,
        value: memory.debugValue(local.slot),
        ...(actual ? { actual } : {}),
      };
    });
    return [
      {
        kind,
        pou: frame.body.pou,
        instance: frame.body.instance,
        span: { ...span },
        ...(index === frames.length - 1 ? { task } : {}),
        values,
        ...(frame.body.caller ? { caller: { ...frame.body.caller } } : {}),
        annotations: annotationLines(frame.annotations!),
      },
    ];
  });
}
