import { expect, it } from "vitest";
import { VirtualClock, VirtualTicker } from "./clock.js";

it("dispatches due callbacks in chronological and registration order across tickers", () => {
  const clock = new VirtualClock();
  const a = new VirtualTicker(clock),
    b = new VirtualTicker(clock);
  const seen: string[] = [];
  a.start(10, () => seen.push(`a:${clock.now()}`));
  b.start(15, () => seen.push(`b:${clock.now()}`));
  clock.advance(30);
  expect(seen).toEqual(["a:10", "b:15", "a:20", "a:30", "b:30"]);
  expect(clock.now()).toBe(30);
});

it("supports cancellation and starting a ticker during a callback", () => {
  const clock = new VirtualClock();
  const ticker = new VirtualTicker(clock);
  const seen: number[] = [];
  const cancel = ticker.start(10, () => {
    cancel();
    ticker.start(5, () => seen.push(clock.now()));
  });
  clock.advance(22);
  expect(seen).toEqual([15, 20]);
  cancel();
  expect(clock.now()).toBe(22);
});

it("does not run cancelled callbacks at a shared deadline", () => {
  const clock = new VirtualClock();
  const ticker = new VirtualTicker(clock);
  ticker.start(10, () => cancel());
  const cancel = ticker.start(10, () => {
    throw new Error("Cancelled callback");
  });
  clock.advance(10);
});

it("rejects invalid intervals, backwards/nonfinite advances and nested advances", () => {
  const clock = new VirtualClock(),
    ticker = new VirtualTicker(clock);
  for (const ms of [0, -1, NaN, Infinity])
    expect(() => ticker.start(ms, () => {})).toThrow(RangeError);
  for (const ms of [-1, NaN, Infinity]) expect(() => clock.advance(ms)).toThrow(RangeError);
  ticker.start(10, () => expect(() => clock.advance(1)).toThrow());
  clock.advance(10);
  expect(clock.now()).toBe(10);
});

it("remains usable after a callback throws", () => {
  const clock = new VirtualClock(),
    ticker = new VirtualTicker(clock);
  const cancel = ticker.start(10, () => {
    throw new Error("Host error");
  });
  expect(() => clock.advance(20)).toThrow("Host error");
  expect(clock.now()).toBe(10);
  cancel();
  clock.advance(10);
  expect(clock.now()).toBe(20);
});
