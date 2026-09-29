/**
 * db.js — Postgres (Neon) + in-memory fallback
 * Supports multi-channel + image URL
 */

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';
const useMemory = !connectionString;

if (useMemory) {
  console.warn('⚠️  DATABASE_URL tidak di-set → pakai in-memory storage (data hilang saat restart)');
}

const pool = useMemory ? null : new Pool({
  connectionString,
  ssl: connectionString.includes('sslmode=require') ? undefined : { rejectUnauthorized: false },
});

// ── In-memory store (fallback) ─────────────────────────
const mem = {
  accounts: new Map(),
  projects: new Map(),
};

function rowToProject(row) {
  if (!row) return null;
  let channelIds = [];
  try {
    channelIds = typeof row.channel_ids === 'string'
      ? JSON.parse(row.channel_ids || '[]')
      : (row.channel_ids || []);
  } catch {
    channelIds = row.channel_id ? [row.channel_id] : [];
  }
  if (!channelIds.length && row.channel_id) channelIds = [row.channel_id];

  return {
    id: row.id,
    userId: row.user_id || row.userId,
    token: row.token,
    name: row.name,
    channelId: channelIds[0] || row.channel_id || '',
    channelIds,
    message: row.message || '',
    imageUrl: row.image_url || row.imageUrl || '',
    delay: row.delay != null ? row.delay : 5,
    running: !!row.running,
    sent: row.sent || 0,
    failed: row.failed || 0,
    lastSent: row.last_sent
      ? (row.last_sent instanceof Date ? row.last_sent.toISOString() : row.last_sent)
      : (row.lastSent || null),
    lastError: row.last_error || row.lastError || null,
    createdAt: row.created_at
      ? (row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at)
      : (row.createdAt || null),
  };
}

async function init() {
  if (useMemory) {
    console.log('✅ In-memory database ready');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_accounts (
      id TEXT PRIMARY KEY,
      username TEXT,
      discriminator TEXT,
      avatar TEXT,
      token TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT,
      name TEXT,
      channel_id TEXT,
      channel_ids TEXT DEFAULT '[]',
      message TEXT,
      image_url TEXT,
      delay INTEGER DEFAULT 5,
      running BOOLEAN DEFAULT FALSE,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      last_sent TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  try {
    await pool.query(`ALTER TABLE app_projects ADD COLUMN IF NOT EXISTS channel_ids TEXT DEFAULT '[]'`);
    await pool.query(`ALTER TABLE app_projects ADD COLUMN IF NOT EXISTS image_url TEXT`);
  } catch (_) {}
  console.log('✅ Database ready (Postgres)');
}

async function upsertAccount(account) {
  const { id, username, discriminator, avatar, token } = account;
  if (useMemory) {
    mem.accounts.set(id, { id, username, discriminator, avatar, token });
    return;
  }
  await pool.query(
    `INSERT INTO app_accounts (id, username, discriminator, avatar, token)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET
       username=EXCLUDED.username, discriminator=EXCLUDED.discriminator,
       avatar=EXCLUDED.avatar, token=EXCLUDED.token`,
    [id, username, discriminator, avatar, token]
  );
}

async function getAccount(id) {
  if (useMemory) return mem.accounts.get(id) || null;
  const { rows } = await pool.query('SELECT * FROM app_accounts WHERE id=$1', [id]);
  return rows[0] || null;
}

async function getProjectsByUser(userId) {
  if (useMemory) {
    return [...mem.projects.values()]
      .filter(p => p.userId === userId)
      .map(p => rowToProject(p));
  }
  const { rows } = await pool.query(
    'SELECT * FROM app_projects WHERE user_id=$1 ORDER BY created_at ASC', [userId]
  );
  return rows.map(rowToProject);
}

async function getAllProjects() {
  if (useMemory) return [...mem.projects.values()].map(p => rowToProject(p));
  const { rows } = await pool.query('SELECT * FROM app_projects');
  return rows.map(rowToProject);
}

async function getProject(id) {
  if (useMemory) {
    const p = mem.projects.get(id);
    return p ? rowToProject(p) : null;
  }
  const { rows } = await pool.query('SELECT * FROM app_projects WHERE id=$1', [id]);
  return rowToProject(rows[0]);
}

async function createProject(project) {
  const { id, userId, token, name, channelIds, message, imageUrl, delay } = project;
  const ids = Array.isArray(channelIds) ? channelIds : [];
  if (useMemory) {
    const row = {
      id, userId, token, name: name || 'New Project',
      channel_id: ids[0] || '', channel_ids: ids,
      message: message || '', image_url: imageUrl || '',
      delay: delay ?? 5, running: false, sent: 0, failed: 0,
      last_sent: null, last_error: null, created_at: new Date().toISOString(),
    };
    mem.projects.set(id, row);
    return rowToProject(row);
  }
  const { rows } = await pool.query(
    `INSERT INTO app_projects (id,user_id,token,name,channel_id,channel_ids,message,image_url,delay,running,sent,failed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,0,0) RETURNING *`,
    [id, userId, token, name || 'New Project', ids[0] || '', JSON.stringify(ids), message || '', imageUrl || '', delay ?? 5]
  );
  return rowToProject(rows[0]);
}

async function updateProject(id, fields) {
  if (useMemory) {
    const p = mem.projects.get(id);
    if (!p) return null;
    if (fields.name !== undefined) p.name = fields.name;
    if (fields.channelIds !== undefined) {
      p.channel_ids = Array.isArray(fields.channelIds) ? fields.channelIds : [];
      p.channel_id = p.channel_ids[0] || '';
    }
    if (fields.message !== undefined) p.message = fields.message;
    if (fields.imageUrl !== undefined) p.image_url = fields.imageUrl;
    if (fields.delay !== undefined) p.delay = fields.delay;
    if (fields.token !== undefined) p.token = fields.token;
    return rowToProject(p);
  }

  const map = {
    name: 'name', channelIds: 'channel_ids', message: 'message',
    imageUrl: 'image_url', delay: 'delay', token: 'token',
  };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      let val = fields[key];
      if (key === 'channelIds') {
        val = JSON.stringify(Array.isArray(val) ? val : []);
        sets.push(`channel_id = $${i}`);
        values.push(Array.isArray(fields[key]) && fields[key][0] ? fields[key][0] : '');
        i++;
      }
      sets.push(`${col} = $${i++}`);
      values.push(val);
    }
  }
  if (!sets.length) return getProject(id);
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE app_projects SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, values
  );
  return rowToProject(rows[0]);
}

async function setProjectRunning(id, running) {
  if (useMemory) {
    const p = mem.projects.get(id);
    if (p) p.running = !!running;
    return p ? rowToProject(p) : null;
  }
  const { rows } = await pool.query(
    'UPDATE app_projects SET running=$1 WHERE id=$2 RETURNING *', [running, id]
  );
  return rowToProject(rows[0]);
}

async function recordSuccess(id, timestamp) {
  if (useMemory) {
    const p = mem.projects.get(id);
    if (p) { p.sent = (p.sent || 0) + 1; p.last_sent = timestamp; }
    return p ? rowToProject(p) : null;
  }
  const { rows } = await pool.query(
    `UPDATE app_projects SET sent=sent+1, last_sent=$2 WHERE id=$1 RETURNING *`, [id, timestamp]
  );
  return rowToProject(rows[0]);
}

async function recordFailure(id, errorMessage, stop) {
  if (useMemory) {
    const p = mem.projects.get(id);
    if (p) {
      p.failed = (p.failed || 0) + 1;
      p.last_error = errorMessage;
      if (stop) p.running = false;
    }
    return p ? rowToProject(p) : null;
  }
  const { rows } = await pool.query(
    `UPDATE app_projects SET failed=failed+1, last_error=$2,
     running = CASE WHEN $3 THEN FALSE ELSE running END
     WHERE id=$1 RETURNING *`, [id, errorMessage, !!stop]
  );
  return rowToProject(rows[0]);
}

async function deleteProject(id) {
  if (useMemory) { mem.projects.delete(id); return; }
  await pool.query('DELETE FROM app_projects WHERE id=$1', [id]);
}

module.exports = {
  pool, init, upsertAccount, getAccount,
  getProjectsByUser, getAllProjects, getProject,
  createProject, updateProject, setProjectRunning,
  recordSuccess, recordFailure, deleteProject,
};
