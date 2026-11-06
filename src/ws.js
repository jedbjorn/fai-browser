// Minimal RFC 6455 WebSocket server for the single extension peer on loopback.
//
// Scope, on purpose: text messages only, no extensions (permessage-deflate is never negotiated), one subprotocol
// chosen by the caller. The caller authenticates the upgrade request before calling acceptUpgrade(), so no frame
// from an unauthenticated peer is ever parsed.
//
// Frame rules enforced (close code in parentheses): RSV bits set (1002), unmasked client frame (1002), unknown
// opcode (1002), fragmented or oversized control frame (1002), unexpected continuation (1002), message over
// maxMessageBytes (1009), binary message (1003), invalid UTF-8 text (1007), malformed close payload (1002).
// Pings are answered automatically. The server pings every pingIntervalMs and terminates the socket after
// idleTimeoutMs without any inbound frame.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const PING_INTERVAL_MS = 20_000;
export const IDLE_TIMEOUT_MS = 45_000;
const CLOSE_TIMEOUT_MS = 1_000;

export const OPCODES = Object.freeze({ continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 });

const STATUS_TEXT = { 400: 'Bad Request', 403: 'Forbidden', 426: 'Upgrade Required', 500: 'Internal Server Error' };

/** Sec-WebSocket-Accept for a Sec-WebSocket-Key. */
export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** The offered subprotocols, in order. Node joins repeated headers with ", ". */
export function offeredProtocols(req) {
  const header = req.headers['sec-websocket-protocol'];
  if (typeof header !== 'string') return [];
  return header.split(',').map(value => value.trim()).filter(Boolean);
}

/**
 * Checks the RFC 6455 handshake fields. Returns null when the request is a valid upgrade, otherwise
 * {status, message} for rejectUpgrade().
 */
export function checkHandshake(req) {
  if (req.method !== 'GET') return { status: 400, message: 'WebSocket upgrade must use GET' };
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    return { status: 400, message: 'Upgrade: websocket required' };
  }
  const connection = String(req.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim());
  if (!connection.includes('upgrade')) return { status: 400, message: 'Connection: upgrade required' };
  if (req.headers['sec-websocket-version'] !== '13') {
    return { status: 426, message: 'WebSocket version 13 required', headers: { 'Sec-WebSocket-Version': '13' } };
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) {
    return { status: 400, message: 'Invalid Sec-WebSocket-Key' };
  }
  return null;
}

/** Answers an upgrade request with a plain HTTP error and closes the socket. No WebSocket is created. */
export function rejectUpgrade(socket, status, message = '', extraHeaders = {}) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message });
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'Connection: close',
    'Content-Type: application/json',
    'Cache-Control: no-store',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
  socket.destroySoon?.();
}

/**
 * Encodes one frame. Server frames are unmasked; pass `mask: true` (or a 4-byte Buffer) to build a client frame,
 * which tests use to drive the server.
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = false, rsv = 0 } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = data.length;
  let headerLength = 2;
  if (length >= 65_536) headerLength += 8;
  else if (length >= 126) headerLength += 2;
  const maskKey = mask ? (Buffer.isBuffer(mask) ? mask : Buffer.from([0x37, 0xfa, 0x21, 0x3d])) : null;
  if (maskKey) headerLength += 4;
  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = (fin ? 0x80 : 0) | ((rsv & 7) << 4) | (opcode & 0x0f);
  const maskBit = maskKey ? 0x80 : 0;
  let offset = 2;
  if (length >= 65_536) {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  } else if (length >= 126) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame[1] = maskBit | length;
  }
  if (maskKey) {
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < length; i++) frame[offset + i] = data[i] ^ maskKey[i & 3];
  } else {
    data.copy(frame, offset);
  }
  return frame;
}

/** Close frame payload: 2-byte code plus UTF-8 reason (truncated to fit the 125-byte control limit). */
export function closePayload(code, reason = '') {
  if (code === undefined || code === null) return Buffer.alloc(0);
  const text = Buffer.from(String(reason)).subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.closeCode = code;
  }
}

function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
}

/**
 * Incremental frame parser. push(chunk) returns the decoded events:
 * {type:'message', text} | {type:'ping', payload} | {type:'pong', payload} | {type:'close', code, reason}.
 * Throws ProtocolError (with .closeCode) on a violation. `requireMask:false` parses server frames (tests).
 */
export class FrameParser {
  constructor({ requireMask = true, maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
    this.requireMask = requireMask;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
    this.fragments = null; // {opcode, parts, length} while a fragmented message is open
    this.decoder = new TextDecoder('utf-8', { fatal: true });
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const events = [];
    for (;;) {
      const frame = this.#takeFrame();
      if (!frame) break;
      const event = this.#handleFrame(frame);
      if (event) events.push(event);
    }
    return events;
  }

  #takeFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const fin = (buffer[0] & 0x80) !== 0;
    const rsv = buffer[0] & 0x70;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (rsv) throw new ProtocolError(1002, 'RSV bits set without a negotiated extension');
    if (this.requireMask && !masked) throw new ProtocolError(1002, 'Client frames must be masked');
    if (!this.requireMask && masked) throw new ProtocolError(1002, 'Server frames must not be masked');
    const control = opcode >= 8;
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new ProtocolError(1002, `Unknown opcode ${opcode}`);
    if (control && (!fin || length > 125)) throw new ProtocolError(1002, 'Invalid control frame');
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      if (length < 126) throw new ProtocolError(1002, 'Non-minimal payload length');
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      const big = buffer.readBigUInt64BE(2);
      if (big & (1n << 63n)) throw new ProtocolError(1002, 'Reserved payload length bit set');
      if (big < 65_536n) throw new ProtocolError(1002, 'Non-minimal payload length');
      if (big > BigInt(this.maxMessageBytes)) throw new ProtocolError(1009, 'Message too big');
      length = Number(big);
      offset = 10;
    }
    if (!control) {
      const already = this.fragments?.length ?? 0;
      if (already + length > this.maxMessageBytes) throw new ProtocolError(1009, 'Message too big');
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return null;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (masked) {
      for (let i = 0; i < length; i++) payload[i] ^= buffer[maskOffset + (i & 3)];
    }
    this.buffer = buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    if (opcode === OPCODES.ping) return { type: 'ping', payload };
    if (opcode === OPCODES.pong) return { type: 'pong', payload };
    if (opcode === OPCODES.close) return this.#closeEvent(payload);
    if (opcode === OPCODES.continuation) {
      if (!this.fragments) throw new ProtocolError(1002, 'Continuation frame without a message');
    } else {
      if (this.fragments) throw new ProtocolError(1002, 'New message before the previous one finished');
      if (opcode === OPCODES.binary) throw new ProtocolError(1003, 'Binary messages are not supported');
      this.fragments = { opcode, parts: [], length: 0 };
    }
    this.fragments.parts.push(payload);
    this.fragments.length += payload.length;
    if (!fin) return null;
    const data = Buffer.concat(this.fragments.parts, this.fragments.length);
    this.fragments = null;
    let text;
    try {
      text = this.decoder.decode(data);
    } catch {
      throw new ProtocolError(1007, 'Invalid UTF-8 in text message');
    }
    return { type: 'message', text };
  }

  #closeEvent(payload) {
    if (payload.length === 0) return { type: 'close', code: 1005, reason: '' };
    if (payload.length === 1) throw new ProtocolError(1002, 'Malformed close payload');
    const code = payload.readUInt16BE(0);
    if (!validCloseCode(code)) throw new ProtocolError(1002, `Invalid close code ${code}`);
    let reason;
    try {
      reason = this.decoder.decode(payload.subarray(2));
    } catch {
      throw new ProtocolError(1007, 'Invalid UTF-8 in close reason');
    }
    return { type: 'close', code, reason };
  }
}

/**
 * One server-side connection. Events: 'message' (text), 'close' ({code, reason}), 'pong'.
 * send(obj) writes JSON; sendText(string) writes raw text.
 */
export class WebSocketConnection extends EventEmitter {
  constructor(socket, { protocol = null, maxMessageBytes, pingIntervalMs, idleTimeoutMs } = {}) {
    super();
    this.socket = socket;
    this.protocol = protocol;
    this.readyState = 'open';
    this.parser = new FrameParser({ requireMask: true, maxMessageBytes: maxMessageBytes ?? MAX_MESSAGE_BYTES });
    this.closeInfo = null;
    this.closeTimer = null;
    socket.setNoDelay?.(true);
    socket.setTimeout?.(0);
    socket.on('data', chunk => this.#onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => this.#finish());
    socket.on('end', () => {
      if (this.readyState !== 'closed') socket.end();
    });
    this.pingTimer = setInterval(() => this.ping(), pingIntervalMs ?? PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    this.idleTimer = setTimeout(() => this.terminate(1006, 'idle timeout'), idleTimeoutMs ?? IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  get open() {
    return this.readyState === 'open';
  }

  send(value) {
    return this.sendText(JSON.stringify(value));
  }

  sendText(text) {
    if (this.readyState !== 'open') return false;
    this.socket.write(encodeFrame(OPCODES.text, Buffer.from(text)));
    return true;
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState !== 'open') return;
    this.socket.write(encodeFrame(OPCODES.ping, payload));
  }

  /** Starts the closing handshake. The socket is destroyed if the peer does not answer within 1 s. */
  close(code = 1000, reason = '') {
    if (this.readyState !== 'open') return;
    this.readyState = 'closing';
    this.closeInfo ??= { code, reason };
    this.socket.write(encodeFrame(OPCODES.close, closePayload(code, reason)));
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS);
    this.closeTimer.unref?.();
  }

  /** Drops the TCP connection without a closing handshake. */
  terminate(code = 1006, reason = '') {
    if (this.readyState === 'closed') return;
    this.closeInfo ??= { code, reason };
    this.socket.destroy();
    this.#finish();
  }

  #onData(chunk) {
    if (this.readyState === 'closed') return;
    this.idleTimer.refresh();
    let events;
    try {
      events = this.parser.push(chunk);
    } catch (error) {
      if (this.readyState === 'open') this.close(error.closeCode ?? 1002, error.message);
      else this.terminate(error.closeCode ?? 1002, error.message);
      return;
    }
    for (const event of events) {
      if (event.type === 'message') {
        if (this.readyState === 'open') this.emit('message', event.text);
      } else if (event.type === 'ping') {
        if (this.readyState === 'open') this.socket.write(encodeFrame(OPCODES.pong, event.payload));
      } else if (event.type === 'pong') {
        this.emit('pong', event.payload);
      } else if (event.type === 'close') {
        this.#onClose(event);
        return;
      }
    }
  }

  // Peer-initiated close: echo the code, then end. A reply to our own close just ends the socket.
  #onClose({ code, reason }) {
    if (this.readyState === 'open') {
      this.readyState = 'closing';
      this.closeInfo ??= { code, reason };
      this.socket.write(encodeFrame(OPCODES.close, code === 1005 ? Buffer.alloc(0) : closePayload(code)));
    }
    this.socket.end();
    this.closeTimer ??= setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS);
    this.closeTimer.unref?.();
  }

  #finish() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    clearInterval(this.pingTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.closeTimer);
    this.emit('close', this.closeInfo ?? { code: 1006, reason: '' });
  }
}

/**
 * Completes the handshake on an already authenticated upgrade request and returns the connection.
 * Answers 400/426 itself (returning null) when the handshake fields are invalid.
 */
export function acceptUpgrade(req, socket, head, options = {}) {
  const invalid = checkHandshake(req);
  if (invalid) {
    rejectUpgrade(socket, invalid.status, invalid.message, invalid.headers);
    return null;
  }
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
  ];
  if (options.protocol) lines.push(`Sec-WebSocket-Protocol: ${options.protocol}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const connection = new WebSocketConnection(socket, options);
  if (head?.length) socket.unshift(head);
  return connection;
}
