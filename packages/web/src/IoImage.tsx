import type { ShellCatalog } from "./catalog.js";
import type { AppState } from "./store.js";
export function IoImage({ state, text }: { state: AppState; text: ShellCatalog }) {
  return (
    <section className="panel" aria-labelledby="io-title">
      <h2 id="io-title">{text.io}</h2>
      {(["I", "Q"] as const).map((area) => (
        <div key={area} className="io-row">
          <h3>{area === "I" ? text.inputs : text.outputs}</h3>
          {Array.from({ length: 8 }, (_, bit) => {
            const address = `%${area}X0.${bit}`;
            const active =
              area === "I"
                ? !!state.snapshot?.inputs[bit]
                : !state.emergencyActive &&
                  state.runtimeState === "RUN" &&
                  !!state.snapshot?.outputs[bit];
            return (
              <output key={bit} aria-label={address} data-on={active}>
                <span>{address}</span>
                <strong>{active ? text.on : text.off}</strong>
              </output>
            );
          })}
        </div>
      ))}
    </section>
  );
}
