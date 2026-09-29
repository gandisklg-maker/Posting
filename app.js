/* ─────────────────────────────────────────────────────
   Discord Autoposter — app.js v2.2
   Fitur: Auto Detect, Multi Channel, Images, Smart Cooldown, Emoji
   ───────────────────────────────────────────────────── */

const STORE_KEY = 'dap_v2_session';

let state = {
  token: null,
  user: null,
  projects: [],
  activeProjectId: null,
  guilds: [],
  channelsCache: {},
};

const pollers = {};

function $(id) {
  return document.getElementById(id);
}

function saveSession() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ token: state.token, user: state.user }));
  } catch (_) {}
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    state.token = data.token || null;
    state.user = data.user || null;
    return !!(state.token && state.user);
  } catch {
    return false;
  }
}

function clearSession() {
  try { localStorage.removeItem(STORE_KEY); } catch (_) {}
}

function cleanTokenClient(raw) {
  let t = String(raw || '').trim();
  if (t.toLowerCase().startsWith('bearer ')) t = t.slice(7).trim();
  if (t.toLowerCase().startsWith('bot ')) t = t.slice(4).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t.replace(/\s+/g, '');
}

async function api(path, method, body) {
  method = method || 'GET';
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(path, opts);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { error: err.message } };
  }
}

async function validateToken(token) {
  const t = cleanTokenClient(token);
  if (!t || t.length < 50) {
    toast('❌ Token terlalu pendek. Pastikan copy token user secara penuh.', 'error');
    return null;
  }
  const { ok, json } = await api('/api/auth/validate', 'POST', { token: t });
  if (!ok) {
    const msg = (json && (json.detail || json.error)) || 'Token tidak valid';
    console.error('[AUTH]', json);
    toast('❌ ' + msg, 'error');
    return null;
  }
  return json.user;
}

async function fetchProjects() {
  if (!state.user) return;
  const { ok, json } = await api('/api/projects?userId=' + encodeURIComponent(state.user.id));
  if (ok && Array.isArray(json)) state.projects = json;
}

// ── Auto Detect ────────────────────────────────────────
async function loadGuilds() {
  if (!state.token) return;
  try {
    const res = await fetch('/api/guilds', {
      headers: { Authorization: state.token },
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(json)) {
      state.guilds = json;
      const sel = $('cfg-guild');
      if (!sel) return;
      sel.innerHTML = '<option value="">— Pilih Server —</option>';
      json.forEach(function (g) {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        sel.appendChild(opt);
      });
    } else {
      console.error('[GUILDS]', json);
      toast('Gagal load server: ' + ((json && json.error) || 'unknown'), 'error');
    }
  } catch (err) {
    console.error('[GUILDS]', err);
    toast('Gagal load server', 'error');
  }
}

async function loadChannels(guildId) {
  const sel = $('cfg-channels');
  if (!sel) return;
  sel.innerHTML = '<option value="" disabled>Loading...</option>';

  if (!guildId) {
    sel.innerHTML = '<option value="" disabled>Pilih server dulu...</option>';
    return;
  }

  if (state.channelsCache[guildId]) {
    renderChannelOptions(state.channelsCache[guildId]);
    return;
  }

  try {
    const res = await fetch('/api/guilds/' + guildId + '/channels', {
      headers: { Authorization: state.token },
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(json)) {
      state.channelsCache[guildId] = json;
      renderChannelOptions(json);
    } else {
      console.error('[CHANNELS]', json);
      sel.innerHTML = '<option value="" disabled>Gagal load channel</option>';
    }
  } catch (err) {
    console.error('[CHANNELS]', err);
    sel.innerHTML = '<option value="" disabled>Gagal load channel</option>';
  }
}

function renderChannelOptions(channels) {
  const sel = $('cfg-channels');
  if (!sel) return;
  sel.innerHTML = '';
  if (!channels || !channels.length) {
    sel.innerHTML = '<option value="" disabled>Tidak ada text channel</option>';
    return;
  }
  channels.forEach(function (c) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = '# ' + c.name;
    sel.appendChild(opt);
  });
}

function getSelectedChannelIds() {
  const sel = $('cfg-channels');
  if (!sel) return [];
  return Array.from(sel.selectedOptions)
    .map(function (o) { return o.value; })
    .filter(Boolean);
}

// ── UI helpers ─────────────────────────────────────────
function toast(msg, type) {
  type = type || 'info';
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(function () { el.remove(); }, 4500);
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(function (s) {
    s.classList.remove('active');
  });
  const id = name === 'login' ? 'login-screen' : 'app-screen';
  const el = $(id);
  if (el) el.classList.add('active');
}

function setUserChip(user) {
  if (!user) return;
  const nameEl = $('user-name');
  const av = $('user-avatar');
  if (nameEl) {
    const disc = user.discriminator && user.discriminator !== '0' ? '#' + user.discriminator : '';
    nameEl.textContent = (user.username || 'User') + disc;
  }
  if (av) {
    if (user.avatar) {
      av.style.backgroundImage = 'url(https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=64)';
      av.style.backgroundSize = 'cover';
      av.style.backgroundPosition = 'center';
      av.textContent = '';
    } else {
      av.style.backgroundImage = '';
      av.style.display = 'flex';
      av.style.alignItems = 'center';
      av.style.justifyContent = 'center';
      av.style.color = '#fff';
      av.style.fontSize = '0.75rem';
      av.style.fontWeight = '700';
      av.textContent = (user.username || 'U')[0].toUpperCase();
    }
  }
}

function log(msg, type) {
  type = type || 'info';
  const body = $('log-body');
  if (!body) return;
  if (body.querySelector('.log-empty')) body.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'log-line ' + type;
  const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.innerHTML = '<span class="log-time">' + time + '</span> ' + msg;
  body.prepend(line);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Projects ───────────────────────────────────────────
function renderProjectList() {
  const list = $('project-list');
  if (!list) return;
  if (!state.projects.length) {
    list.innerHTML = '<div class="project-empty">Belum ada project</div>';
    return;
  }
  list.innerHTML = state.projects.map(function (p) {
    const chCount = (p.channelIds && p.channelIds.length) || (p.channelId ? 1 : 0);
    const active = p.id === state.activeProjectId ? 'active' : '';
    const running = p.running ? '<span class="dot-running"></span>' : '';
    return (
      '<div class="project-card ' + active + '" data-id="' + p.id + '" onclick="selectProject(\'' + p.id + '\')">' +
        '<div class="project-card-name">' + running + escapeHtml(p.name || 'Untitled') + '</div>' +
        '<div class="project-card-sub">' + chCount + ' channel' + (chCount !== 1 ? 's' : '') + '</div>' +
      '</div>'
    );
  }).join('');
}

function getActiveProject() {
  return state.projects.find(function (p) { return p.id === state.activeProjectId; });
}

async function selectProject(id) {
  state.activeProjectId = id;
  renderProjectList();
  const p = getActiveProject();
  if (!p) {
    if ($('empty-state')) $('empty-state').style.display = '';
    if ($('project-panel')) $('project-panel').style.display = 'none';
    return;
  }
  if ($('empty-state')) $('empty-state').style.display = 'none';
  if ($('project-panel')) $('project-panel').style.display = '';
  if ($('panel-title')) $('panel-title').textContent = p.name || 'Project';

  if ($('cfg-name')) $('cfg-name').value = p.name || '';
  if ($('cfg-message')) $('cfg-message').value = p.message || '';
  if ($('cfg-image')) $('cfg-image').value = p.imageUrl || '';
  if ($('cfg-delay')) $('cfg-delay').value = p.delay != null ? p.delay : 5;

  if ($('cfg-guild')) $('cfg-guild').value = '';
  if ($('cfg-channels')) {
    $('cfg-channels').innerHTML = '<option value="" disabled>Pilih server untuk load channel...</option>';
  }

  updateStartStopUI(!!p.running);
  startPolling(id);
  log('Project "' + escapeHtml(p.name) + '" dibuka', 'info');
}
// expose for onclick
window.selectProject = selectProject;

function updateStartStopUI(running) {
  const btn = $('start-stop-btn');
  const label = $('start-stop-label');
  const startIcon = $('start-icon');
  const stopIcon = $('stop-icon');
  if (!btn) return;
  if (running) {
    btn.classList.add('running');
    if (label) label.textContent = 'Stop Autopost';
    if (startIcon) startIcon.style.display = 'none';
    if (stopIcon) stopIcon.style.display = '';
  } else {
    btn.classList.remove('running');
    if (label) label.textContent = 'Mulai Autopost';
    if (startIcon) startIcon.style.display = '';
    if (stopIcon) stopIcon.style.display = 'none';
  }
}

function startPolling(projectId) {
  stopPolling(projectId);
  pollers[projectId] = setInterval(async function () {
    if (state.activeProjectId !== projectId) return;
    const { ok, json } = await api('/api/projects/' + projectId + '/stats');
    if (!ok || !json) return;
    if ($('stat-sent')) $('stat-sent').textContent = json.sent || 0;
    if ($('stat-failed')) $('stat-failed').textContent = json.failed || 0;
    if ($('stat-channels')) $('stat-channels').textContent = json.channelCount || 0;
    if ($('stat-countdown')) {
      if (json.nextSendIn != null) {
        const m = Math.floor(json.nextSendIn / 60);
        const s = json.nextSendIn % 60;
        $('stat-countdown').textContent =
          String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      } else {
        $('stat-countdown').textContent = '--:--';
      }
    }
    updateStartStopUI(!!json.running);
    const p = state.projects.find(function (x) { return x.id === projectId; });
    if (p) p.running = !!json.running;
  }, 2000);
}

function stopPolling(projectId) {
  if (pollers[projectId]) {
    clearInterval(pollers[projectId]);
    delete pollers[projectId];
  }
}

async function addProject() {
  const name = prompt('Nama project baru:', 'Project Baru');
  if (!name) return;
  const { ok, json } = await api('/api/projects', 'POST', {
    userId: state.user.id,
    token: state.token,
    name: name,
    channelIds: [],
    message: '',
    imageUrl: '',
    delay: 5,
  });
  if (!ok) {
    toast((json && json.error) || 'Gagal buat project', 'error');
    return;
  }
  state.projects.push(json);
  renderProjectList();
  selectProject(json.id);
  toast('Project dibuat', 'success');
}

async function saveConfig() {
  const p = getActiveProject();
  if (!p) return;

  const name = ($('cfg-name') && $('cfg-name').value.trim()) || '';
  const message = ($('cfg-message') && $('cfg-message').value) || '';
  const imageUrl = ($('cfg-image') && $('cfg-image').value.trim()) || '';
  const delay = parseFloat(($('cfg-delay') && $('cfg-delay').value) || '5') || 0;
  const channelIds = getSelectedChannelIds();

  if (!name) { toast('Nama project wajib diisi', 'error'); return; }
  if (!channelIds.length) { toast('Pilih minimal 1 channel (tahan Ctrl untuk multi)', 'error'); return; }
  if (!message.trim() && !imageUrl) { toast('Isi pesan atau URL gambar', 'error'); return; }

  const { ok, json } = await api('/api/projects/' + p.id, 'PUT', {
    name: name,
    channelIds: channelIds,
    message: message,
    imageUrl: imageUrl,
    delay: delay,
    token: state.token,
  });

  if (!ok) {
    toast((json && (json.detail || json.error)) || 'Gagal simpan', 'error');
    log('❌ Simpan gagal: ' + ((json && (json.detail || json.error)) || 'unknown'), 'error');
    return;
  }

  const idx = state.projects.findIndex(function (x) { return x.id === p.id; });
  if (idx >= 0) state.projects[idx] = json;
  if ($('panel-title')) $('panel-title').textContent = json.name;
  renderProjectList();
  toast('Config tersimpan ✓ (' + channelIds.length + ' channel)', 'success');
  log('Config disimpan · ' + channelIds.length + ' channel', 'success');
  console.log('[SAVE OK]', json.id, 'channels=', json.channelIds);
}

async function toggleStartStop() {
  const p = getActiveProject();
  if (!p) return;

  const channelIds = getSelectedChannelIds();

  if (!p.running) {
    // Auto-save if channels selected
    if (channelIds.length) {
      await saveConfig();
      // re-fetch active after save
      const updated = getActiveProject();
      if (!updated) return;
    } else if (!(p.channelIds && p.channelIds.length) && !p.channelId) {
      toast('Pilih channel dulu lalu Simpan Config', 'error');
      return;
    }
  }

  const endpoint = p.running ? 'stop' : 'start';
  const body = endpoint === 'start' ? { token: state.token } : null;
  const { ok, json } = await api('/api/projects/' + p.id + '/' + endpoint, 'POST', body);
  if (!ok) {
    const msg = (json && (json.detail || json.error)) || ('Gagal ' + endpoint);
    toast(msg, 'error');
    log('❌ ' + msg, 'error');
    // If project vanished (memory restart), refresh list
    if (json && /tidak ditemukan|Not found/i.test(String(json.error || ''))) {
      await fetchProjects();
      renderProjectList();
      state.activeProjectId = null;
      if ($('empty-state')) $('empty-state').style.display = '';
      if ($('project-panel')) $('project-panel').style.display = 'none';
    }
    return;
  }

  p.running = !p.running;
  updateStartStopUI(p.running);
  renderProjectList();

  if (p.running) {
    log('▶ Autopost dimulai di server. Boleh tutup website, tetap jalan 24/7.', 'success');
    toast('Autopost dimulai', 'success');
  } else {
    log('⏹ Autopost dihentikan', 'info');
    toast('Autopost dihentikan', 'info');
  }
}

async function deleteProject(id) {
  stopPolling(id);
  const { ok } = await api('/api/projects/' + id, 'DELETE');
  if (!ok) { toast('Gagal hapus', 'error'); return; }
  state.projects = state.projects.filter(function (p) { return p.id !== id; });
  if (state.activeProjectId === id) {
    state.activeProjectId = null;
    if ($('empty-state')) $('empty-state').style.display = '';
    if ($('project-panel')) $('project-panel').style.display = 'none';
  }
  renderProjectList();
  toast('Project dihapus', 'info');
}

function insertEmoji(emoji) {
  const ta = $('cfg-message');
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + emoji.length;
  ta.focus();
}
window.insertEmoji = insertEmoji;

// ── Events ─────────────────────────────────────────────
function bindEvents() {
  const loginForm = $('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      const input = $('token-input');
      const token = input ? input.value.trim() : '';
      if (!token) return;

      const btn = $('login-btn');
      const btnText = $('login-btn-text');
      const spinner = $('login-spinner');
      if (btn) btn.disabled = true;
      if (btnText) btnText.style.display = 'none';
      if (spinner) spinner.style.display = '';

      const user = await validateToken(token);

      if (btn) btn.disabled = false;
      if (btnText) btnText.style.display = '';
      if (spinner) spinner.style.display = 'none';

      if (!user) return;

      state.token = cleanTokenClient(token);
      state.user = user;
      saveSession();
      await mountApp();
    });
  }

  const toggleVis = $('toggle-token-vis');
  if (toggleVis) {
    toggleVis.addEventListener('click', function () {
      const input = $('token-input');
      const eye = $('eye-icon');
      const eyeOff = $('eye-off-icon');
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        if (eye) eye.style.display = 'none';
        if (eyeOff) eyeOff.style.display = '';
      } else {
        input.type = 'password';
        if (eye) eye.style.display = '';
        if (eyeOff) eyeOff.style.display = 'none';
      }
    });
  }

  const addBtn = $('add-project-btn');
  if (addBtn) addBtn.addEventListener('click', addProject);

  const saveBtn = $('save-config-btn');
  if (saveBtn) saveBtn.addEventListener('click', saveConfig);

  const startBtn = $('start-stop-btn');
  if (startBtn) startBtn.addEventListener('click', toggleStartStop);

  const delBtn = $('delete-project-btn');
  if (delBtn) {
    delBtn.addEventListener('click', function () {
      const p = getActiveProject();
      if (!p) return;
      if (confirm('Hapus project "' + p.name + '"?')) deleteProject(p.id);
    });
  }

  const clearLog = $('clear-log-btn');
  if (clearLog) {
    clearLog.addEventListener('click', function () {
      const body = $('log-body');
      if (body) body.innerHTML = '<div class="log-empty">Log dibersihkan.</div>';
    });
  }

  const logoutBtn = $('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      Object.keys(pollers).forEach(stopPolling);
      state.token = null;
      state.user = null;
      state.projects = [];
      state.activeProjectId = null;
      state.guilds = [];
      state.channelsCache = {};
      clearSession();
      const input = $('token-input');
      if (input) input.value = '';
      showScreen('login');
      toast('Logout berhasil. Autopost aktif tetap jalan di server.', 'info');
    });
  }

  const guildSel = $('cfg-guild');
  if (guildSel) {
    guildSel.addEventListener('change', function (e) {
      loadChannels(e.target.value);
    });
  }
}

async function mountApp() {
  setUserChip(state.user);
  await fetchProjects();
  renderProjectList();
  showScreen('app');
  await loadGuilds();
  if (state.projects.length === 1) {
    selectProject(state.projects[0].id);
  }
}

// ── Boot ───────────────────────────────────────────────
(async function init() {
  bindEvents();
  if (loadSession()) {
    await mountApp();
  } else {
    showScreen('login');
  }
})();
