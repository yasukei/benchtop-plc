import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createBrowserI18n } from "./i18n.js";
import { RuntimeClient } from "./runtime-client.js";
import { createAppStore } from "./store.js";
import { createAutosave, readAutosave } from "./autosave.js";
import { browserStorage } from "./browser-storage.js";
import { createBrowserTheme } from "./theme.js";
import "./style.css";

const client = new RuntimeClient(
  new Worker(new URL("./runtime.worker.ts", import.meta.url), { type: "module" }),
);
const storage = browserStorage();
const saved = readAutosave(storage);
const store = createAppStore(client, saved ?? "");
if (saved) {
  store.send({ type: "setCycle", ms: saved.cycleMs });
  store.loadEditor();
} else store.restoreExample();
const autosave = createAutosave(store, storage);
const saveWhenHidden = () => {
  if (document.visibilityState === "hidden") autosave.flush();
};
window.addEventListener("pagehide", autosave.flush);
document.addEventListener("visibilitychange", saveWhenHidden);
const element = document.getElementById("root");
if (!element) throw new Error("Missing app root");
const root = createRoot(element);
const i18n = createBrowserI18n();
const theme = createBrowserTheme();
root.render(<App store={store} i18n={i18n} theme={theme} />);

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    window.removeEventListener("pagehide", autosave.flush);
    document.removeEventListener("visibilitychange", saveWhenHidden);
    autosave.dispose();
    theme.dispose();
    store.dispose();
    client.dispose();
  });
