import {
  resolveType,
  type Diagnostic,
  type DirectAddress,
  parseDirectAddress,
  validDirectAddress,
} from "@benchtop-plc/core";
import type { CheckedProgram } from "./checked.js";
import type { Configuration } from "./configuration.js";

export type CheckedTask = { name: string; priority: number } & (
  | { intervalMs: number }
  | { single: { kind: "global"; key: string } | { kind: "address"; address: DirectAddress } }
);

/** Resolve event inputs against the checked global scope, including derived BOOL aliases. */
export function checkTasks(config: Configuration, globals: CheckedProgram) {
  const diagnostics: Diagnostic[] = [];
  const tasks: CheckedTask[] = [];
  for (const task of config.tasks) {
    const common = { name: task.name.name, priority: task.priority };
    if (task.intervalMs !== undefined) {
      tasks.push({ ...common, intervalMs: task.intervalMs });
      continue;
    }
    const tokens = task.single ?? [];
    const token = tokens[0];
    if (tokens.length === 1 && token?.kind === "identifier") {
      const global = globals.symbols.find((symbol) => symbol.name.key === token.key);
      if (global && global.descriptor && resolveType(global.descriptor, globals.types) === "BOOL") {
        tasks.push({ ...common, single: { kind: "global", key: token.key } });
        continue;
      }
    }
    if (tokens.length === 1 && token?.kind === "address") {
      const address = parseDirectAddress(token.text);
      if (address?.area === "I" && address.size === "X" && validDirectAddress(address)) {
        tasks.push({
          ...common,
          single: {
            kind: "address",
            address,
          },
        });
        continue;
      }
    }
    diagnostics.push({
      code: "config.single",
      severity: "error",
      args: {},
      span: token?.span ?? task.name.span,
      pou: config.name.name,
    });
  }
  return { tasks, diagnostics };
}
