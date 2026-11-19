// PostgreSQL access. Every user request runs in its own transaction as the
// "authenticated" role with the user's id in request.jwt.claims, so the
// database's RLS policies and permission checks apply exactly as designed.
let PoolImpl;
if (process.env.PG_SHIM) {
  ({ Pool: PoolImpl } = await import('../tests/pg-shim.js')); // local test driver only
} else {
  const pg = (await import('pg')).default;
  PoolImpl = pg.Pool;
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
const ssl = process.env.PGSSL === 'true' || /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;

export const pool = new PoolImpl({ connectionString: url, max: Number(process.env.PG_POOL_MAX || 10), ssl });

/** Run fn(client) as the owner role (migrations, login, admin account management). */
export async function asOwner(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

/** Run fn(client) as the signed-in user (RLS enforced). */
export async function asUser(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("set local statement_timeout = '20s'");
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

/** Query returning a single json value aliased "j". */
export async function j(client, sql, params = []) {
  const r = await client.query(sql, params);
  return r.rows[0]?.j ?? null;
}
