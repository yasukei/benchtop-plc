import type { CommandRejectionMessage } from "@benchtop-plc/core";
import type { ShellCatalog } from "./catalog.js";

export function rejectionText(rejection: CommandRejectionMessage, text: ShellCatalog): string {
  const diagnostic = rejection.diagnostic;
  switch (diagnostic.code) {
    case "runtime.debug-target":
      return text.rejectedTarget;
    case "runtime.debug-type-mismatch":
      return text.rejectedType
        .replace("{from}", diagnostic.args.from)
        .replace("{to}", diagnostic.args.to);
    case "runtime.debug-value":
      return text.rejectedValue;
    case "runtime.write-input-mapped":
      return text.rejectedInputWrite.replace("{name}", () => diagnostic.args.name);
  }
}
