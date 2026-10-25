import { NumericPart } from "./NumericPart.js";
import { assignNumericBounds, assignNumericType, panelNumericTypes } from "./numeric.js";
import type { DataType } from "@benchtop-plc/core";
import { parseDirectAddress, readDirectValue } from "@benchtop-plc/core";
import { formatDiagnostic } from "../diagnostic-catalog.js";
import type { Language } from "../catalog.js";
import { createMomentaryInput } from "./momentary.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ShellCatalog } from "../catalog.js";
import type { AppState, AppStore } from "../store.js";
import {
  addPart,
  addressFor,
  assignAddress,
  deletePart,
  colorsFor,
  movePart,
  partKinds,
  partSize,
  isNumericPart,
  panelAddresses,
  minimumCanvasSize,
  type PanelPart,
  type PartKind,
} from "./layout.js";

function Part({
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
  const input = useMemo(
    () =>
      createMomentaryInput((value) => {
        if (part.address !== null)
          store.send({
            type: "setInput",
            address: part.address,
            value: { dataType: "BOOL", value },
          });
      }),
    [store, part.address],
  );
  useEffect(() => {
    const release = input.release;
    window.addEventListener("blur", release);
    const visibility = () => {
      if (document.hidden) release();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      release();
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [input]);
  const address = part.address ? parseDirectAddress(part.address) : null;
  const image = part.kind === "led" ? state.snapshot?.outputs : state.snapshot?.inputs;
  const bit = !!(address && image && readDirectValue(image, address, "BOOL"));
  const active =
    part.kind === "estop"
      ? state.emergencyActive || state.runtimeState === "ESTOP"
      : part.kind === "led"
        ? !state.emergencyActive && state.runtimeState === "RUN" && bit
        : bit;
  if (part.kind === "led")
    return (
      <output className="led-part" aria-label={part.label} data-on={active} data-color={part.color}>
        <span className="led-light" aria-hidden="true" />
        <span className="part-label" title={part.label}>
          {part.label}
        </span>
        <span className="part-state">{active ? text.on : text.off}</span>
      </output>
    );
  return (
    <button
      className={part.kind === "estop" ? "estop-part" : "input-part"}
      aria-label={part.label}
      data-color={part.color === "amber" ? "yellow" : part.color}
      disabled={state.connection !== "connected"}
      role={part.kind === "selector" ? "switch" : undefined}
      aria-checked={part.kind === "selector" ? active : undefined}
      aria-pressed={part.kind !== "selector" ? active : undefined}
      onClick={() => {
        if (part.kind === "estop") store.setEmergency(!active);
        if (part.kind === "selector")
          store.send({
            type: "setInput",
            address: part.address!,
            value: { dataType: "BOOL", value: !active },
          });
      }}
      onPointerDown={(event) => {
        if (part.kind !== "pushbutton" || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        input.set(`pointer:${event.pointerId}`, true);
      }}
      onPointerUp={(event) => input.set(`pointer:${event.pointerId}`, false)}
      onPointerCancel={(event) => input.set(`pointer:${event.pointerId}`, false)}
      onLostPointerCapture={(event) => input.set(`pointer:${event.pointerId}`, false)}
      onKeyDown={(event) => {
        if (part.kind === "pushbutton" && (event.key === " " || event.key === "Enter")) {
          event.preventDefault();
          input.set(event.key, true);
        }
      }}
      onKeyUp={(event) => {
        if (part.kind === "pushbutton" && (event.key === " " || event.key === "Enter")) {
          event.preventDefault();
          input.set(event.key, false);
        }
      }}
      onBlur={input.release}
    >
      <span className="input-cap" aria-hidden="true" />
      <span className="part-label" title={part.label}>
        {part.label}
      </span>
    </button>
  );
}

export function OperatorPanel({
  state,
  store,
  text,
  language,
}: {
  state: AppState;
  store: AppStore;
  text: ShellCatalog;
  language: Language;
}) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<PartKind>("led");
  const [selected, setSelected] = useState<string | null>(null);
  const [projectError, setProjectError] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const canOpenProject =
    state.runtimeState === "STOP" && !state.emergencyActive && state.connection === "connected";
  useEffect(() => {
    setConfirmRestore(false);
  }, [state.pous, state.layout, state.cycleMs, state.project, canOpenProject]);
  const canvas = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ id: string; pointer: number; dx: number; dy: number } | null>(null);
  const part = state.layout.find((p) => p.id === selected);
  const kindLabels = {
    led: text.led,
    pushbutton: text.pushbutton,
    selector: text.selector,
    estop: text.estopPart,
    numericInput: text.numericInput,
    numericDisplay: text.numericDisplay,
  };
  const addresses = part ? panelAddresses(part) : [];
  const change = (next: PanelPart) =>
    store.setLayout(state.layout.map((p) => (p.id === next.id ? next : p)));
  const save = () => {
    const xml = store.saveProject();
    setProjectError(!xml);
    if (!xml) return;
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "project.xml";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <section className="panel" aria-labelledby="operator-title">
      <div className="panel-heading">
        <h2 id="operator-title">{text.operator}</h2>
        <button aria-pressed={editing} onClick={() => setEditing(!editing)}>
          {editing ? text.operate : text.editPanel}
        </button>
      </div>
      <div className="panel-tools">
        <button onClick={save}>{text.saveProject}</button>
        <label>
          {text.openProject}
          <input
            type="file"
            accept=".xml"
            disabled={!canOpenProject}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file)
                void file
                  .text()
                  .then((xml) => setProjectError(!store.openProject(xml)))
                  .catch(() => setProjectError(true));
            }}
          />
        </label>
      </div>
      <div className="panel-tools">
        <button
          disabled={!canOpenProject}
          aria-describedby={confirmRestore ? "restore-example-confirmation" : undefined}
          onClick={() => {
            if (!confirmRestore) {
              setConfirmRestore(true);
              return;
            }
            setProjectError(!store.restoreExample());
            setConfirmRestore(false);
            setSelected(null);
          }}
        >
          {text.restoreExample}
        </button>
        {confirmRestore && <button onClick={() => setConfirmRestore(false)}>{text.cancel}</button>}
      </div>
      {confirmRestore && (
        <p id="restore-example-confirmation" role="status">
          {text.confirmRestoreExample}
        </p>
      )}
      {projectError && (
        <div role="alert">
          <p>{text.projectError}</p>
          {state.saveDiagnostics.map((diagnostic, index) => (
            <p key={index}>
              {diagnostic.pou} {formatDiagnostic(language, diagnostic)}
            </p>
          ))}
        </div>
      )}
      {editing && (
        <>
          <p>{text.panelEditHint}</p>
          <div className="panel-tools">
            <label>
              {text.partType}
              <select value={kind} onChange={(event) => setKind(event.target.value as PartKind)}>
                {partKinds.map((kind) => (
                  <option value={kind} key={kind}>
                    {kindLabels[kind]}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={kind === "estop" && state.layout.some((p) => p.kind === "estop")}
              onClick={() => {
                const next = addPart(state.layout, kind, kindLabels[kind]);
                store.setLayout(next);
                setSelected(next.at(-1)!.id);
              }}
            >
              {text.addPart}
            </button>
          </div>
        </>
      )}
      <div className="operator-surface" data-numeric={state.layout.some(isNumericPart)}>
        <div
          ref={canvas}
          className="operator-canvas"
          style={{ minWidth: minimumCanvasSize.width, minHeight: minimumCanvasSize.height }}
        >
          {state.layout.map((p) => (
            <div
              key={p.id}
              className="positioned-part"
              style={{
                left: `${p.x * 100}%`,
                top: `${p.y * 100}%`,
                width: partSize(p).width,
                height: partSize(p).height,
              }}
            >
              {editing ? (
                <button
                  className="edit-part"
                  aria-label={p.label || kindLabels[p.kind]}
                  aria-pressed={p.id === selected}
                  onClick={() => setSelected(p.id)}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    setSelected(p.id);
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const rect = canvas.current!.getBoundingClientRect();
                    dragging.current = {
                      id: p.id,
                      pointer: event.pointerId,
                      dx: event.clientX - rect.left - p.x * rect.width,
                      dy: event.clientY - rect.top - p.y * rect.height,
                    };
                  }}
                  onPointerMove={(event) => {
                    const drag = dragging.current;
                    if (!drag || drag.id !== p.id || drag.pointer !== event.pointerId) return;
                    const rect = canvas.current!.getBoundingClientRect();
                    store.setLayout(
                      movePart(
                        store.getSnapshot().layout,
                        p.id,
                        (event.clientX - rect.left - drag.dx) / rect.width,
                        (event.clientY - rect.top - drag.dy) / rect.height,
                      ),
                    );
                  }}
                  onPointerUp={() => {
                    dragging.current = null;
                  }}
                  onPointerCancel={() => {
                    dragging.current = null;
                  }}
                  onLostPointerCapture={() => {
                    dragging.current = null;
                  }}
                  onKeyDown={(event) => {
                    const moves: Record<string, [number, number]> = {
                      ArrowLeft: [-0.02, 0],
                      ArrowRight: [0.02, 0],
                      ArrowUp: [0, -0.02],
                      ArrowDown: [0, 0.02],
                    };
                    const move = moves[event.key];
                    if (move) {
                      event.preventDefault();
                      store.setLayout(movePart(state.layout, p.id, p.x + move[0], p.y + move[1]));
                    }
                  }}
                >
                  <span className="part-label" title={p.label}>
                    {p.label || kindLabels[p.kind]}
                  </span>
                </button>
              ) : isNumericPart(p) ? (
                <NumericPart
                  key={`${p.address}:${p.dataType}:${p.min}:${p.max}`}
                  part={p}
                  state={state}
                  store={store}
                  text={text}
                />
              ) : (
                <Part part={p} state={state} store={store} text={text} />
              )}
            </div>
          ))}
        </div>
      </div>
      {editing && part && (
        <div className="part-properties">
          <label>
            {text.partLabel}
            <input
              value={part.label}
              onChange={(event) => change({ ...part, label: event.target.value })}
            />
          </label>
          {part.kind !== "estop" && (
            <label>
              {text.address}
              <select
                value={addressFor(part)}
                onChange={(event) => change(assignAddress(part, event.target.value))}
              >
                {addresses.map((address) => {
                  return (
                    <option key={address} value={address}>
                      {address}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          {part.kind !== "estop" && !isNumericPart(part) && (
            <label>
              {text.color}
              <select
                value={part.color}
                onChange={(event) =>
                  change({ ...part, color: event.target.value as PanelPart["color"] })
                }
              >
                {colorsFor(part.kind).map((color) => (
                  <option key={color} value={color}>
                    {text[color]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isNumericPart(part) && (
            <label>
              {text.variableType}
              <select
                value={part.dataType}
                onChange={(event) =>
                  change(assignNumericType(part, event.target.value as DataType))
                }
              >
                {panelNumericTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
          )}
          {part.kind === "numericInput" && (
            <NumericBounds
              key={`${part.id}:${part.dataType}:${part.min}:${part.max}`}
              part={part}
              change={change}
              text={text}
            />
          )}
          <button
            disabled={part.kind === "estop" && state.emergencyActive}
            onClick={() => {
              store.setLayout(deletePart(state.layout, part.id));
              setSelected(null);
            }}
          >
            {text.deletePart}
          </button>
        </div>
      )}
    </section>
  );
}

function NumericBounds({
  part,
  change,
  text,
}: {
  part: PanelPart;
  change: (part: PanelPart) => void;
  text: ShellCatalog;
}) {
  const [min, setMin] = useState(part.min === undefined ? "" : String(part.min));
  const [max, setMax] = useState(part.max === undefined ? "" : String(part.max));
  const [invalid, setInvalid] = useState(false);
  return (
    <fieldset>
      <legend>{text.numericRange}</legend>
      <label>
        {text.minimum}
        <input
          type="number"
          step="any"
          value={min}
          onChange={(event) => setMin(event.target.value)}
        />
      </label>
      <label>
        {text.maximum}
        <input
          type="number"
          step="any"
          value={max}
          onChange={(event) => setMax(event.target.value)}
        />
      </label>
      <button
        onClick={() => {
          try {
            change(assignNumericBounds(part, min, max));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      >
        {text.applyRange}
      </button>
      {invalid && <span role="alert">{text.invalidRange}</span>}
    </fieldset>
  );
}
