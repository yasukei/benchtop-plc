import type { HaltedMessage } from "@benchtop-plc/core";
import type { ShellCatalog } from "./catalog.js";
import { formatCallValue } from "./debugging.js";

export function CallStack({
  halted,
  selected,
  select,
  text,
}: {
  halted: HaltedMessage;
  selected: number;
  select: (index: number) => void;
  text: ShellCatalog;
}) {
  const frame = halted.frames[selected];
  return (
    <section className="panel call-stack" aria-label={text.callStack}>
      <h2>{text.callStack}</h2>
      <ol>
        {halted.frames.map((frame, index) => (
          <li key={index}>
            <button aria-pressed={selected === index} onClick={() => select(index)}>
              {text.frameLocation
                .replace("{pou}", frame.pou)
                .replace("{line}", String(frame.span.line))
                .replace("{instance}", frame.instance ?? text.functionInstance)}
            </button>
          </li>
        ))}
      </ol>
      {frame && frame.values.length > 0 && (
        <dl aria-label={text.frameValues}>
          {frame.values.map((variable) => (
            <div key={variable.name}>
              <dt>{variable.name}</dt>
              <dd>
                {formatCallValue(variable.value)}
                {variable.actual && (
                  <small>
                    {"path" in variable.actual
                      ? text.frameActual.replace("{path}", variable.actual.path)
                      : text.frameLocalActual
                          .replace("{frame}", String(variable.actual.frame))
                          .replace("{name}", variable.actual.name)}
                  </small>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
