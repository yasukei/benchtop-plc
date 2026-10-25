import type { TaskTelemetry } from "@benchtop-plc/core";
import type { en } from "./catalog.js";

export function TaskStatus({
  tasks,
  text,
}: {
  tasks: readonly TaskTelemetry[];
  text: Record<keyof typeof en, string>;
}) {
  return (
    <div className="task-status-scroll">
      <table className="task-status" aria-label={text.tasks}>
        <thead>
          <tr>
            <th scope="col">{text.taskName}</th>
            <th scope="col">{text.taskRuns}</th>
            <th scope="col">{text.taskLast}</th>
            <th scope="col">{text.taskMaximum}</th>
            <th scope="col">{text.taskOverruns}</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.name}>
              <th scope="row">{task.name}</th>
              <td>
                <output aria-label={text.taskRuns}>{task.runCount}</output>
              </td>
              <td>{task.lastExecutionTimeMs.toFixed(3)}</td>
              <td>{task.maxExecutionTimeMs.toFixed(3)}</td>
              <td>{task.overruns}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
