/**
 * Discord Autoposter — server.js v2.2
 * Features kept: Multi-channel, Images, Smart cooldown, Auto-detect, Emoji
 */

const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const db       = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;
const DISCORD_API = 'https://discord.com/api/v9';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const runningJobs = {};

// ── Token cleaner ──────────────────────────────────────
function cleanToken(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  if (t.toLowerCase().startsWith('bearer ')) t = t.slice(7).trim();
  if (t.toLowerCase().startsWith('bot ')) t = t.slice(4).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  // remove any whitespace/newlines inside
  t = t.replace(/\s+/g, '');
  return t;
}

// ── Discord API ────────────────────────────────────────
async function discordFetch(token, apiPath, method = 'GET', body = null) {
  const clean = cleanToken(token);
  if (!clean) {
    return { ok: false, status: 401, json: { message: 'Empty token' } };
  }

  const headers = {
    'Authorization': clean,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
  };

  const opts = { method, headers };
  if (body !== null && body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(DISCORD_API + apiPath, opts);
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text ? text.slice(0, 200) : 'Empty response' };
    }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { message: err.message || 'Network error' } };
  }
}

function smartDelayMs(baseMinutes) {
  const base = (!baseMinutes || baseMinutes === 0) ? 2500 : Number(baseMinutes) * 60 * 1000;
  const jitter = base * 0.2;
  return Math.round(base + (Math.random() * jitter * 2 - jitter));
}

function buildPayload(message, imageUrl) {
  const payload = {};
  if (message && String(message).trim()) {
    payload.content = String(message).trim();
  }
  if (imageUrl && String(imageUrl).trim()) {
    payload.embeds = [{
      image: { url: String(imageUrl).trim() },
      color: 0x5865F2,
    }];
  }
  // Discord requires at least content or embeds
  if (!payload.content && !payload.embeds) {
    payload.content = '.';
  }
  return payload;
}

// ── Autopost engine ────────────────────────────────────
function startJob(project) {
  if (runningJobs[project.id]?.running) return;

  const channels = (project.channelIds && project.channelIds.length)
    ? project.channelIds
    : (project.channelId ? [project.channelId] : []);

  if (!channels.length) {
    console.log(`[SKIP] "${project.name}" — no channels`);
    return;
  }

  console.log(`[START] "${project.name}" → ${channels.length} channel(s)`);

  runningJobs[project.id] = { running: true, nextSendAt: null, channelIndex: 0 };
  db.setProjectRunning(project.id, true).catch(e => console.error('[DB]', e.message));

  const doSend = async () => {
    if (!runningJobs[project.id]?.running) return;

    let p;
    try {
      p = await db.getProject(project.id);
    } catch (e) {
      console.error('[DB get]', e.message);
      return;
    }
    if (!p || !p.running) { stopJob(project.id); return; }

    const chans = (p.channelIds && p.channelIds.length)
      ? p.channelIds
      : (p.channelId ? [p.channelId] : []);
    if (!chans.length) { stopJob(project.id); return; }

    const job = runningJobs[project.id];
    if (!job) return;
    const idx = (job.channelIndex || 0) % chans.length;
    const channelId = chans[idx];
    job.channelIndex = (idx + 1) % chans.length;

    const payload = buildPayload(p.message, p.imageUrl);
    const { ok, status, json } = await discordFetch(
      p.token, `/channels/${channelId}/messages`, 'POST', payload
    );

    if (ok) {
      await db.recordSuccess(project.id, new Date().toISOString()).catch(() => {});
      console.log(`[OK] #${channelId}`);
    } else {
      const errMsg = (json && (json.message || json.code)) || `HTTP ${status}`;
      console.log(`[FAIL] #${channelId} → ${errMsg}`);

      if (status === 429) {
        const retryAfter = Math.ceil((json.retry_after || 5) * 1000);
        console.log(`[RATE] wait ${retryAfter}ms`);
        if (runningJobs[project.id]) {
          runningJobs[project.id].nextSendAt = Date.now() + retryAfter;
          runningJobs[project.id].timer = setTimeout(doSend, retryAfter);
        }
        await db.recordFailure(project.id, `Rate limited (${Math.round(retryAfter/1000)}s)`, false).catch(() => {});
        return;
      }

      // 401 = bad token → stop. 403 = no permission → stop if single channel.
      // 404 = unknown channel → skip, continue other channels.
      const shouldStop = status === 401 || (status === 403 && chans.length === 1);
      await db.recordFailure(project.id, String(errMsg) + ' (#' + channelId + ')', shouldStop).catch(() => {});
      if (shouldStop) {
        stopJob(project.id);
        return;
      }
      // for 404 on multi-channel, just continue to next
    }

    const delayMs = smartDelayMs(p.delay);
    if (runningJobs[project.id]) {
      runningJobs[project.id].nextSendAt = Date.now() + delayMs;
      runningJobs[project.id].timer = setTimeout(doSend, delayMs);
    }
  };

  runningJobs[project.id].nextSendAt = Date.now() + 1500;
  runningJobs[project.id].timer = setTimeout(doSend, 1500);
}

function stopJob(projectId) {
  const job = runningJobs[projectId];
  if (job) {
    job.running = false;
    if (job.timer) clearTimeout(job.timer);
    delete runningJobs[projectId];
  }
  db.setProjectRunning(projectId, false).catch(e => console.error('[DB]', e.message));
  console.log(`[STOP] ${projectId}`);
}

async function resumeJobs() {
  try {
    const all = await db.getAllProjects();
    for (const p of all) {
      const hasCh = (p.channelIds && p.channelIds.length) || p.channelId;
      const hasMsg = (p.message && p.message.trim()) || (p.imageUrl && p.imageUrl.trim());
      if (p.running && p.token && hasCh && hasMsg) {
        console.log(`[RESUME] ${p.name}`);
        startJob(p);
      }
    }
  } catch (err) {
    console.error('[RESUME]', err.message);
  }
}

// ── Auth ───────────────────────────────────────────────
app.post('/api/auth/validate', async (req, res) => {
  try {
    let token = cleanToken(req.body && req.body.token);
    if (!token) {
      return res.status(400).json({ error: 'Token required', detail: 'Token kosong' });
    }
    if (token.length < 50) {
      return res.status(400).json({
        error: 'Token terlalu pendek',
        detail: 'Token user Discord biasanya 59+ karakter. Pastikan copy penuh.',
      });
    }

    console.log('[AUTH] validating token length=', token.length);
    const { ok, status, json } = await discordFetch(token, '/users/@me');

    if (!ok) {
      console.log('[AUTH FAIL]', status, JSON.stringify(json).slice(0, 200));
      let hint = (json && json.message) || `HTTP ${status}`;
      if (status === 401) hint = 'Token invalid / expired / sudah di-reset Discord. Ambil token baru.';
      if (status === 403) hint = 'Diblokir (Cloudflare/captcha). Coba dari jaringan lain atau tunggu.';
      if (status === 0) hint = 'Gagal koneksi ke Discord API.';
      return res.status(401).json({ error: 'Invalid token', detail: hint, status });
    }

    const user = {
      id: json.id,
      username: json.username,
      discriminator: json.discriminator || '0',
      avatar: json.avatar || null,
    };
    await db.upsertAccount({ ...user, token });
    console.log('[AUTH OK]', user.username, user.id);
    res.json({ user });
  } catch (err) {
    console.error('[AUTH ERR]', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// ── Guilds / Channels (Auto Detect) ────────────────────
app.get('/api/guilds', async (req, res) => {
  try {
    const token = cleanToken(req.headers.authorization || req.query.token);
    if (!token) return res.status(401).json({ error: 'Token required' });

    const { ok, status, json } = await discordFetch(token, '/users/@me/guilds?limit=200');
    if (!ok) {
      return res.status(status === 401 ? 401 : 400).json({
        error: (json && json.message) || 'Failed to fetch guilds',
        status,
      });
    }
    const guilds = (Array.isArray(json) ? json : []).map(g => ({
      id: g.id,
      name: g.name,
      icon: g.icon || null,
    }));
    res.json(guilds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/guilds/:guildId/channels', async (req, res) => {
  try {
    const token = cleanToken(req.headers.authorization || req.query.token);
    if (!token) return res.status(401).json({ error: 'Token required' });

    const { ok, status, json } = await discordFetch(
      token, `/guilds/${req.params.guildId}/channels`
    );
    if (!ok) {
      return res.status(400).json({
        error: (json && json.message) || 'Failed to fetch channels',
        status,
      });
    }
    const channels = (Array.isArray(json) ? json : [])
      .filter(c => c.type === 0 || c.type === 5)
      .map(c => ({ id: c.id, name: c.name, type: c.type, position: c.position || 0 }))
      .sort((a, b) => a.position - b.position);
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Projects CRUD ──────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const projects = await db.getProjectsByUser(userId);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const body = req.body || {};
    const { userId, token, name, channelIds, message, imageUrl, delay } = body;
    if (!userId || !token) return res.status(400).json({ error: 'userId and token required' });

    const project = await db.createProject({
      id: uuidv4(),
      userId,
      token: cleanToken(token),
      name: name || 'New Project',
      channelIds: Array.isArray(channelIds) ? channelIds : [],
      message: message || '',
      imageUrl: imageUrl || '',
      delay: delay != null ? Number(delay) : 5,
    });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const fields = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.channelIds !== undefined) fields.channelIds = Array.isArray(body.channelIds) ? body.channelIds : [];
    if (body.message !== undefined) fields.message = body.message;
    if (body.imageUrl !== undefined) fields.imageUrl = body.imageUrl;
    if (body.delay !== undefined) fields.delay = Number(body.delay);
    if (body.token !== undefined) fields.token = cleanToken(body.token);

    const p = await db.updateProject(req.params.id, fields);
    if (!p) return res.status(404).json({ error: 'Project tidak ditemukan', detail: 'Project mungkin sudah dihapus atau server di-restart (mode memory). Buat project baru.' });
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    stopJob(req.params.id);
    await db.deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

app.post('/api/projects/:id/start', async (req, res) => {
  try {
    let p = await db.getProject(req.params.id);
    if (!p) {
      return res.status(404).json({
        error: 'Project tidak ditemukan',
        detail: 'Server mungkin restart (data memory hilang). Buat / simpan project lagi.',
      });
    }

    // Allow client to refresh token on start
    if (req.body && req.body.token) {
      const t = cleanToken(req.body.token);
      if (t) {
        p = await db.updateProject(p.id, { token: t }) || p;
        p.token = t;
      }
    }

    const hasChannels = (p.channelIds && p.channelIds.length) || p.channelId;
    const hasContent = (p.message && String(p.message).trim()) || (p.imageUrl && String(p.imageUrl).trim());

    if (!hasChannels) return res.status(400).json({ error: 'Pilih minimal 1 channel dulu, lalu Simpan Config' });
    if (!hasContent) return res.status(400).json({ error: 'Isi pesan atau URL gambar dulu, lalu Simpan Config' });
    if (!p.token) return res.status(400).json({ error: 'Token hilang. Logout lalu login lagi.' });

    startJob(p);
    res.json({ ok: true, message: 'Autopost started', channels: (p.channelIds || []).length || 1 });
  } catch (err) {
    console.error('[START ERR]', err);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

app.post('/api/projects/:id/stop', (req, res) => {
  stopJob(req.params.id);
  res.json({ ok: true, message: 'Autopost stopped' });
});

app.get('/api/projects/:id/stats', async (req, res) => {
  try {
    const p = await db.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project tidak ditemukan', detail: 'Project mungkin sudah dihapus atau server di-restart (mode memory). Buat project baru.' });

    const job = runningJobs[p.id];
    const running = !!(p.running || (job && job.running));
    let nextSendIn = null;
    if (running && job && job.nextSendAt) {
      nextSendIn = Math.max(0, Math.round((job.nextSendAt - Date.now()) / 1000));
    }

    res.json({
      id: p.id,
      running,
      sent: p.sent || 0,
      failed: p.failed || 0,
      lastSent: p.lastSent,
      lastError: p.lastError,
      nextSendIn,
      channelCount: (p.channelIds && p.channelIds.length) || (p.channelId ? 1 : 0),
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const projects = await db.getAllProjects();
    res.json({
      status: 'ok',
      activeJobs: Object.keys(runningJobs).length,
      projects: projects.length,
      uptime: process.uptime(),
      storage: process.env.DATABASE_URL ? 'postgres' : 'memory',
    });
  } catch (err) {
    res.status(500).json({ status: 'error', detail: err.message });
  }
});

// ── Boot ───────────────────────────────────────────────
async function main() {
  await db.init();

  if (process.env.VERCEL) {
    module.exports = app;
  } else {
    app.listen(PORT, () => {
      console.log(`✅ Discord Autoposter v2.2 on port ${PORT}`);
      console.log(`🌐 http://localhost:${PORT}`);
      resumeJobs();
    });
  }
}

main().catch(err => {
  console.error('❌ Failed to start:', err.message);
  process.exit(1);
});

if (process.env.VERCEL) {
  module.exports = app;
}
