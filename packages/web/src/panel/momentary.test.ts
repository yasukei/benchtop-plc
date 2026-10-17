import { expect, it, vi } from "vitest";
import { createMomentaryInput } from "./momentary.js";

it("keeps input ON across overlapping pointer/key holds and ignores key repeat", () => {
  const send = vi.fn();
  const input = createMomentaryInput(send);
  input.set("Space", true);
  input.set("Space", true);
  input.set("pointer:1", true);
  input.set("pointer:2", true);
  input.set("Space", false);
  input.set("pointer:1", false);
  expect(send.mock.calls).toEqual([[true]]);
  input.set("pointer:2", false);
  input.set("pointer:2", false);
  expect(send.mock.calls).toEqual([[true], [false]]);
});
it("releases all holds exactly once on blur, hiding or unmount", () => {
  const send = vi.fn();
  const input = createMomentaryInput(send);
  input.set("Enter", true);
  input.set("pointer:1", true);
  input.release();
  input.release();
  input.set("Enter", false);
  expect(send.mock.calls).toEqual([[true], [false]]);
  input.set("Space", true);
  expect(send.mock.calls.at(-1)).toEqual([true]);
});
