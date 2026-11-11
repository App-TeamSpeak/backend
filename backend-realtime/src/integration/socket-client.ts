// Minimal Engine.IO v4 / Socket.IO default-namespace client for real transport tests.
// Uses Node 24's WebSocket; no application dependency or production protocol change.
export class TestSocketClient {
  private ws: WebSocket;
  private queued: [string, unknown][] = [];
  private waiters: { event: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private id = 0;
  readonly received: [string, unknown][] = [];
  constructor(origin: string, auth: Record<string, unknown>) {
    const url = new URL(origin);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Local test sockets only');
    this.ws = new WebSocket(`ws://127.0.0.1:${url.port}/socket.io/?EIO=4&transport=websocket`);
    this.ws.addEventListener('message', ({ data }) => {
      const packet = String(data);
      if (packet.startsWith('0')) this.ws.send(`40${JSON.stringify(auth)}`);
      else if (packet === '2') this.ws.send('3');
      else if (packet.startsWith('40')) this.deliver('connect', JSON.parse(packet.slice(2)));
      else if (packet.startsWith('44')) this.deliver('connect_error', JSON.parse(packet.slice(2)));
      else if (packet.startsWith('42')) { const [event, payload] = JSON.parse(packet.slice(2)); this.deliver(event, payload); }
      else if (packet.startsWith('43')) {
        const bracket = packet.indexOf('[');
        this.deliver(`ack:${packet.slice(2, bracket)}`, JSON.parse(packet.slice(bracket))[0]);
      }
    });
    this.ws.addEventListener('close', () => this.deliver('disconnect', undefined));
    this.ws.addEventListener('error', () => this.deliver('transport_error', undefined));
  }
  private deliver(event: string, value: unknown) {
    this.received.push([event, value]);
    const index = this.waiters.findIndex((waiter) => waiter.event === event);
    if (index < 0) this.queued.push([event, value]);
    else { const [waiter] = this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(value); }
  }
  wait<T = any>(event: string): Promise<T> {
    const index = this.queued.findIndex(([name]) => name === event);
    if (index >= 0) return Promise.resolve(this.queued.splice(index, 1)[0][1] as T);
    return new Promise((resolve, reject) => {
      const waiter = { event, resolve, reject, timer: setTimeout(() => { this.waiters = this.waiters.filter((item) => item !== waiter); reject(new Error(`Missing socket event: ${event}`)); }, 3000) };
      this.waiters.push(waiter);
    });
  }
  send(event: string, payload?: unknown) { this.ws.send(`42${JSON.stringify([event, payload])}`); }
  request(event: string, payload?: unknown): Promise<any> {
    const id = this.id++;
    const result = this.wait(`ack:${id}`);
    this.ws.send(`42${id}${JSON.stringify([event, payload])}`);
    return result;
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = this.wait('disconnect');
    this.ws.close(); await closed;
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Test client closed')); }
    this.waiters = [];
  }
}
