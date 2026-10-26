import { useState } from "react";
import type { ConfigurationIR } from "@benchtop-plc/core";
import type { ShellCatalog } from "./catalog.js";
import {
  filterInstances,
  instancesForSource,
  selectedInstance,
  type InstanceChoices,
} from "./instances.js";

export function InstancePicker({
  ir,
  pou,
  choices,
  select,
  text,
}: {
  ir: ConfigurationIR;
  pou: string;
  choices: InstanceChoices;
  select: (path: string) => void;
  text: ShellCatalog;
}) {
  const [filter, setFilter] = useState("");
  const instances = instancesForSource(ir, pou);
  const selected = selectedInstance(ir, pou, choices);
  const visible = filterInstances(instances, filter);
  return (
    <div className="instance-picker">
      {selected ? (
        <>
          <label>
            {text.inlineInstance}
            <select value={selected.path} onChange={(event) => select(event.target.value)}>
              {visible.map((instance) => (
                <option key={instance.path} value={instance.path}>
                  {instance.type.toUpperCase() === pou.toUpperCase()
                    ? instance.path
                    : `${instance.path} (${instance.type})`}
                </option>
              ))}
              {!visible.some((instance) => instance.path === selected.path) && (
                <option value={selected.path} hidden>
                  {selected.path}
                </option>
              )}
            </select>
          </label>
          <input
            type="search"
            aria-label={text.inlineInstanceFilter}
            placeholder={text.inlineInstanceFilter}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </>
      ) : (
        <span>{text.inlineNoInstance}</span>
      )}
    </div>
  );
}
