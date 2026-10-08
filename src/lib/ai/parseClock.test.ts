import { describe, expect, it } from "vitest";
import { parseClockMs } from "./timeline";

describe("parseClockMs", () => {
  it("reads m:ss and h:mm:ss, bracketed or not", () => {
    expect(parseClockMs("[0:08]")).toBe(8_000);
    expect(parseClockMs("1:05")).toBe(65_000);
    expect(parseClockMs("[1:02:03]")).toBe(3_723_000);
    expect(parseClockMs("around 12:34 or so")).toBe(754_000);
  });

  it("reads minutes past 100 as minutes, not as their last two digits", () => {
    expect(parseClockMs("[102:30]")).toBe(6_150_000);
    expect(parseClockMs("1000:00")).toBe(60_000_000);
    expect(parseClockMs("[1:42:30]")).toBe(6_150_000);
  });

  it("is null when there is no clock", () => {
    expect(parseClockMs("soon")).toBeNull();
    expect(parseClockMs("")).toBeNull();
    expect(parseClockMs(undefined)).toBeNull();
  });
});
