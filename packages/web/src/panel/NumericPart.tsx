import { useState } from "react";
import { readDirectValue, parseDirectAddress } from "@benchtop-plc/core";
import type { AppState, AppStore } from "../store.js";
import type { ShellCatalog } from "../catalog.js";
import { imageReadings } from "../io-image.js";
import type { PanelPart } from "./layout.js";
import { parseNumericInput } from "./numeric.js";

export function NumericPart({
  part,
  state,
  store,
  text,
}: {
  part: PanelPart;
  state: AppState;
  store: AppStore;
  text: ShellCatalog;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const reading = imageReadings({ ...state, loadedIr: undefined, layout: [part] }, text)[0]!;
  const label =
    part.label || (part.kind === "numericInput" ? text.numericInput : text.numericDisplay);
  if (part.kind === "numericDisplay")
    return (
      <output className="numeric-part" aria-label={label}>
        {part.label && <span className="part-label">{part.label}</span>}
        <strong>{reading.value}</strong>
      </output>
    );
  const value = state.snapshot
    ? readDirectValue(state.snapshot.inputs, parseDirectAddress(part.address!)!, part.dataType!)
    : 0;
  const current = typeof value === "number" && !Number.isFinite(value) ? "" : String(value);
  const step = part.dataType === "REAL" || part.dataType === "LREAL" ? "any" : "1";
  const write = (source: string) => {
    if (state.connection !== "connected") return;
    setDraft(source);
    const parsed = parseNumericInput(part, source);
    setInvalid(!parsed);
    if (parsed) store.send({ type: "setInput", address: part.address!, value: parsed });
  };
  return (
    <div className="numeric-part">
      {part.label && <span className="part-label">{part.label}</span>}
      <input
        type="number"
        aria-label={label}
        aria-invalid={invalid}
        value={draft ?? current}
        min={part.min}
        max={part.max}
        step={step}
        disabled={state.connection !== "connected"}
        onChange={(event) => write(event.target.value)}
        onBlur={() => {
          if (!invalid) setDraft(null);
        }}
      />
      {part.min !== undefined && part.max !== undefined && (
        <input
          type="range"
          aria-label={label + " " + text.slider}
          min={part.min}
          max={part.max}
          step={step}
          value={draft ?? current}
          disabled={state.connection !== "connected"}
          onChange={(event) => write(event.target.value)}
          onBlur={() => {
            if (!invalid) setDraft(null);
          }}
        />
      )}
      {invalid && <span role="alert">{text.invalidValue}</span>}
    </div>
  );
}
