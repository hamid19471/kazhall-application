import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no layout engine; React Aria's popover positioning only needs these to exist.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
});
