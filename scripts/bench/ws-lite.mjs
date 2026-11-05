// Minimal RFC6455 WebSocket framing — just enough to run a real bidirectional text-message
// echo server/client for the soak test, without pulling in the `ws` package. No fragmentation,
// no binary frames, no extensions: text frames (opcode 0x1), ping/pong/close only.
import crypto from "node:crypto";

export const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKeyFor(clientKey) {
  return crypto.createHash("sha1").update(clientKey + WS_MAGIC).digest("base64");
}

// masked: true for client->server frames (required by RFC6455), false for server->client.
export function encodeFrame(payload, { opcode = 0x1, masked = false } = {}) {
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = payloadBuf.length;
  const maskBytes = masked ? crypto.randomBytes(4) : null;

  let headerLen = 2;
  if (len >= 65536) headerLen += 8;
  else if (len >= 126) headerLen += 2;
  if (masked) headerLen += 4;

  const header = Buffer.alloc(headerLen);
  header[0] = 0x80 | opcode; // FIN=1
  let offset = 2;
  if (len < 126) {
    header[1] = (masked ? 0x80 : 0) | len;
  } else if (len < 65536) {
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }
  if (masked) {
    maskBytes.copy(header, offset);
  }

  let body = payloadBuf;
  if (masked) {
    body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = payloadBuf[i] ^ maskBytes[i % 4];
  }
  return Buffer.concat([header, body]);
}

/**
 * Feeds bytes into a per-connection accumulator and yields complete frames as
 * { opcode, payload } as soon as each one is fully buffered. Returns the leftover bytes.
 */
export function createFrameParser() {
  let buf = Buffer.alloc(0);
  return function parse(chunk) {
    buf = Buffer.concat([buf, chunk]);
    const frames = [];
    while (true) {
      if (buf.length < 2) break;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      let maskBytes;
      if (masked) {
        if (buf.length < offset + 4) break;
        maskBytes = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) break;
      let payload = buf.subarray(offset, offset + len);
      if (masked) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskBytes[i % 4];
        payload = unmasked;
      }
      frames.push({ opcode, payload: Buffer.from(payload) });
      buf = buf.subarray(offset + len);
    }
    return frames;
  };
}
