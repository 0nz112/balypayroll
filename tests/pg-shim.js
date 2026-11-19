// TEST-ONLY minimal PostgreSQL client (simple query protocol, trust auth) with the
// subset of the `pg` API the server uses: Pool#connect/query/end, client.query/release.
// Lets the real server run end-to-end where the `pg` package can't be installed.
// Parameters are inlined as quoted literals; production uses `pg` with real binding.
import net from 'node:net';

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
const inline = (sql, params = []) => (params.length ? sql.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1])) : sql);
const convert = (oid, s) => {
  if (s === null) return null;
  if (oid === 16) return s === 't';
  if (oid === 20 || oid === 21 || oid === 23) return Number(s);
  if (oid === 114 || oid === 3802) return JSON.parse(s);
  return s;
};

class Client {
  constructor(cfg) { this.cfg = cfg; this.buf = Buffer.alloc(0); this.waiters = []; this.chain = Promise.resolve(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.cfg.port, this.cfg.host);
      this.sock.on('error', reject);
      this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
      this.sock.on('connect', () => {
        const params = Buffer.from(`user\0${this.cfg.user}\0database\0${this.cfg.database}\0\0`);
        const head = Buffer.alloc(8); head.writeInt32BE(8 + params.length, 0); head.writeInt32BE(196608, 4);
        this.sock.write(Buffer.concat([head, params]));
        this.collect().then(() => resolve(this), reject);
      });
    });
  }
  pump() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const type = String.fromCharCode(this.buf[0]); const body = this.buf.subarray(5, 1 + len);
      this.buf = this.buf.subarray(1 + len);
      this.waiters[0]?.(type, body);
    }
  }
  collect() {
    return new Promise((resolve, reject) => {
      let fields = []; let rows = []; let error = null;
      this.waiters.push((type, b) => {
        if (type === 'R' && b.readInt32BE(0) !== 0) error = new Error('shim supports trust auth only');
        else if (type === 'T') {
          fields = []; rows = []; let o = 2;
          for (let i = 0; i < b.readInt16BE(0); i++) { const e = b.indexOf(0, o); const name = b.toString('utf8', o, e); o = e + 1; fields.push({ name, oid: b.readInt32BE(o + 6) }); o += 18; }
        } else if (type === 'D') {
          const r = {}; let o = 2;
          for (let i = 0; i < b.readInt16BE(0); i++) { const l = b.readInt32BE(o); o += 4; const s = l < 0 ? null : b.toString('utf8', o, o + l); if (l > 0) o += l; r[fields[i].name] = convert(fields[i].oid, s); }
          rows.push(r);
        } else if (type === 'E') {
          const f = {}; let o = 0;
          while (b[o] !== 0) { const k = String.fromCharCode(b[o]); const e = b.indexOf(0, o + 1); f[k] = b.toString('utf8', o + 1, e); o = e + 1; }
          error = Object.assign(new Error(f.M), { code: f.C, detail: f.D || '' });
        } else if (type === 'Z') { this.waiters.shift(); error ? reject(error) : resolve({ rows }); }
      });
    });
  }
  query(sql, params) {
    const run = () => {
      const q = Buffer.from(inline(sql, params) + '\0');
      const head = Buffer.alloc(5); head.write('Q'); head.writeInt32BE(4 + q.length, 1);
      this.sock.write(Buffer.concat([head, q]));
      return this.collect();
    };
    const p = this.chain.then(run, run); this.chain = p.catch(() => {}); return p;
  }
  release() { this.pool.idle.push(this); }
  end() { this.sock.end(); }
}

export class Pool {
  constructor({ connectionString }) {
    const u = new URL(connectionString);
    this.cfg = { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username || 'postgres'), database: u.pathname.slice(1) || 'postgres' };
    this.idle = [];
  }
  async connect() { const c = this.idle.pop() || await new Client(this.cfg).connect(); c.pool = this; return c; }
  async query(sql, params) { const c = await this.connect(); try { return await c.query(sql, params); } finally { c.release(); } }
  async end() { for (const c of this.idle) c.end(); this.idle = []; }
}
