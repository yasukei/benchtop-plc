import { parseDirectAddress, validDirectAddress } from "@benchtop-plc/core";
import type { JsonValue } from "./model.js";

/** Preserve legacy JSON, and choose the oldest extension capable of representing the layout. */
export function encodePanel(value: JsonValue): { version: string; value: JsonValue } {
  if (!Array.isArray(value)) return { version: "1", value };
  let modern = false;
  const legacy = value.map((part) => {
    if (!part || Array.isArray(part) || typeof part !== "object" || !("address" in part))
      return part;
    const address = typeof part.address === "string" ? parseDirectAddress(part.address) : null;
    if (
      part.kind !== "estop" &&
      (!address || !validDirectAddress(address) || address.size !== "X" || address.byte !== 0)
    ) {
      modern = true;
      return part;
    }
    return Object.fromEntries(
      Object.entries(part).map(([key, v]) =>
        key === "address" ? ["bit", address?.size === "X" ? address.bit : null] : [key, v],
      ),
    );
  });
  return modern ? { version: "2", value } : { version: "1", value: legacy };
}
