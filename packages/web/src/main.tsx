import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createBrowserI18n } from "./i18n.js";
import { demoProgram } from "./demo.js";
import { RuntimeClient } from "./runtime-client.js";
import { createAppStore } from "./store.js";
import "./style.css";

const client = new RuntimeClient(
  new Worker(new URL("./runtime.worker.ts", import.meta.url), { type: "module" }),
);
const store = createAppStore(client);
store.send({ type: "load", ir: demoProgram });
const element = document.getElementById("root");
if (!element) throw new Error("Missing app root");
const root = createRoot(element);
const i18n = createBrowserI18n();
root.render(<App store={store} i18n={i18n} />);

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    store.dispose();
    client.dispose();
  });
