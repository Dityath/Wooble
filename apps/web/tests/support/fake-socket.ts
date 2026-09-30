import { act } from "@testing-library/react";

/** A controllable stand-in for the browser WebSocket used by live canvas collaboration. */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: URL) {
    FakeSocket.instances.push(this);
  }
  static latest() {
    return FakeSocket.instances.at(-1) as FakeSocket;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    act(() => this.onopen?.());
  }
  receive(message: unknown) {
    act(() => this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) }));
  }
  drop(code: number) {
    this.readyState = FakeSocket.CLOSED;
    act(() => this.onclose?.({ code }));
  }
}

const originalWebSocket = globalThis.WebSocket;

export function installFakeSocket() {
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
}

export function restoreWebSocket() {
  globalThis.WebSocket = originalWebSocket;
}
