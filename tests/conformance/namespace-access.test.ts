import { it } from "vitest";
import { runTrace } from "./trace.js";

const counter = (access: string) => `NAMESPACE Plant
CLASS ${access} Counter
VAR INTERNAL Value : INT := 40; END_VAR
METHOD INTERNAL Tick
  Value := Value + 1;
END_METHOD
END_CLASS
END_NAMESPACE`;

const program = (namespace: string) => {
  const source = `PROGRAM Main
VAR unit : Plant.Counter; seen : INT; END_VAR
unit.Tick(); seen := unit.Value;
END_PROGRAM`;
  return namespace ? `NAMESPACE ${namespace}\n${source}\nEND_NAMESPACE` : source;
};

it.each(["Plant", "Plant.Line", "Plant.Line.Cell"])(
  "executes INTERNAL declarations, members and methods from %s",
  (namespace) => {
    runTrace("namespace-internal-access", [program(namespace), counter("INTERNAL")], {
      kind: "run",
      cycleMs: 10,
      steps: [
        {
          label: "Call the internal method and read its member",
          set: {},
          scans: 1,
          expect: { "mainInstance.seen": 41 },
        },
        {
          label: "Internal storage persists across scans",
          set: {},
          scans: 1,
          expect: { "mainInstance.seen": 42 },
        },
      ],
    });
  },
);

it.each(["", "Other", "PlantOther"])(
  "rejects INTERNAL declaration access from namespace %j",
  (namespace) => {
    runTrace("namespace-internal-declaration-denied", [program(namespace), counter("INTERNAL")], {
      kind: "compile-error",
      diagnostics: ["namespace.internal"],
    });
  },
);

it.each(["", "Other", "PlantOther"])(
  "rejects INTERNAL member and method access on a public type from namespace %j",
  (namespace) => {
    runTrace("namespace-internal-members-denied", [program(namespace), counter("")], {
      kind: "compile-error",
      diagnostics: ["access.hidden", "fb.unknown-member"],
    });
  },
);
