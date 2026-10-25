import type { ShellCatalog } from "./catalog.js";
import type { AppState } from "./store.js";
import { imageReadings } from "./io-image.js";
export function IoImage({ state, text }: { state: AppState; text: ShellCatalog }) {
  const readings = imageReadings(state, text);
  return (
    <section className="panel" aria-labelledby="io-title">
      <h2 id="io-title">{text.io}</h2>
      {(["I", "Q"] as const).map((area) => (
        <div key={area} className="io-row">
          <h3>{area === "I" ? text.inputs : text.outputs}</h3>
          {readings
            .filter((v) => v.area === area)
            .map((reading) => (
              <output
                key={`${reading.address}:${reading.dataType}`}
                aria-label={reading.address}
                data-on={reading.active}
              >
                <span>{reading.address}</span>
                <strong>{reading.value}</strong>
              </output>
            ))}
        </div>
      ))}
    </section>
  );
}
