import { it } from "vitest";
import { runTrace } from "./trace.js";

it.each(["\n", "\r\n", "\r"])(
  "executes nested and line comments with %j line endings while preserving delimiters in strings",
  (newline) => {
    const source = [
      "PROGRAM Main",
      "VAR total : INT; text : STRING; wide : WSTRING; END_VAR",
      "total := 1; // ignored (* total := 100;",
      "(* outer comment",
      "  (* nested comment *) total := 200; // still inside the outer comment",
      "  (* another (* deeper *) comment *)",
      "*)",
      "total := total (* between tokens *) + 2; // ignored *) total := 300;",
      "text := '(* literal *) // literal';",
      'wide := "// literal (* literal *)";',
      "END_PROGRAM // comment at EOF (*",
    ].join(newline);
    runTrace("comments", source, {
      kind: "run",
      cycleMs: 10,
      steps: [
        {
          label: "Only uncommented statements execute and string contents survive",
          set: {},
          scans: 1,
          expect: {
            "mainInstance.total": 3,
            "mainInstance.text": "(* literal *) // literal",
            "mainInstance.wide": "// literal (* literal *)",
          },
        },
      ],
    });
  },
);
