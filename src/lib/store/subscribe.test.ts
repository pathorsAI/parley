import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));

import { useStore } from "../store";
import { subscribeDebounced, subscribeSelected } from "./subscribe";
import { createDebouncer } from "../debounce";

const INITIAL = useStore.getInitialState();
beforeEach(() => {
  useStore.setState(INITIAL, true);
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("subscribeSelected", () => {
  it("fires synchronously, only when the selected value changes", () => {
    const fn = vi.fn();
    const un = subscribeSelected((s) => s.meetingContext, fn);
    useStore.getState().setHighlightMs(5);
    expect(fn).not.toHaveBeenCalled();
    useStore.getState().setMeetingContext("a");
    expect(fn).toHaveBeenCalledWith("a");
    un();
    useStore.getState().setMeetingContext("b");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a skipped change still becomes the new baseline", () => {
    const fn = vi.fn();
    let echo = true;
    subscribeSelected((s) => s.meetingContext, fn, { skip: () => echo });
    useStore.getState().setMeetingContext("from file");
    echo = false;
    useStore.getState().setHighlightMs(1);
    expect(fn).not.toHaveBeenCalled();
    useStore.getState().setMeetingContext("edit");
    expect(fn).toHaveBeenCalledWith("edit");
  });
});

describe("subscribeDebounced", () => {
  it("runs once, ms after the last change of a burst", () => {
    const fn = vi.fn();
    subscribeDebounced((s) => s.meetingContext, 400, fn);
    useStore.getState().setMeetingContext("a");
    vi.advanceTimersByTime(300);
    useStore.getState().setMeetingContext("ab");
    vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("ab");
  });

  it("fireImmediately seeds one scheduled call", () => {
    const fn = vi.fn();
    subscribeDebounced((s) => s, 600, fn, { fireImmediately: true });
    vi.advanceTimersByTime(600);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stop cancels the pending call unless told to keep it", () => {
    const dropped = vi.fn();
    const kept = vi.fn();
    const stopA = subscribeDebounced((s) => s.meetingContext, 100, dropped);
    const stopB = subscribeDebounced((s) => s.meetingContext, 100, kept, { cancelOnStop: false });
    useStore.getState().setMeetingContext("x");
    stopA();
    stopB();
    vi.advanceTimersByTime(100);
    expect(dropped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it("an identity selector fires on every store update", () => {
    const fn = vi.fn();
    subscribeDebounced((s) => s, 10, fn);
    useStore.getState().resetPrep();
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("createDebouncer", () => {
  it("replaces the pending call and can cancel it", () => {
    const d = createDebouncer(50);
    const a = vi.fn();
    const b = vi.fn();
    d.schedule(a);
    d.schedule(b);
    vi.advanceTimersByTime(50);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    d.schedule(a);
    d.cancel();
    vi.advanceTimersByTime(50);
    expect(a).not.toHaveBeenCalled();
  });
});
