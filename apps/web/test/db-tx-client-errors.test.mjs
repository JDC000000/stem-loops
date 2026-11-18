// PR #298 review R3-1: lib/db.ts tx() must own 'error' on the client it has
// checked out. pg's Pool listens for 'error' only on IDLE clients, so a
// checked-out client the server drops (idle_in_transaction_session_timeout,
// pooler restart) would otherwise emit 'error' with no listener, i.e. an
// uncaughtException. Unit-level: the REAL db.ts with `pg` replaced by a stub
// pool whose client is a real EventEmitter (the real-PG end-to-end case is in
// webhook-subscription-pg.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { WEB, dataUrl } from './helpers/billing-harness.mjs';

const toJs = (src) =>
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;

async function loadDb() {
  globalThis.__pgStub = { clients: [] };
  globalThis.__sentryDb = [];
  const pg = dataUrl(`
    import { EventEmitter } from 'node:events';
    class FakeClient extends EventEmitter {
      constructor() { super(); this.released = []; this.queries = []; }
      async query(text) {
        this.queries.push(text);
        if (this.dead && text !== 'ROLLBACK') throw new Error('Connection terminated');
        if (this.dead) throw new Error('Connection terminated');
        return { rows: [], rowCount: 0 };
      }
      release(err) { this.released.push(err ?? null); }
    }
    export class Pool {
      constructor() {}
      async connect() { const c = new FakeClient(); globalThis.__pgStub.clients.push(c); return c; }
      async query() { return { rows: [], rowCount: 0 }; }
    }
  `);
  const sentry = dataUrl(`export const captureException = (e, o) => { globalThis.__sentryDb.push({ e, o }); };`);
  const ssl = dataUrl(toJs(readFileSync(join(WEB, 'src/lib/db-ssl.ts'), 'utf8')));
  const js = toJs(readFileSync(join(WEB, 'src/lib/db.ts'), 'utf8'))
    .replace(/from ['"]pg['"]/g, `from '${pg}'`)
    .replace(/from ['"]\.\/db-ssl['"]/g, `from '${ssl}'`)
    .replace(/from ['"]@sentry\/nextjs['"]/g, `from '${sentry}'`);
  process.env.DATABASE_URL = 'postgresql://x:y@localhost:1/z';
  return import(dataUrl(js) + '#' + Math.random());
}

const quietErr = async (fn) => {
  const o = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = o; }
};

for (const which of ['db', 'webhookDb']) {
  test(`${which}.tx: a client error mid-transaction is caught, reported once, and the client destroyed`, async () => {
    const mod = await loadDb();
    const err = await quietErr(() => assert.rejects(() => mod[which].tx(async (q) => {
      const c = globalThis.__pgStub.clients[0];
      assert.equal(c.listenerCount('error'), 1, 'tx() must listen for error while the client is checked out');
      // The server ends the session (FATAL), then the socket closes: pg emits twice.
      c.dead = true;
      c.emit('error', new Error('terminating connection due to idle-in-transaction timeout'));
      c.emit('error', new Error('Connection terminated unexpectedly'));
      await q.query('SELECT 1'); // the next statement fails normally
    })));
    void err;
    const c = globalThis.__pgStub.clients[0];
    assert.equal(c.listenerCount('error'), 0, 'listener must be removed on release');
    assert.equal(c.released.length, 1);
    assert.match(String(c.released[0]?.message), /idle-in-transaction/, 'broken client must be released WITH the error (destroyed, not pooled)');
    assert.equal(globalThis.__sentryDb.length, 1, 'reported once per checkout');
    assert.equal(globalThis.__sentryDb[0].o.tags.component, 'db.tx');
  });

  test(`${which}.tx: a healthy transaction releases normally and leaves no listener`, async () => {
    const mod = await loadDb();
    const out = await mod[which].tx(async (q) => { await q.query('SELECT 1'); return 42; });
    assert.equal(out, 42);
    const c = globalThis.__pgStub.clients[0];
    assert.equal(c.listenerCount('error'), 0);
    assert.deepEqual(c.released, [null]);
    assert.deepEqual(c.queries, ['BEGIN', 'SELECT 1', 'COMMIT']);
    assert.equal(globalThis.__sentryDb.length, 0);
  });
}

test('without a listener an emitted error WOULD throw (why tx() must attach one)', () => {
  const e = new EventEmitter();
  assert.throws(() => e.emit('error', new Error('boom')), /boom/);
});
