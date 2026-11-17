import { expect, test } from "vitest";
import { RateCounter } from "../src/metrics";

test("RateCounter averages events over the sliding window", () => {
  let now = 1_000_000;
  const rate = new RateCounter(10, () => now);

  rate.record(20);
  now += 1000;
  rate.record(10);
  expect(rate.perSecond()).toBe(3); // 30 events / 10 s

  now += 9000; // the first bucket falls out of the window
  expect(rate.perSecond()).toBe(1);

  now += 5000;
  expect(rate.perSecond()).toBe(0);
});
