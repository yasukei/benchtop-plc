import { useSyncExternalStore } from "react";
import { bannerFor } from "./banner.js";
import { en, type ShellCatalog } from "./catalog.js";
import { demoSource } from "./demo.js";
import { rejectionText } from "./rejection.js";
import { cycleOptions, type AppStore } from "./store.js";

export function App({ store, text = en }: { store: AppStore; text?: ShellCatalog }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const disconnected = state.connection !== "connected";
  const stopped = state.runtimeState === "STOP";
  const banner = bannerFor(state);

  return (
    <div className="workbench" data-theme={state.theme}>
      <header className="app-header">
        <div>
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
        </div>
        <label>
          {text.theme}
          <select
            value={state.theme}
            onChange={(event) => store.setTheme(event.target.value as "light" | "dark")}
          >
            <option value="light">{text.light}</option>
            <option value="dark">{text.dark}</option>
          </select>
        </label>
      </header>
      <main>
        <section className="toolbar" aria-label={text.toolbar}>
          <div className="actions">
            <button
              className="run"
              disabled={disconnected || !stopped}
              onClick={() => store.send({ type: "run" })}
            >
              {text.run}
            </button>
            <button disabled={disconnected} onClick={() => store.send({ type: "stop" })}>
              {text.stop}
            </button>
            <button
              disabled={disconnected || !stopped}
              onClick={() => store.send({ type: "step" })}
            >
              {text.step}
            </button>
            <button disabled={disconnected} onClick={() => store.send({ type: "coldReset" })}>
              {text.reset}
            </button>
            <label>
              {text.cycle}
              <select
                disabled={disconnected}
                value={state.cycleMs}
                onChange={(event) =>
                  store.send({ type: "setCycle", ms: Number(event.target.value) })
                }
              >
                {cycleOptions.map((ms) => (
                  <option value={ms} key={ms}>
                    {ms}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="telemetry">
            <output aria-label={text.state} className="state" data-state={state.runtimeState}>
              {state.runtimeState === "ESTOP" ? "E-STOP" : state.runtimeState}
            </output>
            <span>
              {text.scans}:{" "}
              <output aria-label={text.scans}>{state.snapshot?.scanCount ?? 0}</output>
            </span>
            <span>
              {text.execution}:{" "}
              <output aria-label={text.execution}>
                {(state.snapshot?.lastExecutionTimeMs ?? 0).toFixed(3)}
              </output>
            </span>
          </div>
        </section>
        <div
          className="banner"
          data-urgent={banner.urgent}
          role={banner.urgent ? "alert" : "status"}
        >
          {text[banner.key]}
        </div>
        {state.rejection && (
          <div className="banner" role="alert" data-urgent="false">
            {rejectionText(state.rejection, text)}
          </div>
        )}
        <div className="workspace">
          <section className="panel editor" aria-labelledby="editor-title">
            <div className="panel-heading">
              <h2 id="editor-title">{text.editor}</h2>
              <span>{text.fixture}</span>
            </div>
            <pre>
              <code>{demoSource}</code>
            </pre>
          </section>
          <div className="side-panels">
            <section className="panel" aria-labelledby="operator-title">
              <h2 id="operator-title">{text.operator}</h2>
              <p>{text.operatorHint}</p>
            </section>
            <section className="panel" aria-labelledby="io-title">
              <h2 id="io-title">{text.io}</h2>
              <p>{text.ioHint}</p>
            </section>
            <section className="panel" aria-labelledby="monitor-title">
              <h2 id="monitor-title">{text.monitor}</h2>
              <p>{text.monitorHint}</p>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
