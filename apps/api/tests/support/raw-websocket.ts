import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";

export type RawMessage = { type: string } & Record<string, unknown>;

/**
 * A websocket client that upgrades by hand and never answers a close frame, so the server stays in its
 * close window until it terminates the TCP connection. The connection stays half-open, so a FIN from
 * the server alone does not close the client side; only the end of the server's socket does. It records every data frame that arrives
 * after the server's close frame separately.
 */
export type RawWebSocket = {
  /** Data frames received before the server's close frame. */
  messages: RawMessage[];
  /** Data frames received after the server's close frame. */
  afterClose: RawMessage[];
  /** The server's close frame, once received. */
  closeFrame: { code: number; reason: string } | null;
  /** Resolves when the TCP connection ends, however it ends. */
  tcpClosed: Promise<void>;
  isTcpClosed: () => boolean;
  send: (message: object) => void;
  destroy: () => void;
};

export async function openRawWebSocket(url: string, headers: Record<string, string>): Promise<RawWebSocket> {
  const target = new URL(url);
  const socket: Socket = connect({ host: target.hostname, port: Number(target.port), allowHalfOpen: true });
  let tcpClosedFlag = false;
  const tcpClosed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      tcpClosedFlag = true;
      resolve();
    });
  });
  socket.on("error", () => {});
  const raw: RawWebSocket = {
    messages: [],
    afterClose: [],
    closeFrame: null,
    tcpClosed,
    isTcpClosed: () => tcpClosedFlag,
    send(message) {
      const payload = Buffer.from(JSON.stringify(message));
      if (payload.length > 125) throw new Error("Raw client sends short frames only");
      const mask = randomBytes(4);
      const body = Buffer.from(payload.map((byte, index) => byte ^ (mask[index % 4] as number)));
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, body]));
    },
    destroy: () => socket.destroy(),
  };

  let buffer: Buffer = Buffer.alloc(0);
  let upgraded = false;
  let resolveUpgrade!: () => void;
  let rejectUpgrade!: (error: Error) => void;
  const upgrade = new Promise<void>((resolve, reject) => {
    resolveUpgrade = resolve;
    rejectUpgrade = reject;
  });

  function parseFrames() {
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = (buffer[0] as number) & 0x0f;
      let length = (buffer[1] as number) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 1) {
        (raw.closeFrame ? raw.afterClose : raw.messages).push(JSON.parse(payload.toString("utf8")) as RawMessage);
      } else if (opcode === 8 && !raw.closeFrame) {
        raw.closeFrame = {
          code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
          reason: payload.subarray(2).toString("utf8"),
        };
      }
    }
  }

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 4);
      if (!head.startsWith("HTTP/1.1 101")) {
        rejectUpgrade(new Error(`Upgrade refused: ${head.split("\r\n")[0]}`));
        return;
      }
      upgraded = true;
      resolveUpgrade();
    }
    parseFrames();
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const lines = [
    `GET ${target.pathname} HTTP/1.1`,
    `Host: ${target.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  await upgrade;
  parseFrames();
  // The server's FIN alone does not close this half-open client, so probe with pings: once the
  // server terminates its side, a write is reset and the connection closes.
  const ping = Buffer.from([0x89, 0x80, 1, 2, 3, 4]);
  const probe = setInterval(() => {
    if (!socket.destroyed) socket.write(ping);
  }, 25);
  void tcpClosed.then(() => clearInterval(probe));
  return raw;
}
