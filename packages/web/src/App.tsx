import {
  diagnosticPouIndex,
  diagnosticSourceMatches,
  pouSources,
  sameSources,
  type EditorDiagnostic,
} from "./pous.js";
import { PouList } from "./PouList.js";
import { OperatorPanel } from "./panel/OperatorPanel.js";
import { VariableMonitor } from "./VariableMonitor.js";
import { IoImage } from "./IoImage.js";
import { TaskStatus } from "./TaskStatus.js";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { bannerFor } from "./banner.js";
import { catalogs } from "./catalog.js";
import { StEditor, type StEditorHandle } from "./editor/StEditor.js";
import { formatDiagnostic } from "./diagnostic-catalog.js";
import { isLanguage, type I18n } from "./i18n.js";
import { cycleOptions, type AppStore } from "./store.js";
import { isTheme, type ThemeStore } from "./theme.js";

export function App({ store, i18n, theme }: { store: AppStore; i18n: I18n; theme: ThemeStore }) {
  const appearance = useSyncExternalStore(theme.subscribe, theme.getSnapshot);
  const language = useSyncExternalStore(i18n.subscribe, i18n.getSnapshot);
  const text = catalogs[language];
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const loadedIr = state.loadedIr;
  const variables = loadedIr?.variables ?? [];
  const disconnected = state.connection !== "connected";
  const stopped = state.runtimeState === "STOP";
  const banner = bannerFor(state);
  const editor = useRef<StEditorHandle>(null);
  const unapplied =
    !sameSources(pouSources(state.pous), state.loadedSources) ||
    !sameSources(pouSources(state.dataTypes), state.loadedDataTypes) ||
    (state.configuration?.source ?? null) !== state.loadedConfigurationSource;
  const online = !unapplied && !disconnected;
  const selected =
    !state.selectedConfiguration && state.selectedDataType === null
      ? state.pous[state.selectedPou]
      : undefined;
  const inlineInstance = loadedIr?.resource.programs.find(
    (instance) =>
      loadedIr.programs[instance.program]!.name.toUpperCase() === selected?.name.toUpperCase(),
  );
  const faultIndex = state.diagnostic
    ? (state.diagnostic.sourceIndex ?? diagnosticPouIndex(state.pous, state.diagnostic))
    : undefined;
  const diagnostics: EditorDiagnostic[] =
    online && state.diagnostic
      ? [...state.diagnostics, { ...state.diagnostic, sourceIndex: faultIndex }]
      : state.diagnostics;
  const pendingFocus = useRef<EditorDiagnostic | null>(null);
  useLayoutEffect(() => {
    if (pendingFocus.current?.span) editor.current?.focusSpan(pendingFocus.current.span);
    pendingFocus.current = null;
  }, [state.editorSession]);

  return (
    <div className="workbench" data-theme={appearance.resolved}>
      <header className="app-header">
        <div>
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
        </div>
        <label>
          {text.language}
          <select
            value={language}
            onChange={(event) => {
              const next = event.target.value;
              if (isLanguage(next)) i18n.setLanguage(next);
            }}
          >
            <option value="en">{text.english}</option>
            <option value="ja">{text.japanese}</option>
          </select>
        </label>
        <label>
          {text.theme}
          <select
            value={appearance.selection}
            onChange={(event) => {
              const next = event.target.value;
              if (isTheme(next)) theme.setTheme(next);
            }}
          >
            <option value="system">{text.system}</option>
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
              disabled={
                state.emergencyActive ||
                disconnected ||
                (!stopped && !(state.runtimeState === "RUN" && unapplied))
              }
              onClick={() => store.run()}
            >
              {text.run}
            </button>
            <button disabled={disconnected} onClick={() => store.send({ type: "stop" })}>
              {text.stop}
            </button>
            <button
              disabled={disconnected || !stopped || unapplied}
              onClick={() => store.send({ type: "step" })}
            >
              {text.step}
            </button>
            <button disabled={disconnected} onClick={() => store.send({ type: "warmRestart" })}>
              {state.diagnostic || state.runtimeState === "FAULT"
                ? text.acknowledgeFault
                : text.warmRestart}
            </button>
            <button disabled={disconnected} onClick={() => store.send({ type: "coldReset" })}>
              {text.reset}
            </button>
            {!state.configuration && (
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
            )}
          </div>
          {state.configuration && loadedIr?.explicit && (
            <TaskStatus tasks={state.snapshot?.tasks ?? []} text={text} />
          )}
          <div className="telemetry">
            <output aria-label={text.state} className="state" data-state={state.runtimeState}>
              {state.runtimeState === "ESTOP" ? text.emergencyState : state.runtimeState}
            </output>
            <span>
              {text.scansLabel}{" "}
              <output aria-label={text.scans}>{state.snapshot?.scanCount ?? 0}</output>
            </span>
            <span>
              {text.executionLabel}{" "}
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
          {state.diagnostic && <p>{formatDiagnostic(language, state.diagnostic)}</p>}
        </div>
        {state.storageWarning && (
          <div className="banner" role="alert">
            {text.retentionStorageWarning}
          </div>
        )}
        {state.retentiveSkipped.length > 0 && (
          <div className="banner" role="alert">
            {text.retentionSkipped
              .replace("{count}", String(state.retentiveSkipped.length))
              .replace("{paths}", state.retentiveSkipped.join(", "))}
          </div>
        )}
        {state.rejection && (
          <div className="banner" role="alert" data-urgent="false">
            {formatDiagnostic(language, state.rejection.diagnostic)}
          </div>
        )}
        <div className="workspace">
          <section className="panel editor" aria-labelledby="editor-title">
            <div className="panel-heading">
              <h2 id="editor-title">{text.editor}</h2>
              {online && selected?.kind === "PROGRAM" && inlineInstance && (
                <span>{text.inlineInstance.replace("{name}", inlineInstance.name)}</span>
              )}
              <span className="apply-status" data-unapplied={unapplied}>
                {unapplied ? text.unapplied : text.applied}
              </span>
            </div>
            <div className="pou-workspace">
              <PouList state={state} store={store} text={text} />
              <StEditor
                ir={loadedIr}
                key={state.editorSession}
                ref={editor}
                source={state.source}
                sources={pouSources(state.pous)}
                dataTypes={pouSources(state.dataTypes)}
                sourceIndex={
                  !state.selectedConfiguration && state.selectedDataType === null
                    ? state.selectedPou
                    : -1
                }
                onChange={store.setSource}
                diagnostics={state.diagnostics.filter((diagnostic) =>
                  diagnosticSourceMatches(
                    diagnostic,
                    state.selectedPou,
                    state.selectedDataType,
                    state.selectedConfiguration,
                  ),
                )}
                snapshot={selected?.kind === "PROGRAM" && inlineInstance ? state.snapshot : null}
                online={online}
                pou={selected?.name}
                fault={
                  state.diagnostic &&
                  diagnosticSourceMatches(
                    { ...state.diagnostic, sourceIndex: faultIndex },
                    state.selectedPou,
                    state.selectedDataType,
                    state.selectedConfiguration,
                  )
                    ? state.diagnostic
                    : null
                }
                language={language}
              />
            </div>
            <section className="diagnostics" aria-labelledby="diagnostics-title">
              <h3 id="diagnostics-title">{text.diagnostics}</h3>
              {diagnostics.length === 0 ? (
                <p role="status">{text.noDiagnostics}</p>
              ) : (
                <ul>
                  {diagnostics.map((diagnostic, index) => (
                    <li key={index}>
                      <button
                        disabled={!diagnostic.span || diagnostic.sourceIndex === undefined}
                        onClick={() => {
                          const sourceIndex = diagnostic.sourceIndex;
                          if (
                            sourceIndex !== undefined &&
                            !diagnosticSourceMatches(
                              diagnostic,
                              state.selectedPou,
                              state.selectedDataType,
                              state.selectedConfiguration,
                            )
                          ) {
                            pendingFocus.current = diagnostic;
                            if (diagnostic.sourceKind === "configuration")
                              store.selectConfiguration();
                            else if (diagnostic.sourceKind === "dataType")
                              store.selectDataType(sourceIndex);
                            else store.selectPou(sourceIndex);
                          } else if (diagnostic.span) editor.current?.focusSpan(diagnostic.span);
                        }}
                      >
                        {diagnostic.pou && (
                          <span className="diagnostic-location">
                            {text.pouLocation.replace("{pou}", diagnostic.pou)}
                          </span>
                        )}
                        {diagnostic.span && (
                          <span className="diagnostic-location">
                            {text.location
                              .replace("{line}", String(diagnostic.span.line))
                              .replace("{column}", String(diagnostic.span.column))}
                          </span>
                        )}
                        {formatDiagnostic(language, diagnostic)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </section>
          <div className="side-panels">
            <OperatorPanel state={state} store={store} text={text} language={language} />
            <IoImage state={state} text={text} />
            <VariableMonitor
              key={JSON.stringify([
                state.loadedSources,
                state.loadedDataTypes,
                state.loadedConfigurationSource,
              ])}
              state={state}
              store={store}
              text={text}
              variables={variables}
              types={loadedIr?.types}
              composites={loadedIr?.composites}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
