import type { SourceSpan } from "./source.js";

/** Transport envelope; issue #4 defines the code/argument discriminated union. */
export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  span?: SourceSpan;
  args: Record<string, string | number | boolean>;
}
