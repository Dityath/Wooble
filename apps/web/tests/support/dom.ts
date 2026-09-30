/**
 * Preloaded for the web suite only (see the root `test:web` script). API tests need Bun's own
 * fetch, Request, and Response, so the DOM must not be registered for them.
 */
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:5173/", width: 1280, height: 800 });

// React Flow measures its viewport and nodes with these browser APIs, which happy-dom does not provide.
// Observed elements are reported once, as a browser does after layout, so nodes count as measured.
class ResizeObserverStub {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const { offsetWidth: width, offsetHeight: height } = target as HTMLElement;
    const size = [{ inlineSize: width, blockSize: height }];
    const entry = { target, contentRect: { width, height }, borderBoxSize: size, contentBoxSize: size };
    queueMicrotask(() => this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
window.ResizeObserver = globalThis.ResizeObserver;
class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
    this.m22 = scale ? Number(scale) : 1;
  }
}
for (const scope of [globalThis, window] as Array<{ DOMMatrixReadOnly?: unknown }>)
  scope.DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub;
// happy-dom does no layout. Elements report their inline pixel size (React Flow sizes nodes inline) or a
// small default, so the viewport and nodes have measurable dimensions.
const inlineSize = (element: HTMLElement, property: "width" | "height", fallback: number) =>
  Number.parseFloat(element.style?.[property] ?? "") || fallback;
Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return inlineSize(this, "height", 100);
    },
  },
  offsetWidth: {
    configurable: true,
    get(this: HTMLElement) {
      return inlineSize(this, "width", 200);
    },
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack Router resolves matches asynchronously after navigation, outside act(). Tests wait for the
// resulting UI with findBy/waitFor, so these specific warnings are noise. Every other error still prints.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("was not wrapped in act(")) return;
  consoleError(...args);
};

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
