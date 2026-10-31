export const cycleOptions = [10, 20, 50, 100] as const;
export type CycleMs = (typeof cycleOptions)[number];
