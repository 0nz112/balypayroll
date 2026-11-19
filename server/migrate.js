// Applies db/migrations/*.sql in order (once each), optional demo seed,
// and creates the first Super Admin from ADMIN_EMAIL / ADMIN_PASSWORD.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asOwner, pool } from './db.js';
import { createAccount, setPassword, validPassword } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function migrate({ log = console.log } = {}) {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727001)');
    await c.query('create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query('select name from public.schema_migrations')).rows.map((r) => r.name));
    const files = (await fs.readdir(path.join(ROOT, 'db/migrations'))).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await fs.readFile(path.join(ROOT, 'db/migrations', f), 'utf8');
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into public.schema_migrations (name) values ($1)', [f]);
        await c.query('commit');
        log(`✓ migration ${f}`);
      } catch (e) { await c.query('rollback'); throw new Error(`migration ${f} failed: ${e.message}`); }
    }
    if (process.env.SEED_DEMO === 'true' && !done.has('seed:demo')) {
      await c.query('begin');
      await c.query(await fs.readFile(path.join(ROOT, 'db/seed.sql'), 'utf8'));
      await c.query("insert into public.schema_migrations (name) values ('seed:demo') on conflict do nothing");
      await c.query('commit');
      log('✓ demo seed loaded (logins: admin@demo.iq / Demo@12345)');
    }
  } finally {
    await c.query('select pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
  await bootstrapAdmin(log);
}

async function bootstrapAdmin(log) {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const has = await asOwner((c) => c.query("select 1 from public.profiles where role = 'super_admin' and status = 'active' limit 1"));
  if (has.rows.length) return; // only ever bootstraps the very first admin
  if (!validPassword(password)) { log('⚠ ADMIN_PASSWORD must be 8–128 characters; admin not created'); return; }
  const existing = await asOwner((c) => c.query('select id from auth.users where lower(email) = $1', [email]));
  if (existing.rows.length) {
    const id = existing.rows[0].id;
    await setPassword(id, password);
    await asOwner((c) => c.query("update public.profiles set role = 'super_admin', status = 'active' where id = $1", [id]));
  } else {
    await createAccount({ email, password, full_name: process.env.ADMIN_NAME || 'المدير العام', role: 'super_admin' }, null);
  }
  log(`✓ Super Admin ready: ${email} — you can now remove ADMIN_PASSWORD from the variables`);
}
