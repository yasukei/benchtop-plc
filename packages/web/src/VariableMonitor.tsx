import { useState, useEffect, useMemo } from "react";
import {
  formatDirectAddress,
  formatType,
  type ConfigurationIR,
  type TypeTable,
  type Variable,
} from "@benchtop-plc/core";
import type { ShellCatalog } from "./catalog.js";
import {
  parseWrittenValue,
  monitorLabel,
  variableValue,
  monitorRows,
  watchedLeaves,
  snapshotValues,
} from "./monitor.js";
import type { AppState, AppStore } from "./store.js";

function WriteValue({
  variable,
  types,
  id,
  store,
  disabled,
  forced,
  text,
}: {
  variable: Variable;
  types: TypeTable;
  id: number;
  store: AppStore;
  disabled: boolean;
  forced: boolean;
  text: ShellCatalog;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  function send(type: "write" | "force") {
    const parsed =
      variable.kind === "scalar" ? parseWrittenValue(variable.dataType, value, types) : null;
    setInvalid(!parsed);
    if (parsed)
      store.send(
        type === "write"
          ? { type: "write", variable: id, value: parsed }
          : { type: "force", variable: id, value: parsed },
      );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send("write");
      }}
    >
      <input
        aria-label={text.writeValue}
        aria-invalid={invalid}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
      />
      <button disabled={disabled}>{text.write}</button>
      <button type="button" disabled={disabled} onClick={() => send("force")}>
        {text.force}
      </button>
      <button
        type="button"
        disabled={disabled || !forced}
        onClick={() => store.send({ type: "force", variable: id, value: null })}
      >
        {text.unforce}
      </button>
      {invalid && <span role="alert">{text.invalidValue}</span>}
    </form>
  );
}
export function VariableMonitor({
  state,
  store,
  text,
  variables,
  types = [],
  composites = [],
}: {
  state: AppState;
  store: AppStore;
  text: ShellCatalog;
  variables: Variable[];
  types?: TypeTable;
  composites?: ConfigurationIR["composites"];
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        "$globals",
        ...variables.flatMap((variable) => (variable.instance ? [variable.instance] : [])),
      ]),
  );
  const values = useMemo(() => snapshotValues(state.snapshot), [state.snapshot]);
  const rows = monitorRows(variables, composites, expanded, state.snapshot?.forced);
  const watchKey = JSON.stringify(watchedLeaves(rows, variables));
  useEffect(() => {
    if (state.connection === "connected" && state.snapshot)
      store.send({ type: "watch", variables: JSON.parse(watchKey) as number[] });
  }, [watchKey, store, state.connection, !!state.snapshot]);
  const disabled = state.connection !== "connected" || !state.snapshot;
  return (
    <section className="panel monitor" aria-labelledby="monitor-title">
      <h2 id="monitor-title">{text.monitor}</h2>
      {variables.length === 0 ? (
        <p>{text.emptyMonitor}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{text.variableName}</th>
                <th>{text.address}</th>
                <th>{text.variableType}</th>
                <th>{text.liveValue}</th>
                <th>{text.actions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                if (row.kind === "group")
                  return (
                    <tr key={row.name}>
                      <th
                        scope="row"
                        title={row.name === "$globals" ? text.globals : row.name}
                        style={{ paddingLeft: `${row.depth + 1}rem` }}
                      >
                        <button
                          aria-expanded={expanded.has(row.name)}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(row.name)) next.delete(row.name);
                              else next.add(row.name);
                              return next;
                            })
                          }
                        >
                          {row.name === "$globals"
                            ? text.globals
                            : monitorLabel(row.name, row.instance)}
                        </button>
                      </th>
                      <td />
                      <td>
                        {row.dataType
                          ? formatType(row.dataType)
                          : row.name === "$globals"
                            ? text.globals
                            : text.PROGRAM}
                      </td>
                      <td />
                      <td />
                    </tr>
                  );
                const id = row.id;
                const variable = variables[id]!;
                const forced = state.snapshot?.forced.includes(id) ?? false;
                return (
                  <tr key={id} data-forced={forced}>
                    <th
                      scope="row"
                      title={variable.name}
                      style={{ paddingLeft: `${row.depth + 1}rem` }}
                    >
                      {monitorLabel(variable.name, variable.instance)}
                      {forced && <span className="force-badge">{text.forced}</span>}
                    </th>
                    <td>
                      {variable.kind === "scalar" && variable.address
                        ? formatDirectAddress(variable.address)
                        : null}
                    </td>
                    <td>
                      {variable.kind !== "functionBlock"
                        ? formatType(variable.dataType)
                        : variable.fbType}
                    </td>
                    <td>{variableValue(variable, values.get(id), types, text.invalidReal)}</td>
                    <td>
                      {variable.kind === "scalar" &&
                        (variable.dataType === "BOOL" ? (
                          <div className="force-actions">
                            <button
                              disabled={disabled}
                              onClick={() =>
                                store.send({
                                  type: "force",
                                  variable: id,
                                  value: { dataType: "BOOL", value: true },
                                })
                              }
                            >
                              {text.forceTrue}
                            </button>
                            <button
                              disabled={disabled}
                              onClick={() =>
                                store.send({
                                  type: "force",
                                  variable: id,
                                  value: { dataType: "BOOL", value: false },
                                })
                              }
                            >
                              {text.forceFalse}
                            </button>
                            <button
                              disabled={disabled || !forced}
                              onClick={() =>
                                store.send({ type: "force", variable: id, value: null })
                              }
                            >
                              {text.unforce}
                            </button>
                          </div>
                        ) : (
                          <WriteValue
                            variable={variable}
                            types={types}
                            id={id}
                            store={store}
                            disabled={disabled}
                            forced={forced}
                            text={text}
                          />
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
