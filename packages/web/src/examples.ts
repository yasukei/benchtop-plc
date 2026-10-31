/** Metadata stays in the main bundle; project XML is fetched only when selected. */
export const bundledExamples = [
  { id: "batch-mixer", name: "exampleBatchMixer", description: "exampleBatchMixerDescription" },
  { id: "blink", name: "exampleBlink", description: "exampleBlinkDescription" },
  {
    id: "motor-starters",
    name: "exampleMotorStarters",
    description: "exampleMotorStartersDescription",
  },
  {
    id: "running-light",
    name: "exampleRunningLight",
    description: "exampleRunningLightDescription",
  },
  {
    id: "sorting-conveyor",
    name: "exampleSortingConveyor",
    description: "exampleSortingConveyorDescription",
  },
  { id: "tank-station", name: "exampleTankStation", description: "exampleTankStationDescription" },
] as const;

export type ExampleId = (typeof bundledExamples)[number]["id"];

const projects = import.meta.glob<string>("../../../examples/*/project.xml", {
  query: "?raw",
  import: "default",
});

export function loadExample(id: ExampleId): Promise<string> {
  return projects[`../../../examples/${id}/project.xml`]!();
}
