// A minimal Marionette client (Firefox's own remote protocol, enabled with -marionette) for scripts/firefox-smoke.mjs:
// no geckodriver and no npm package. Frames are "<length>:<json>"; a command is [0, id, name, params], its answer
// [1, id, error, result]. Only used against a throwaway Firefox profile; never against the user's own.
import net from 'node:net';

export class Marionette {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.greeting = null;
    this.greeted = new Promise(resolve => { this.onGreeting = resolve; });
    socket.on('data', chunk => this.receive(chunk));
    socket.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Marionette connection closed'));
      this.pending.clear();
    });
  }

  /** Connects to 127.0.0.1:`port`, retrying until `timeoutMs` (Firefox opens the port a moment after start). */
  static async connect(port, { timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const candidate = net.connect(port, '127.0.0.1', () => resolve(candidate));
          candidate.once('error', reject);
        });
        const client = new Marionette(socket);
        await client.greeted;
        return client;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise(done => setTimeout(done, 250));
      }
    }
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const colon = this.buffer.indexOf(0x3a);
      if (colon < 0) return;
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (this.buffer.length < colon + 1 + length) return;
      const message = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString());
      this.buffer = this.buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) {
        this.greeting = message;
        this.onGreeting(message);
        continue;
      }
      const [, id, error, result] = message;
      const entry = this.pending.get(id);
      if (!entry) continue;
      this.pending.delete(id);
      if (error) entry.reject(Object.assign(new Error(`${error.error}: ${error.message}`), { marionette: error }));
      else entry.resolve(result);
    }
  }

  send(name, params = {}) {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify([0, id, name, params]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(Buffer.concat([Buffer.from(`${body.length}:`), body]));
    });
  }

  newSession(capabilities = {}) {
    return this.send('WebDriver:NewSession', { capabilities: { alwaysMatch: capabilities } });
  }

  /** 'content' (web pages) or 'chrome' (the privileged browser window). */
  setContext(value) {
    return this.send('Marionette:SetContext', { value });
  }

  /** Runs `script` (a function body; `arguments` holds `args`) in the current context; resolves its return value. */
  async execute(script, args = [], { async = false } = {}) {
    const result = await this.send(async ? 'WebDriver:ExecuteAsyncScript' : 'WebDriver:ExecuteScript', { script, args });
    return result?.value;
  }

  installAddon(path, { temporary = true } = {}) {
    return this.send('Addon:Install', { path, temporary });
  }

  navigate(url) {
    return this.send('WebDriver:Navigate', { url });
  }

  close() {
    this.socket.destroy();
  }
}
