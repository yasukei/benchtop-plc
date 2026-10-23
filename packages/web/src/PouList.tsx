import { useState } from "react";
import { diagnosticPouSourceIndex, type EditorPou, type EditorDataType } from "./pous.js";
import type { ShellCatalog } from "./catalog.js";
import type { AppState, AppStore } from "./store.js";

export function PouList({
  state,
  store,
  text,
}: {
  state: AppState;
  store: AppStore;
  text: ShellCatalog;
}) {
  const [deleting, setDeleting] = useState<{
    index: number;
    pou: EditorPou | EditorDataType;
  } | null>(null);
  const target =
    deleting &&
    (deleting.pou.kind === "TYPE" ? state.dataTypes : state.pous)[deleting.index] === deleting.pou
      ? deleting.pou
      : undefined;
  const confirmation =
    target &&
    (target.kind === "TYPE" ? text.confirmDeleteDataType : text.confirmDeletePou).replace(
      "{name}",
      target.name,
    );
  return (
    <section className="pou-list" aria-label={text.pous}>
      <h3>{text.dataTypes}</h3>
      <button
        onClick={() => {
          setDeleting(null);
          store.addDataType();
        }}
      >
        {text.addDataType}
      </button>
      <ul aria-label={text.dataTypes}>
        {state.dataTypes.map((type, index) => (
          <li key={index}>
            <button
              aria-pressed={state.selectedDataType === index}
              onClick={() => {
                setDeleting(null);
                store.selectDataType(index);
              }}
            >
              <strong>{type.name}</strong>
              <span>{text.TYPE}</span>
              <span>
                {text.diagnosticCount.replace(
                  "{count}",
                  String(
                    state.diagnostics.filter(
                      (diagnostic) =>
                        diagnostic.sourceKind === "dataType" && diagnostic.sourceIndex === index,
                    ).length,
                  ),
                )}
              </span>
            </button>
            <button
              aria-label={text.deletePou.replace("{name}", type.name)}
              onClick={() => setDeleting({ index, pou: type })}
            >
              {text.delete}
            </button>
          </li>
        ))}
      </ul>
      <h3>{text.pous}</h3>
      <button
        onClick={() => {
          setDeleting(null);
          store.addFunction();
        }}
      >
        {text.addFunction}
      </button>
      <button
        onClick={() => {
          setDeleting(null);
          store.addFunctionBlock();
        }}
      >
        {text.addFunctionBlock}
      </button>
      <ul>
        {state.pous.map((pou, index) => (
          <li key={index}>
            <button
              aria-pressed={state.selectedDataType === null && state.selectedPou === index}
              onClick={() => {
                setDeleting(null);
                store.selectPou(index);
              }}
            >
              <strong>{pou.name}</strong>
              <span>{text[pou.kind]}</span>
              <span>
                {text.diagnosticCount.replace(
                  "{count}",
                  String(
                    state.diagnostics.filter(
                      (diagnostic) => diagnosticPouSourceIndex(diagnostic) === index,
                    ).length,
                  ),
                )}
              </span>
            </button>
            <button
              disabled={pou.kind === "PROGRAM"}
              aria-label={text.deletePou.replace("{name}", pou.name)}
              onClick={() => setDeleting({ index, pou })}
            >
              {text.delete}
            </button>
          </li>
        ))}
      </ul>
      {target && target.kind !== "PROGRAM" && (
        <div role="group" aria-label={confirmation}>
          <p>{confirmation}</p>
          <button
            onClick={() => {
              if (target.kind === "TYPE") store.deleteDataType(deleting!.index);
              else store.deletePou(deleting!.index);
              setDeleting(null);
            }}
          >
            {text.confirmDelete}
          </button>
          <button onClick={() => setDeleting(null)}>{text.cancel}</button>
        </div>
      )}
    </section>
  );
}
