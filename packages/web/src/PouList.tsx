import { useState } from "react";
import { diagnosticPouSourceIndex, type EditorPou } from "./pous.js";
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
  const [deleting, setDeleting] = useState<{ index: number; pou: EditorPou } | null>(null);
  const target = deleting && state.pous[deleting.index] === deleting.pou ? deleting.pou : undefined;
  return (
    <section className="pou-list" aria-label={text.pous}>
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
              aria-pressed={state.selectedPou === index}
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
        <div role="group" aria-label={text.confirmDeletePou.replace("{name}", target.name)}>
          <p>{text.confirmDeletePou.replace("{name}", target.name)}</p>
          <button
            onClick={() => {
              store.deletePou(deleting!.index);
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
