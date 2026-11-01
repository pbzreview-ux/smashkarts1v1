(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, Number(n) || 0));
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const STORAGE = 'kart_hub_v24_state';
  const TOKEN_KEY = 'smash_secure_account_v12';
  const GUEST_KEY = 'kart_hub_guest_v24';

  function readJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch { return fallback; }
  }
  function writeJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function randomGuest() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return `Guest-${s}`;
  }
  function guestName() {
    let name = localStorage.getItem(GUEST_KEY);
    if (!name) { name = randomGuest(); localStorage.setItem(GUEST_KEY, name); }
    return name;
  }
  function readSecureSession() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.token) return parsed;
      return typeof parsed === 'string' ? { token: parsed } : null;
    } catch {
      const raw = localStorage.getItem(TOKEN_KEY);
      return raw ? { token: raw } : null;
    }
  }
  function storeSecureSession(token, user) {
    const record = { token, ...(user || {}) };
    writeJSON(TOKEN_KEY, record);
    try { localStorage.setItem('user_session', JSON.stringify(record)); } catch {}
  }
  function clearSecureSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('user_session');
  }

  const defaults = {
    view: 'home',
    launchMode: 'embed',
    region: 'auto',
    ffaSize: 12,
    ffaPublic: true,
    ffaQueueType: 'casual',
    autoReady: true,
    autoOpenMatch: true,
    topBarHeight: 56,
    topBarDrop: 0,
    compact: false,
    highContrast: false,
    largeText: false,
    reduceMotion: false,
    streamerHideCode: true,
    streamerSafeNotifications: true,
    mapFocus: '',
    weaponFocus: '',
    grind: {
      sessionStartedAt: Date.now(), sessionPausedAt: 0, pausedTotal: 0, running: true,
      wins: 0, losses: 0, kills: 0, deaths: 0, reps: 0, streak: 0, bestStreak: 0,
      goalWins: 10, goalMatches: 20, goalReps: 50, dailyNote: '', activeDrills: [], history: []
    },
    featureSearch: '',
    featureCategory: 'All',
    featureFlags: {}
  };

  let saved = readJSON(STORAGE, {});
  let state = {
    ...defaults,
    ...saved,
    grind: { ...defaults.grind, ...(saved.grind || {}) },
    featureFlags: { ...(saved.featureFlags || {}) }
  };
  const runtime = {
    connected: false,
    account: null,
    guest: { username: guestName(), isGuest: true, level: 1, xp: 0, rating1v1: 1000, ratingFFA: 1000, roles: {} },
    avatar: '', badges: [], friends: [], requests: [], archivedDMs: [], onlineUsers: [], publicRooms: [], tournaments: [], canCreateTournament: false,
    dmTarget: '', dmHistory: [], queueCounts: {}, queueState: null, activeMatchId: '', roomBotStatus: '', currentRoom: null,
    stream: null, detector: { reference: null, timer: null, cooldownUntil: 0 }, streamerLive: false
  };

  function save() { writeJSON(STORAGE, state); applyVisualSettings(); updateChrome(); }
  function currentUser() { return runtime.account || runtime.guest; }
  function isGuest() { return !runtime.account; }
  function currentName() { return currentUser()?.username || 'Guest'; }
  function formatTime(sec) { const s = Math.max(0, Math.floor(sec)); return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
  function sessionSeconds() {
    const g = state.grind;
    const end = g.running ? Date.now() : (g.sessionPausedAt || Date.now());
    return Math.max(0, Math.floor((end - g.sessionStartedAt - (g.pausedTotal || 0)) / 1000));
  }
  function toast(message, type='info') {
    const host = $('#toastHost'); if (!host) return;
    const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = message; host.appendChild(el);
    setTimeout(() => el.remove(), state.streamerSafeNotifications && runtime.streamerLive ? 1800 : 3400);
  }

  function createSocketFallback() {
    const handlers = {};
    return { connected:false, id:'offline', on(name, fn){(handlers[name] ||= []).push(fn); return this;}, emit(){return this;}, io:{on(){}} };
  }
  const socket = typeof window.io === 'function' ? window.io() : createSocketFallback();

  const drillCategories = [
    'Movement','Aim','Dodging','Routing','Pickup Control','Rocket Timing','Nuke Timing','Bullet Control','Cannon Control','Grenuke Control',
    'Positioning','Camera Control','Prediction','Recovery','Pressure','Defense','Aggression','Consistency'
  ];
  const drillTemplates = [
    'Warmup','Precision','Speed Reps','No-Death Challenge','30 Second Burst','5 Minute Focus','Pressure Test','Consistency Set','Left-Side Focus','Right-Side Focus',
    'Center Control','Low-Health Discipline','Spawn Read','Turn Timing','Target Swap','Retreat Timing','Pickup Route','Crosshair Discipline','Late-Game Focus','Tournament Pace',
    'Recovery Reset','Three-Win Set','Ten-Repetition Set','Zero-Panic Set','Map Awareness','Weapon Discipline','Reaction Test','Prediction Reps','Closing Drill','Daily Challenge'
  ];
  const drills = [];
  for (const category of drillCategories) {
    for (const template of drillTemplates) {
      const id = `drill:${category}:${template}`;
      drills.push({ id, category, name: `${category} · ${template}`, desc: `Track a focused ${category.toLowerCase()} session using the ${template.toLowerCase()} format.` });
    }
  }
  const featureOptions = [
    ['Launcher','Quick play button'],['Launcher','Remember last section'],['Launcher','Compact side rails'],['Launcher','Command palette'],
    ['Matchmaking','Auto ready'],['Matchmaking','Auto open room'],['Matchmaking','Region preference'],['Matchmaking','Live queue counters'],
    ['Grinding','Session timer'],['Grinding','Kill counter'],['Grinding','Death counter'],['Grinding','Rep counter'],['Grinding','Daily goals'],['Grinding','Focus notes'],
    ['Coach','Screen sharing'],['Coach','Reference death detector'],['Streamer','Safe notifications'],['Streamer','Hide room code'],
    ['Game Bar','Adjust height'],['Game Bar','Adjust drop'],['Accessibility','High contrast'],['Accessibility','Reduced motion'],['Accessibility','Large text']
  ].map(([category,name],i)=>({id:`option:${i}`,category,name,desc:'Hub preference / utility option.'}));
  const featureCatalog = [...drills, ...featureOptions];

  function applyVisualSettings() {
    document.documentElement.style.setProperty('--game-bar-height', `${clamp(state.topBarHeight,38,120)}px`);
    document.documentElement.style.setProperty('--game-bar-drop', `${clamp(state.topBarDrop,0,220)}px`);
    document.body.classList.toggle('compact', !!state.compact);
    document.body.classList.toggle('high-contrast', !!state.highContrast);
    document.body.classList.toggle('large-text', !!state.largeText);
    document.body.classList.toggle('reduce-motion', !!state.reduceMotion);
  }

  function roleBadges() {
    const r = runtime.account?.roles || {};
    const out = [];
    if (r.owner) out.push(['OWNER','owner']);
    if (r.moderator) out.push(['MOD','mod']);
    if (r.streamer) out.push(['STREAMER','streamer']);
    if (r.tourneyHost) out.push(['TOURNEY','host']);
    return out;
  }

  function updateChrome() {
    const user = currentUser();
    const name = user?.username || 'Guest';
    $('#profileName').textContent = name;
    $('#profileMode').textContent = isGuest() ? 'Guest mode · stats local only' : 'Saved account';
    $('#profileLevel').textContent = `LVL ${Number(user?.level || 1)}`;
    $('#profileXp').textContent = `${Number(user?.xp || 0)} XP`;
    $('#rating1v1').textContent = Number(user?.rating1v1 || 1000);
    $('#ratingFfa').textContent = Number(user?.ratingFFA || 1000);
    const xpWithin = Number(user?.xp || 0) % 250;
    $('#profileXpBar').style.width = `${Math.min(100, (xpWithin / 250) * 100)}%`;
    $('#profileAvatarFallback').textContent = name.slice(0,1).toUpperCase();
    const avatarBtn = $('#profileAvatarButton'), img = $('#profileAvatarImage');
    if (runtime.avatar) { img.src = runtime.avatar; avatarBtn.classList.add('has-image'); } else { img.removeAttribute('src'); avatarBtn.classList.remove('has-image'); }
    $('#profileBadges').innerHTML = roleBadges().map(([label,cls])=>`<span class="badge ${cls}">${esc(label)}</span>`).join('');
    $('#accountButton').textContent = isGuest() ? 'LOG IN' : name;
    $('#onlineCount').textContent = `${runtime.onlineUsers.length} online`;
    $('#miniWins').textContent = state.grind.wins;
    $('#miniLosses').textContent = state.grind.losses;
    $('#miniKills').textContent = state.grind.kills;
    $('#miniDeaths').textContent = state.grind.deaths;
    $('#quickMapFocus').value = state.mapFocus || '';
    $('#quickWeaponFocus').value = state.weaponFocus || '';
    $('#casualCount').textContent = Number(runtime.queueCounts['1v1:casual:2'] || 0);
    $('#rankedCount').textContent = Number(runtime.queueCounts['1v1:ranked:2'] || 0);
    const queued = runtime.queueState?.state === 'queued' || runtime.queueState?.state === 'ready_check';
    $('#cancelQueueQuick').classList.toggle('hidden', !queued);
    $('#quickQueueStatus').textContent = queueStatusText();
    $$('.dock button').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.view));
    $$('.segmented [data-action="set-ffa-size"]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.size) === Number(state.ffaSize)));
  }

  function queueStatusText() {
    if (!runtime.queueState) return 'Not searching';
    const s = runtime.queueState.state;
    if (s === 'queued') return `Searching ${String(runtime.queueState.queueType || '').toUpperCase()} 1v1…`;
    if (s === 'ready_check') return 'Match found · auto-readying…';
    return runtime.roomBotStatus || runtime.queueState.message || String(s || 'Ready');
  }

  function viewHeader(title, subtitle, actions='') {
    return `<div class="view-header"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="view-actions">${actions}</div></div>`;
  }

  function setView(view) {
    state.view = view;
    save();
    renderView();
    $('#contentViewport')?.focus({preventScroll:true});
  }

  function renderView() {
    const root = $('#contentViewport'); if (!root) return;
    const view = state.view;
    const renderers = { home:renderHome, arena:renderArena, ffa:renderFFA, grind:renderGrind, stats:renderStats, coach:renderCoach, social:renderSocial, tournaments:renderTournaments, features:renderFeatures, settings:renderSettings, public:renderPublicRooms };
    (renderers[view] || renderHome)(root);
    updateChrome();
  }

  function renderHome(root) {
    root.innerHTML = `<div class="launcher-view">
      <div>${viewHeader('KART HUB','Launch Smash Karts, grind, queue and manage everything without leaving the hub.')}</div>
      <div class="launcher-hero">
        <div>
          <div class="launcher-logo">KART <span>HUB</span></div>
          <button class="launcher-play" data-action="play-sk">▶ PLAY</button>
          <div class="launcher-subactions"><button class="secondary" data-action="create-room">＋ CREATE</button><button class="secondary" data-action="nav" data-view="public">↪ JOIN</button></div>
        </div>
      </div>
      <div>
        <div class="launcher-modes">
          <button class="mode-tile arena" data-action="nav" data-view="arena"><b>⚔ 1v1 ARENA</b><small>Casual, Ranked, Custom, live queue counts</small></button>
          <button class="mode-tile" data-action="nav" data-view="ffa"><b>🔥 FFA</b><small>12 / 24 player lobby discovery and creation</small></button>
          <button class="mode-tile grind" data-action="nav" data-view="grind"><b>◎ GRIND LAB</b><small>540 drills, reps, goals, notes and sessions</small></button>
          <button class="mode-tile event" data-action="nav" data-view="tournaments"><b>♛ TOURNAMENTS</b><small>Events, registration, host tools and schedules</small></button>
        </div>
        <div class="launcher-foot">
          <div><small>1v1 queue</small><b>${Number(runtime.queueCounts['1v1:casual:2']||0)+Number(runtime.queueCounts['1v1:ranked:2']||0)} searching</b></div>
          <div><small>Online</small><b>${runtime.onlineUsers.length} players</b></div>
          <div><small>Session</small><b>${formatTime(sessionSeconds())}</b></div>
          <div><small>Focus</small><b>${esc(state.mapFocus || state.weaponFocus || 'Free play')}</b></div>
        </div>
      </div>
    </div>`;
  }

  function renderArena(root) {
    const q = runtime.queueState;
    root.innerHTML = `<div class="view">
      ${viewHeader('1v1 ARENA','Competitive play lives here, separate from the rest of the launcher.', `<button class="secondary" data-action="cancel-queue">CANCEL QUEUE</button>`)}
      <div class="big-choice-grid">
        <button class="big-choice" data-action="queue-1v1" data-type="casual"><b>CASUAL</b><p>${Number(runtime.queueCounts['1v1:casual:2']||0)} searching · fastest match · guests allowed</p></button>
        <button class="big-choice ranked" data-action="queue-1v1" data-type="ranked"><b>RANKED</b><p>${Number(runtime.queueCounts['1v1:ranked:2']||0)} searching · rating based · saved account required</p></button>
        <button class="big-choice custom" data-action="custom-1v1"><b>CUSTOM</b><p>Create or paste your own private Smash Karts room.</p></button>
      </div>
      <div class="view-grid">
        <section class="view-card span-6"><div class="section-kicker">QUEUE STATUS</div><h2>${esc(queueStatusText())}</h2><p class="muted">${q?.joinedAt ? `Searching for ${Math.max(0,Math.floor((Date.now()-q.joinedAt)/1000))} seconds` : 'Pick Casual or Ranked above.'}</p><div class="tag-row"><span class="tag">Region: ${esc(state.region)}</span><span class="tag">Auto ready: ${state.autoReady?'ON':'OFF'}</span><span class="tag">Auto open: ${state.autoOpenMatch?'ON':'OFF'}</span></div></section>
        <section class="view-card span-6"><div class="section-kicker">MATCH OPTIONS</div>
          <label class="toggle"><span>Region</span><select class="select" data-setting="region"><option value="auto">Auto</option><option value="us-east">US East</option><option value="us-west">US West</option><option value="eu">Europe</option><option value="asia">Asia</option></select></label>
          <label class="toggle"><input type="checkbox" data-setting="autoReady" ${state.autoReady?'checked':''}> Auto-ready matched 1v1s</label>
          <label class="toggle"><input type="checkbox" data-setting="autoOpenMatch" ${state.autoOpenMatch?'checked':''}> Auto-open the room when ready</label>
        </section>
        <section class="view-card span-12"><div class="section-kicker">GRIND SHORTCUTS</div><div class="filter-row"><button class="secondary" data-action="start-preset" data-preset="Movement · Warmup">MOVEMENT WARMUP</button><button class="secondary" data-action="start-preset" data-preset="Aim · Precision">AIM PRECISION</button><button class="secondary" data-action="start-preset" data-preset="Dodging · No-Death Challenge">NO-DEATH</button><button class="secondary" data-action="log-result" data-result="win">LOG WIN</button><button class="secondary" data-action="log-result" data-result="loss">LOG LOSS</button></div></section>
      </div>
    </div>`;
    const region = $('[data-setting="region"]', root); if (region) region.value = state.region;
  }

  function renderFFA(root) {
    root.innerHTML = `<div class="view">
      ${viewHeader('FFA','Find or create 12 / 24 player lobbies.', `<button class="secondary" data-action="nav" data-view="public">PUBLIC LOBBIES</button>`)}
      <div class="view-grid">
        <section class="view-card span-6"><div class="section-kicker">FIND A LOBBY</div><div class="segmented"><button data-action="set-ffa-size" data-size="12" class="${state.ffaSize===12?'active':''}">12 PLAYERS</button><button data-action="set-ffa-size" data-size="24" class="${state.ffaSize===24?'active':''}">24 PLAYERS</button></div><label>Queue type<select class="select" data-setting="ffaQueueType"><option value="casual">Casual</option><option value="ranked">Ranked</option></select></label><button class="primary wide" data-action="play-ffa" style="margin-top:12px">FIND FFA</button></section>
        <section class="view-card span-6"><div class="section-kicker">CREATE FFA</div><label class="toggle"><input type="checkbox" data-setting="ffaPublic" ${state.ffaPublic?'checked':''}> Public lobby</label><p>Create a hub lobby first, then paste the Smash Karts share link when your room is ready.</p><button class="success wide" data-action="create-ffa">CREATE ${state.ffaSize}-PLAYER LOBBY</button></section>
        <section class="view-card span-12"><div class="section-kicker">QUICK OPTIONS</div><div class="filter-row"><button class="secondary" data-action="play-sk">FREE PLAY</button><button class="secondary" data-action="nav" data-view="public">BROWSE ROOMS</button><button class="secondary" data-action="nav" data-view="grind">FFA GRIND DRILLS</button><button class="secondary" data-action="nav" data-view="settings">LAUNCH SETTINGS</button></div></section>
      </div>
    </div>`;
    $('[data-setting="ffaQueueType"]', root).value = state.ffaQueueType;
  }

  function counterRow(key,label,value) { return `<div class="counter-row"><span>${esc(label)}</span><button data-action="counter" data-key="${key}" data-delta="-1">−</button><span class="counter-value">${value}</span><button data-action="counter" data-key="${key}" data-delta="1">＋</button></div>`; }
  function goalRow(label,value,goal) { const pct = goal ? Math.min(100, value/goal*100) : 0; return `<div class="goal-row"><header><span>${esc(label)}</span><b>${value}/${goal}</b></header><div class="goal-track"><div class="goal-fill" style="width:${pct}%"></div></div></div>`; }

  function renderGrind(root) {
    const g = state.grind;
    const active = g.activeDrills || [];
    root.innerHTML = `<div class="view">
      ${viewHeader('GRIND LAB','Track real practice instead of just playing random matches.', `<button class="secondary" data-action="pause-session">${g.running?'PAUSE':'RESUME'}</button><button class="danger" data-action="reset-session">RESET SESSION</button>`)}
      <div class="view-grid">
        <section class="view-card span-4"><div class="section-kicker">SESSION</div><h1 id="grindClock">${formatTime(sessionSeconds())}</h1><p>${esc(state.mapFocus||'Any map')} · ${esc(state.weaponFocus||'Any weapon')}</p><label>Daily focus<textarea id="dailyNote" class="textarea">${esc(g.dailyNote||'')}</textarea></label><button class="secondary wide" data-action="save-note">SAVE NOTE</button></section>
        <section class="view-card span-4"><div class="section-kicker">LIVE COUNTERS</div>${counterRow('kills','Kills',g.kills)}${counterRow('deaths','Deaths',g.deaths)}${counterRow('wins','Wins',g.wins)}${counterRow('losses','Losses',g.losses)}${counterRow('reps','Reps',g.reps)}</section>
        <section class="view-card span-4"><div class="section-kicker">DAILY GOALS</div>${goalRow('Wins',g.wins,g.goalWins)}${goalRow('Matches',g.wins+g.losses,g.goalMatches)}${goalRow('Reps',g.reps,g.goalReps)}<button class="gold wide" data-action="edit-goals">EDIT GOALS</button></section>
        <section class="view-card span-6"><div class="section-kicker">ACTIVE DRILLS</div><div class="drill-list">${active.length ? active.map(id=>{const d=drills.find(x=>x.id===id);return d?`<div class="drill-item"><div><b>${esc(d.name)}</b><small>${esc(d.desc)}</small></div><button class="danger" data-action="remove-drill" data-id="${esc(id)}">REMOVE</button></div>`:'';}).join('') : '<p>No drills queued. Use a preset or open Feature Vault.</p>'}</div></section>
        <section class="view-card span-6"><div class="section-kicker">QUICK PRESETS</div><div class="filter-row"><button class="secondary" data-action="start-preset" data-preset="Movement · Warmup">MOVEMENT</button><button class="secondary" data-action="start-preset" data-preset="Aim · Speed Reps">AIM SPEED</button><button class="secondary" data-action="start-preset" data-preset="Dodging · No-Death Challenge">NO-DEATH</button><button class="secondary" data-action="start-preset" data-preset="Prediction · Prediction Reps">PREDICTION</button><button class="secondary" data-action="start-preset" data-preset="Consistency · Daily Challenge">CONSISTENCY</button><button class="secondary" data-action="nav" data-view="features">ALL 540 DRILLS</button></div></section>
      </div>
    </div>`;
  }

  function renderStats(root) {
    const g = state.grind, matches = g.wins + g.losses, kd = g.deaths ? (g.kills/g.deaths).toFixed(2) : g.kills.toFixed(2), wr = matches ? Math.round(g.wins/matches*100) : 0;
    root.innerHTML = `<div class="view">${viewHeader('STATS','Local grind analytics plus saved account ratings.')}
      <div class="stat-cards"><div class="stat-card"><small>WIN RATE</small><b>${wr}%</b></div><div class="stat-card"><small>K/D</small><b>${kd}</b></div><div class="stat-card"><small>BEST STREAK</small><b>${g.bestStreak}</b></div><div class="stat-card"><small>SESSION TIME</small><b>${formatTime(sessionSeconds())}</b></div></div>
      <div class="view-grid"><section class="view-card span-6"><div class="section-kicker">ACCOUNT</div><div class="stat-cards"><div class="stat-card"><small>LEVEL</small><b>${currentUser()?.level||1}</b></div><div class="stat-card"><small>1v1 RATING</small><b>${currentUser()?.rating1v1||1000}</b></div><div class="stat-card"><small>FFA RATING</small><b>${currentUser()?.ratingFFA||1000}</b></div><div class="stat-card"><small>XP</small><b>${currentUser()?.xp||0}</b></div></div></section><section class="view-card span-6"><div class="section-kicker">SESSION</div><div class="stat-cards"><div class="stat-card"><small>WINS</small><b>${g.wins}</b></div><div class="stat-card"><small>LOSSES</small><b>${g.losses}</b></div><div class="stat-card"><small>KILLS</small><b>${g.kills}</b></div><div class="stat-card"><small>DEATHS</small><b>${g.deaths}</b></div></div></section><section class="view-card span-12"><div class="section-kicker">DATA TOOLS</div><div class="filter-row"><button class="secondary" data-action="export-grind">EXPORT GRIND DATA</button><button class="danger" data-action="reset-grind-stats">RESET LOCAL STATS</button></div></section></div>
    </div>`;
  }

  function renderCoach(root) {
    root.innerHTML = `<div class="view">${viewHeader('COACH MODE','Share the Smash Karts tab voluntarily and track deaths, kills and focus in real time.')}
      <div class="view-grid"><section class="view-card span-8"><div class="coach-preview"><video id="coachVideo" autoplay muted playsinline></video></div><div class="filter-row" style="margin-top:10px"><button class="success" data-action="start-share">START SCREEN SHARE</button><button class="danger" data-action="stop-share">STOP SHARE</button><button class="secondary" data-action="calibrate-death">CALIBRATE DEATH SCREEN</button><button class="secondary" data-action="toggle-detector">${runtime.detector.timer?'STOP DETECTOR':'START DETECTOR'}</button></div></section><section class="view-card span-4"><div class="section-kicker">LIVE TRACKER</div>${counterRow('deaths','Deaths',state.grind.deaths)}${counterRow('kills','Kills',state.grind.kills)}<button class="danger wide" data-action="mark-death">＋ MARK DEATH</button><button class="success wide" data-action="mark-kill" style="margin-top:7px">＋ MARK KILL</button><p style="font-size:10px;color:var(--muted);margin-top:12px">The automatic detector compares a small reference frame locally in your browser. Nothing is shared unless you explicitly start screen sharing.</p></section></div>
    </div>`;
    attachStreamToVideo();
  }

  function renderSocial(root) {
    const friends = runtime.friends || [], requests = runtime.requests || [], users = runtime.onlineUsers.filter(u=>u.username!==currentName());
    const target = runtime.dmTarget;
    root.innerHTML = `<div class="view">${viewHeader('SOCIAL','Friends, online players and direct messages.', `<button class="secondary" data-action="refresh-social">REFRESH</button>`)}
      <div class="message-layout"><section class="view-card conversation-list inner-scroll"><div class="section-kicker">FRIEND REQUESTS</div>${requests.length?requests.map(name=>`<div class="person-item"><b>${esc(name)}</b><div><button class="success" data-action="friend-accept" data-name="${esc(name)}">✓</button><button class="danger" data-action="friend-decline" data-name="${esc(name)}">✕</button></div></div>`).join(''):'<p>No requests.</p>'}<div class="section-kicker" style="margin-top:14px">FRIENDS</div>${friends.length?friends.map(name=>`<button class="person-item" data-action="open-dm" data-name="${esc(name)}"><b>${esc(name)}</b><small>OPEN DM</small></button>`).join(''):'<p>No friends yet.</p>'}<div class="section-kicker" style="margin-top:14px">ONLINE</div>${users.map(u=>`<div class="person-item"><div><b>${esc(u.username)}</b><small>LVL ${u.level||1} · ${u.badges?.join(' · ')|| (u.isGuest?'Guest':'Player')}</small></div>${friends.includes(u.username)?`<button class="secondary" data-action="open-dm" data-name="${esc(u.username)}">DM</button>`:u.isGuest?'':`<button class="success" data-action="friend-add" data-socket="${esc(u.id)}">ADD</button>`}</div>`).join('')}</section><section class="view-card chat-panel"><div><div class="section-kicker">DIRECT MESSAGE</div><h2>${target?esc(target):'Choose a friend'}</h2></div><div class="message-list" id="dmMessages">${target?renderMessagesHTML(runtime.dmHistory):'<p>Select a friend from the left.</p>'}</div><div class="chat-compose"><input id="dmInput" class="field" placeholder="Message…" ${target?'':'disabled'}><button class="success" data-action="send-dm" ${target?'':'disabled'}>SEND</button></div></section></div>
    </div>`;
    requestSocialData();
  }
  function renderMessagesHTML(history) { return (history||[]).map(m=>`<div class="message-bubble ${m.senderUsername===currentName()?'mine':''}"><b>${esc(m.senderUsername)}</b><div>${esc(m.message)}</div></div>`).join('') || '<p>No messages yet.</p>'; }

  function renderTournaments(root) {
    root.innerHTML = `<div class="view">${viewHeader('TOURNAMENTS','Public events, private invites, registration and host controls.', `<button class="secondary" data-action="refresh-tournaments">REFRESH</button>${runtime.canCreateTournament?'<button class="gold" data-action="create-tournament">CREATE EVENT</button>':''}`)}<section class="view-card inner-scroll"><div class="tourney-list">${runtime.tournaments.length?runtime.tournaments.map(t=>`<div class="tourney-item"><div><b>${esc(t.name)}</b><small>${esc(String(t.mode||'').toUpperCase())} · ${t.participants?.length||0}/${t.capacity||0} · ${esc(t.status||'registration')} · host ${esc(t.hostUsername||'')}</small></div><div class="filter-row"><button class="success" data-action="register-tournament" data-id="${esc(t.id)}">REGISTER</button>${t.bracketUrl?`<button class="secondary" data-action="open-url" data-url="${esc(t.bracketUrl)}">BRACKET</button>`:''}</div></div>`).join(''):'<p>No visible tournaments right now.</p>'}</div></section></div>`;
    socket.emit('get_tournaments');
  }

  function renderFeatures(root) {
    const q = String(state.featureSearch||'').toLowerCase(), cat = state.featureCategory || 'All';
    const filtered = featureCatalog.filter(f => (cat==='All'||f.category===cat) && (!q || `${f.name} ${f.category} ${f.desc}`.toLowerCase().includes(q)));
    const cats = ['All', ...new Set(featureCatalog.map(f=>f.category))];
    root.innerHTML = `<div class="view">${viewHeader('FEATURE VAULT',`${featureCatalog.length} grind drills and hub options. Only this panel scrolls.`)}<div class="view-card"><div class="filter-row"><input id="featureSearch" class="field" style="max-width:380px" value="${esc(state.featureSearch||'')}" placeholder="Search ${featureCatalog.length} features"><select id="featureCategory" class="select" style="max-width:220px">${cats.map(c=>`<option ${c===cat?'selected':''}>${esc(c)}</option>`).join('')}</select><button class="secondary" data-action="clear-feature-search">CLEAR</button></div></div><section class="view-card inner-scroll" style="flex:1"><div class="feature-list">${filtered.map(f=>`<div class="feature-item"><div><b>${esc(f.name)}</b><small>${esc(f.category)} · ${esc(f.desc)}</small></div><button class="${f.id.startsWith('drill:')?'success':'secondary'}" data-action="feature-use" data-id="${esc(f.id)}">${f.id.startsWith('drill:')?'QUEUE DRILL':(state.featureFlags[f.id]?'ON':'TOGGLE')}</button></div>`).join('')}</div></section></div>`;
    $('#featureSearch',root).addEventListener('input', e=>{state.featureSearch=e.target.value;save();renderFeatures(root);});
    $('#featureCategory',root).addEventListener('change', e=>{state.featureCategory=e.target.value;save();renderFeatures(root);});
  }

  function renderSettings(root) {
    root.innerHTML = `<div class="view">${viewHeader('SETTINGS','Launcher, gameplay, bar position, accessibility and streaming preferences.')}
      <div class="view-grid"><section class="view-card span-6"><div class="section-kicker">GAME LAUNCH</div><label>Launch mode<select class="select" data-setting="launchMode"><option value="embed">Embedded</option><option value="tab">New browser tab</option></select></label><label class="toggle"><input type="checkbox" data-setting="autoOpenMatch" ${state.autoOpenMatch?'checked':''}> Auto-open matched rooms</label><label class="toggle"><input type="checkbox" data-setting="autoReady" ${state.autoReady?'checked':''}> Auto-ready 1v1 matchmaking</label><label>Default region<select class="select" data-setting="region"><option value="auto">Auto</option><option value="us-east">US East</option><option value="us-west">US West</option><option value="eu">Europe</option><option value="asia">Asia</option></select></label></section>
      <section class="view-card span-6"><div class="section-kicker">IN-GAME TOP BAR</div><div class="range-line"><span>Height</span><input type="range" min="38" max="120" value="${state.topBarHeight}" data-range="topBarHeight"><b id="barHeightValue">${state.topBarHeight}px</b></div><div class="range-line"><span>Drop from top</span><input type="range" min="0" max="220" value="${state.topBarDrop}" data-range="topBarDrop"><b id="barDropValue">${state.topBarDrop}px</b></div><p>These controls change exactly how far the launcher bar drops down while the embedded game is open.</p></section>
      <section class="view-card span-6"><div class="section-kicker">VISUALS</div><label class="toggle"><input type="checkbox" data-setting="compact" ${state.compact?'checked':''}> Compact launcher</label><label class="toggle"><input type="checkbox" data-setting="highContrast" ${state.highContrast?'checked':''}> High contrast</label><label class="toggle"><input type="checkbox" data-setting="largeText" ${state.largeText?'checked':''}> Larger text</label><label class="toggle"><input type="checkbox" data-setting="reduceMotion" ${state.reduceMotion?'checked':''}> Reduce motion</label></section>
      <section class="view-card span-6"><div class="section-kicker">STREAMER SAFETY</div><label class="toggle"><input type="checkbox" data-setting="streamerHideCode" ${state.streamerHideCode?'checked':''}> Hide room code on streamer UI</label><label class="toggle"><input type="checkbox" data-setting="streamerSafeNotifications" ${state.streamerSafeNotifications?'checked':''}> Short safe notifications while live</label><button class="secondary wide" data-action="toggle-streamer-live">${runtime.streamerLive?'STOP STREAMER LIVE':'GO STREAMER LIVE'}</button></section>
      <section class="view-card span-12"><div class="section-kicker">ACCOUNT & DATA</div><div class="filter-row"><button class="secondary" data-action="avatar-upload">UPLOAD PFP</button>${!isGuest()?'<button class="secondary" data-action="rename-account">CHANGE USERNAME</button><button class="danger" data-action="logout">LOG OUT</button>':'<button class="gold" data-action="account">LOG IN / CREATE ACCOUNT</button>'}<button class="danger" data-action="reset-hub">RESET LOCAL HUB SETTINGS</button></div></section></div>
    </div>`;
    $('[data-setting="launchMode"]',root).value = state.launchMode;
    $('[data-setting="region"]',root).value = state.region;
  }

  function renderPublicRooms(root) {
    root.innerHTML = `<div class="view">${viewHeader('PUBLIC LOBBIES','Browse live hub rooms.', `<button class="secondary" data-action="refresh-rooms">REFRESH</button>`)}<section class="view-card inner-scroll"><div class="room-list">${runtime.publicRooms.length?runtime.publicRooms.map(r=>`<div class="room-item"><div><b>${esc(r.hostName)} · ${esc(String(r.mode||'').toUpperCase())}</b><small>${r.players?.length||0}/${r.maxPlayers} · ${esc(r.queueType||'casual')} · ${r.readyCount||0} ready</small></div><button class="success" data-action="join-room" data-id="${esc(r.roomId)}">JOIN</button></div>`).join(''):'<p>No public hub lobbies are available.</p>'}</div></section></div>`;
    socket.emit('get_public_rooms');
  }

  function renderStreamer(root) { state.view='settings'; renderSettings(root); }

  function requestSocialData() { socket.emit('get_groups'); }

  function showModal(title, body, actions='') {
    $('#modalCard').innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-action="close-modal">✕</button></div>${body}${actions?`<div class="modal-actions">${actions}</div>`:''}`;
    $('#modalLayer').classList.remove('hidden');
  }
  function closeModal() { $('#modalLayer').classList.add('hidden'); $('#modalCard').innerHTML=''; }

  function accountModal() {
    if (!isGuest()) {
      showModal('ACCOUNT', `<div class="view-card"><b>${esc(currentName())}</b><p>${esc(runtime.account.email||'')}</p><div class="tag-row">${roleBadges().map(([x])=>`<span class="tag">${esc(x)}</span>`).join('')}</div></div>`, `<button class="secondary" data-action="close-modal">CLOSE</button><button class="danger" data-action="logout">LOG OUT</button>`);
      return;
    }
    showModal('LOG IN / CREATE ACCOUNT', `<div class="form-grid"><label>Email<input id="authEmail" class="field" type="email"></label><label>Password<input id="authPassword" class="field" type="password"></label><label>Username (for registration)<input id="authUsername" class="field" maxlength="20"></label><label>Owner setup key (PRIME only)<input id="authOwnerKey" class="field" type="password"></label></div><p style="color:var(--muted);font-size:10px">Log in with email/password. To create a new account, also enter a username.</p>`, `<button class="secondary" data-action="login">LOG IN</button><button class="gold" data-action="register">CREATE ACCOUNT</button>`);
  }

  function createRoomModal(mode='1v1') {
    showModal(mode==='1v1'?'CUSTOM 1v1':'ROOM LINK', `<div class="form-grid"><label class="full">Smash Karts share link, room code, or full share text<input id="roomShareInput" class="field" placeholder="https://smashkarts.io/link/?room=..."></label>${mode==='1v1'?'<label>Win condition<select id="roomWin" class="select"><option>First to 3</option><option>First to 6</option><option>First to 10</option></select></label><label class="toggle"><input id="roomPublic" type="checkbox" checked> Public hub lobby</label>':''}</div>`, `<button class="secondary" data-action="close-modal">CANCEL</button><button class="success" data-action="submit-custom-room" data-mode="${mode}">CREATE</button>`);
  }

  function roomModal(room) {
    runtime.currentRoom = room;
    const code = roomCode(room.smashUrl);
    const members = (room.players||[]).map(p=>`<div class="person-item"><div><b>${esc(p.name)}</b><small>${p.ready?'READY':'NOT READY'} ${p.name===room.hostName?'· HOST':''}</small></div></div>`).join('');
    showModal(`${String(room.mode||'ROOM').toUpperCase()} LOBBY`, `<div class="view-grid"><section class="view-card span-6"><div class="section-kicker">PLAYERS</div>${members||'<p>No players.</p>'}</section><section class="view-card span-6"><div class="section-kicker">ROOM</div><p>Code: <b>${esc(state.streamerHideCode?'HIDDEN':(code||'not set'))}</b></p><p>${esc(room.winCondition||'')}</p><div class="filter-row"><button class="secondary" data-action="set-room-link">PASTE / CHANGE LINK</button><button class="secondary" data-action="copy-room">COPY CODE</button></div></section></div>`, `<button class="danger" data-action="leave-room">LEAVE</button><button class="success" data-action="launch-current-room">JOIN GAME</button>`);
  }

  function matchHostModal(data) {
    runtime.activeMatchId = data.matchId || runtime.activeMatchId;
    showModal('CREATE THE MATCH ROOM', `<p>${esc(data.message||'Create the private room and paste the full share link here.')}</p><label>Smash Karts share link<input id="matchRoomInput" class="field" placeholder="Paste share link or full share text"></label>`, `<button class="danger" data-action="cancel-queue">CANCEL</button><button class="success" data-action="submit-match-room">SUBMIT ROOM</button>`);
  }

  function extractSmashUrl(raw) {
    const text = String(raw||'').trim().replace(/["']/g,'');
    const full = text.match(/https?:\/\/(?:www\.)?smashkarts\.io(?:\/link\/)?\?[^\s]+/i);
    if (full) { let u=full[0]; if(!u.includes('/link/')) u=u.replace('smashkarts.io/?','smashkarts.io/link/?'); return u; }
    const code = (text.match(/room=([A-Za-z0-9]+)/i)||text.match(/Room:\s*([A-Za-z0-9]+)/i)||[])[1];
    if (code) return `https://smashkarts.io/link/?room=${encodeURIComponent(code)}`;
    if (/^[A-Za-z0-9]{4,16}$/.test(text)) return `https://smashkarts.io/link/?room=${encodeURIComponent(text)}`;
    return '';
  }
  function roomCode(url) { try { return new URL(url).searchParams.get('room') || ''; } catch { return ''; } }

  function launchGame(url, label='SMASH KARTS') {
    const clean = extractSmashUrl(url) || (String(url||'').startsWith('https://smashkarts.io') ? String(url) : 'https://smashkarts.io');
    state.grind.reps += 1; save();
    if (state.launchMode === 'tab') { window.open(clean, '_blank', 'noopener'); toast('Smash Karts opened in a new tab.'); return; }
    $('#gameRoomLabel').textContent = state.streamerHideCode && runtime.streamerLive ? label : (roomCode(clean) ? `ROOM ${roomCode(clean)}` : label);
    $('#gameStatus').textContent = state.mapFocus || state.weaponFocus ? `${state.mapFocus||'Any map'} · ${state.weaponFocus||'Any weapon'}` : 'Playing';
    $('#gameFrame').src = clean;
    $('#gameShell').classList.remove('hidden');
  }
  function exitGame() { $('#gameShell').classList.add('hidden'); $('#gameFrame').src=''; }

  function join1v1(type) {
    if (type === 'ranked' && isGuest()) { toast('Ranked requires a saved account.','warn'); accountModal(); return; }
    runtime.queueState = {state:'queued', queueType:type, joinedAt:Date.now()};
    socket.emit('join_matchmaking_queue',{mode:'1v1',queueType:type,maxPlayers:2,region:state.region||'auto'});
    updateChrome(); if(state.view==='arena')renderView();
  }
  function cancelQueue() { socket.emit('cancel_matchmaking'); runtime.queueState=null; runtime.activeMatchId=''; runtime.roomBotStatus=''; closeModal(); updateChrome(); if(state.view==='arena')renderView(); }

  function logResult(win) {
    const g=state.grind; if(win){g.wins++;g.streak++;g.bestStreak=Math.max(g.bestStreak,g.streak);}else{g.losses++;g.streak=0;} save(); if(!isGuest())socket.emit('record_match_played'); renderView();
  }
  function updateCounter(key, delta) { if (!(key in state.grind)) return; state.grind[key] = Math.max(0, Number(state.grind[key]||0)+Number(delta||0)); save(); renderView(); }
  function startPreset(name) { const drill=drills.find(d=>d.name===name) || drills.find(d=>d.name.includes(name)); if(!drill)return; if(!state.grind.activeDrills.includes(drill.id))state.grind.activeDrills.push(drill.id); state.view='grind'; save(); renderView(); toast(`Queued ${drill.name}`); }

  async function startShare() {
    if (!navigator.mediaDevices?.getDisplayMedia) return toast('Screen sharing is not supported in this browser.','warn');
    try { runtime.stream = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:15,max:30}},audio:false}); runtime.stream.getVideoTracks()[0]?.addEventListener('ended',()=>{runtime.stream=null; stopDetector(); if(state.view==='coach')renderView();}); renderCoach($('#contentViewport')); } catch { toast('Screen sharing was cancelled.'); }
  }
  function stopShare() { runtime.stream?.getTracks?.().forEach(t=>t.stop()); runtime.stream=null; stopDetector(); if(state.view==='coach')renderView(); }
  function attachStreamToVideo() { const v=$('#coachVideo'); if(v && runtime.stream) v.srcObject=runtime.stream; }
  function frameSignature() {
    const v=$('#coachVideo'); if(!v || !runtime.stream || !v.videoWidth)return null;
    const c=document.createElement('canvas'); c.width=64;c.height=36; const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(v,0,0,c.width,c.height); const data=x.getImageData(0,0,c.width,c.height).data; const arr=[]; for(let i=0;i<data.length;i+=32) arr.push((data[i]+data[i+1]+data[i+2])/3); return arr;
  }
  function calibrateDeath() { const sig=frameSignature(); if(!sig)return toast('Start screen sharing and show a real death screen first.','warn'); runtime.detector.reference=sig; toast('Death-screen reference captured.'); }
  function detectorSimilarity(a,b){if(!a||!b||a.length!==b.length)return 0;let diff=0;for(let i=0;i<a.length;i++)diff+=Math.abs(a[i]-b[i]);return 1-(diff/(a.length*255));}
  function toggleDetector(){ runtime.detector.timer?stopDetector():startDetector(); if(state.view==='coach')renderView(); }
  function startDetector(){ if(!runtime.stream||!runtime.detector.reference)return toast('Share the screen and calibrate a death screen first.','warn'); runtime.detector.timer=setInterval(()=>{const now=Date.now();if(now<runtime.detector.cooldownUntil)return;const sim=detectorSimilarity(runtime.detector.reference,frameSignature());if(sim>.92){state.grind.deaths++;runtime.detector.cooldownUntil=now+6000;save();toast('Death detected.');if(state.view==='coach')renderView();}},850); toast('Death detector started.'); }
  function stopDetector(){ if(runtime.detector.timer)clearInterval(runtime.detector.timer);runtime.detector.timer=null; }

  function requestAuth(mode) {
    const email=$('#authEmail')?.value.trim(), password=$('#authPassword')?.value||'', username=$('#authUsername')?.value.trim(), ownerSetupKey=$('#authOwnerKey')?.value||'';
    if(!email||!password)return toast('Enter email and password.','warn');
    if(mode==='register'){ if(!username)return toast('Enter a username to register.','warn'); socket.emit('account_register',{email,password,username,ownerSetupKey}); }
    else socket.emit('account_login',{email,password});
  }
  function logout(){const token=readSecureSession()?.token;if(token)socket.emit('account_logout',{token});clearSecureSession();runtime.account=null;runtime.avatar='';runtime.badges=[];closeModal();socket.emit('set_user_session',{username:guestName(),isGuest:true});save();renderView();}

  function requestSocialRefresh(){ socket.emit('get_public_rooms'); }
  function sendDM(){const input=$('#dmInput');if(!runtime.dmTarget||!input?.value.trim())return;socket.emit('send_direct_message',{targetUsername:runtime.dmTarget,message:input.value.trim()});input.value='';}

  function createTournamentModal() {
    showModal('CREATE TOURNAMENT', `<div class="form-grid"><label>Name<input id="tourName" class="field"></label><label>Mode<select id="tourMode" class="select"><option value="1v1">1v1</option><option value="ffa">FFA</option></select></label><label>Capacity<input id="tourCap" class="field" type="number" min="2" max="256" value="16"></label><label>Start<input id="tourStart" class="field" type="datetime-local"></label><label class="full">Regions<input id="tourRegions" class="field" placeholder="US East, US West, Europe"></label><label class="full">Map pool<input id="tourMaps" class="field" placeholder="Maps / arenas"></label><label class="full">Rules<textarea id="tourRules" class="textarea"></textarea></label><label class="toggle full"><input id="tourPublic" type="checkbox" checked> Public event</label></div>`, `<button class="secondary" data-action="close-modal">CANCEL</button><button class="gold" data-action="submit-tournament">CREATE</button>`);
  }

  function commandList() { return [
    ['Home',()=>setView('home')],['1v1 Arena',()=>setView('arena')],['FFA',()=>setView('ffa')],['Grind Lab',()=>setView('grind')],['Stats',()=>setView('stats')],['Coach',()=>setView('coach')],['Social',()=>setView('social')],['Tournaments',()=>setView('tournaments')],['Feature Vault',()=>setView('features')],['Settings',()=>setView('settings')],['Play Smash Karts',()=>launchGame('https://smashkarts.io')],['Casual 1v1',()=>join1v1('casual')],['Ranked 1v1',()=>join1v1('ranked')],['Public Lobbies',()=>setView('public')],['Cancel Queue',cancelQueue]
  ]; }
  function openCommand(){ $('#commandPalette').classList.remove('hidden');$('#commandInput').value='';renderCommands();setTimeout(()=>$('#commandInput').focus(),0); }
  function closeCommand(){ $('#commandPalette').classList.add('hidden'); }
  function renderCommands(){const q=String($('#commandInput')?.value||'').toLowerCase();$('#commandResults').innerHTML=commandList().filter(([n])=>n.toLowerCase().includes(q)).map(([n],i)=>`<button class="command-item" data-action="run-command" data-index="${i}"><b>${esc(n)}</b><span>↵</span></button>`).join('');}

  const actions = {
    nav: el=>setView(el.dataset.view),
    'open-command':()=>openCommand(),
    account:()=>accountModal(),
    profile:()=>accountModal(),
    'save-focus':()=>{state.mapFocus=$('#quickMapFocus').value.trim();state.weaponFocus=$('#quickWeaponFocus').value.trim();save();toast('Focus saved.');},
    'play-sk':()=>launchGame('https://smashkarts.io'),
    'create-room':()=>createRoomModal('1v1'),
    'set-ffa-size':el=>{state.ffaSize=Number(el.dataset.size)===24?24:12;save();renderView();},
    'queue-1v1':el=>join1v1(el.dataset.type==='ranked'?'ranked':'casual'),
    'cancel-queue':()=>cancelQueue(),
    'custom-1v1':()=>createRoomModal('1v1'),
    'play-ffa':()=>{if(state.ffaQueueType==='ranked'&&isGuest()){toast('Ranked FFA requires an account.','warn');return accountModal();}socket.emit('play_ffa',{queueType:state.ffaQueueType,maxPlayers:state.ffaSize});},
    'create-ffa':()=>socket.emit('create_ffa_lobby',{queueType:state.ffaQueueType,maxPlayers:state.ffaSize,isPublic:state.ffaPublic}),
    counter:el=>updateCounter(el.dataset.key,Number(el.dataset.delta)),
    'pause-session':()=>{const g=state.grind;if(g.running){g.running=false;g.sessionPausedAt=Date.now();}else{g.running=true;g.pausedTotal+=(Date.now()-g.sessionPausedAt);g.sessionPausedAt=0;}save();renderView();},
    'reset-session':()=>{if(!confirm('Reset this grind session?'))return;state.grind={...defaults.grind,goalWins:state.grind.goalWins,goalMatches:state.grind.goalMatches,goalReps:state.grind.goalReps,history:state.grind.history||[],activeDrills:state.grind.activeDrills||[],sessionStartedAt:Date.now()};save();renderView();},
    'save-note':()=>{state.grind.dailyNote=$('#dailyNote')?.value||'';save();toast('Grind note saved.');},
    'edit-goals':()=>showModal('EDIT DAILY GOALS',`<div class="form-grid"><label>Wins<input id="goalWins" class="field" type="number" value="${state.grind.goalWins}"></label><label>Matches<input id="goalMatches" class="field" type="number" value="${state.grind.goalMatches}"></label><label>Reps<input id="goalReps" class="field" type="number" value="${state.grind.goalReps}"></label></div>`,`<button class="success" data-action="save-goals">SAVE</button>`),
    'save-goals':()=>{state.grind.goalWins=Math.max(1,Number($('#goalWins').value)||1);state.grind.goalMatches=Math.max(1,Number($('#goalMatches').value)||1);state.grind.goalReps=Math.max(1,Number($('#goalReps').value)||1);save();closeModal();renderView();},
    'start-preset':el=>startPreset(el.dataset.preset),
    'remove-drill':el=>{state.grind.activeDrills=state.grind.activeDrills.filter(id=>id!==el.dataset.id);save();renderView();},
    'feature-use':el=>{const id=el.dataset.id;if(id.startsWith('drill:')){if(!state.grind.activeDrills.includes(id))state.grind.activeDrills.push(id);toast('Drill queued.');}else state.featureFlags[id]=!state.featureFlags[id];save();renderView();},
    'clear-feature-search':()=>{state.featureSearch='';state.featureCategory='All';save();renderView();},
    'log-result':el=>logResult(el.dataset.result==='win'),
    'export-grind':()=>{const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),grind:state.grind,mapFocus:state.mapFocus,weaponFocus:state.weaponFocus},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='kart-hub-grind-data.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);},
    'reset-grind-stats':()=>{if(confirm('Reset local wins/losses/kills/deaths/reps?')){Object.assign(state.grind,{wins:0,losses:0,kills:0,deaths:0,reps:0,streak:0,bestStreak:0});save();renderView();}},
    'start-share':()=>startShare(), 'stop-share':()=>stopShare(), 'calibrate-death':()=>calibrateDeath(), 'toggle-detector':()=>toggleDetector(),
    'mark-death':()=>updateCounter('deaths',1), 'mark-kill':()=>updateCounter('kills',1),
    'refresh-social':()=>{requestSocialRefresh();renderView();},
    'friend-add':el=>socket.emit('send_friend_request',{targetSocketId:el.dataset.socket}),
    'friend-accept':el=>socket.emit('accept_friend_request',{challengerUsername:el.dataset.name}),
    'friend-decline':el=>socket.emit('decline_friend_request',{challengerUsername:el.dataset.name}),
    'open-dm':el=>{runtime.dmTarget=el.dataset.name;runtime.dmHistory=[];socket.emit('get_dm_history',{targetUsername:runtime.dmTarget});renderView();},
    'send-dm':()=>sendDM(),
    'refresh-tournaments':()=>socket.emit('get_tournaments'), 'create-tournament':()=>createTournamentModal(),
    'register-tournament':el=>socket.emit('register_tournament',{tournamentId:el.dataset.id,region:state.region==='auto'?'':state.region}),
    'open-url':el=>window.open(el.dataset.url,'_blank','noopener'),
    'submit-tournament':()=>{const start=Date.parse($('#tourStart').value)||Date.now();socket.emit('create_tournament',{name:$('#tourName').value.trim(),mode:$('#tourMode').value,capacity:Number($('#tourCap').value)||16,startAt:start,regions:$('#tourRegions').value,mapPool:$('#tourMaps').value,rules:$('#tourRules').value,isPublic:$('#tourPublic').checked});},
    'refresh-rooms':()=>socket.emit('get_public_rooms'), 'join-room':el=>socket.emit('join_public_room',{roomId:el.dataset.id}),
    'close-modal':()=>closeModal(), login:()=>requestAuth('login'), register:()=>requestAuth('register'), logout:()=>logout(),
    'submit-custom-room':el=>{const url=extractSmashUrl($('#roomShareInput').value);if(!url)return toast('Paste a valid Smash Karts room link or code.','warn');socket.emit('create_room',{smashUrl:url,winCondition:$('#roomWin')?.value||'First to 3',isPublic:$('#roomPublic')?.checked!==false,queueType:'casual'});},
    'set-room-link':()=>showModal('SET SMASH KARTS ROOM',`<label>Share link<input id="roomUpdateInput" class="field" placeholder="Paste link or code"></label>`,`<button class="success" data-action="submit-room-link">SAVE LINK</button>`),
    'submit-room-link':()=>{if(!runtime.currentRoom)return;socket.emit('update_lobby_game_code',{roomId:runtime.currentRoom.roomId,code:$('#roomUpdateInput').value});closeModal();},
    'launch-current-room':()=>{if(runtime.currentRoom?.smashUrl){closeModal();launchGame(runtime.currentRoom.smashUrl,String(runtime.currentRoom.mode||'GAME').toUpperCase());}},
    'leave-room':()=>{if(runtime.currentRoom)socket.emit('leave_match',{roomId:runtime.currentRoom.roomId});runtime.currentRoom=null;closeModal();},
    'copy-room':()=>{const code=roomCode(runtime.currentRoom?.smashUrl||'');if(code)navigator.clipboard?.writeText(code).then(()=>toast('Room code copied.'));else toast('No room code is set yet.','warn');},
    'submit-match-room':()=>{const share=$('#matchRoomInput').value;if(!runtime.activeMatchId)return;socket.emit('submit_match_room',{matchId:runtime.activeMatchId,shareText:share});},
    'exit-game':()=>exitGame(), 'nav-game-settings':()=>{exitGame();setView('settings');},
    'avatar-upload':()=>$('#avatarFileInput').click(),
    'rename-account':()=>showModal('CHANGE USERNAME',`<label>New username<input id="renameInput" class="field" value="${esc(currentName())}"></label>`,`<button class="success" data-action="submit-rename">SAVE</button>`),
    'submit-rename':()=>socket.emit('account_rename',{newUsername:$('#renameInput').value.trim()}),
    'toggle-streamer-live':()=>{if(isGuest())return toast('Log in first.','warn');socket.emit('set_streamer_live',{live:!runtime.streamerLive});},
    'reset-hub':()=>{if(confirm('Reset local launcher settings and grind data?')){localStorage.removeItem(STORAGE);location.reload();}},
    'run-command':el=>{const row=commandList()[Number(el.dataset.index)];closeCommand();row?.[1]?.();}
  };

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]'); if (!el) return;
    const fn = actions[el.dataset.action];
    if (!fn) { console.error('Missing action:', el.dataset.action, el); toast(`Button action missing: ${el.dataset.action}`,'error'); return; }
    event.preventDefault();
    try { fn(el,event); } catch (error) { console.error(error); toast(`Button error: ${error.message}`,'error'); }
  });
  document.addEventListener('change', event => {
    const el=event.target;
    if(el.matches('[data-setting]')){const key=el.dataset.setting;state[key]=el.type==='checkbox'?el.checked:el.value;save();if(['ffaPublic','ffaQueueType'].includes(key)&&state.view==='ffa')renderView();}
  });
  document.addEventListener('input', event => {
    const el=event.target;
    if(el.matches('[data-range]')){const key=el.dataset.range;state[key]=Number(el.value);save();if(key==='topBarHeight')$('#barHeightValue').textContent=`${state.topBarHeight}px`;if(key==='topBarDrop')$('#barDropValue').textContent=`${state.topBarDrop}px`;}
  });
  $('#commandInput').addEventListener('input',renderCommands);
  $('#commandPalette').addEventListener('click',e=>{if(e.target.id==='commandPalette')closeCommand();});
  $('#modalLayer').addEventListener('click',e=>{if(e.target.id==='modalLayer')closeModal();});
  $('#avatarFileInput').addEventListener('change', async e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>8*1024*1024)return toast('Use an image under 8 MB.','warn');const reader=new FileReader();reader.onload=()=>socket.emit('update_profile_picture',{dataUrl:String(reader.result||'')});reader.readAsDataURL(f);});
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCommand();return;}if(e.key==='Escape'){closeCommand();closeModal();return;}if(['INPUT','TEXTAREA','SELECT'].includes(e.target?.tagName))return;if(e.key.toLowerCase()==='h')setView('home');if(e.key==='1')setView('arena');if(e.key.toLowerCase()==='g')setView('grind');});

  // Socket lifecycle / authentication
  socket.on('connect',()=>{runtime.connected=true;$('#connectionDot').classList.add('online');$('#connectionDot').classList.remove('offline');$('#connectionText').textContent='Connected';const token=readSecureSession()?.token;if(token)socket.emit('account_resume',{token});else socket.emit('set_user_session',{username:guestName(),isGuest:true});socket.emit('get_matchmaking_counts');socket.emit('get_public_rooms');socket.emit('get_tournaments');});
  socket.on('disconnect',()=>{runtime.connected=false;$('#connectionDot').classList.remove('online');$('#connectionDot').classList.add('offline');$('#connectionText').textContent='Offline';});
  socket.on('auth_success',data=>{runtime.account=data.user||null;runtime.badges=data.badges||[];if(data.token)storeSecureSession(data.token,data.user);closeModal();toast(data.resumed?'Session restored.':'Logged in.');updateChrome();renderView();});
  socket.on('auth_error',data=>toast(data?.message||'Authentication failed.','error'));
  socket.on('auth_session_invalid',data=>{clearSecureSession();runtime.account=null;socket.emit('set_user_session',{username:guestName(),isGuest:true});toast(data?.message||'Saved login expired.','warn');updateChrome();renderView();});
  socket.on('session_mode',data=>{if(data?.isGuest){runtime.guest={...runtime.guest,username:data.username||guestName(),isGuest:true};if(!runtime.account)updateChrome();}});
  socket.on('account_state_changed',user=>{runtime.account=user||runtime.account;updateChrome();if(state.view==='settings')renderView();});
  socket.on('account_renamed',data=>{runtime.account=data.user||runtime.account;closeModal();toast('Username changed.');updateChrome();renderView();});
  socket.on('account_rename_error',data=>toast(data?.message||'Could not rename.','error'));
  socket.on('username_reserved',data=>toast(data?.message||'Username reserved.','warn'));
  socket.on('saved_profile',data=>{runtime.avatar=data?.avatar||'';updateChrome();});
  socket.on('profile_picture_updated',data=>{runtime.avatar=data?.avatar||'';toast('Profile picture saved.');updateChrome();});
  socket.on('profile_picture_error',data=>toast(data?.message||'Could not save image.','error'));

  // Online / friends / DMs
  socket.on('online_users_update',data=>{runtime.onlineUsers=Array.isArray(data?.users)?data.users:[];updateChrome();if(state.view==='social')renderView();});
  socket.on('saved_friends',data=>{runtime.friends=Array.isArray(data?.friends)?data.friends:[];runtime.requests=Array.isArray(data?.requests)?data.requests:[];runtime.archivedDMs=Array.isArray(data?.archivedDMs)?data.archivedDMs:[];if(state.view==='social')renderView();});
  socket.on('friend_requests_update',list=>{runtime.requests=Array.isArray(list)?list:[];if(state.view==='social')renderView();});
  socket.on('friend_request_accepted',data=>{if(data?.username&&!runtime.friends.includes(data.username))runtime.friends.push(data.username);toast(`You and ${data?.username||'player'} are now friends.`);if(state.view==='social')renderView();});
  socket.on('receive_friend_request',data=>toast(`Friend request from ${data?.fromUsername||'player'}.`));
  socket.on('load_dm_history',data=>{runtime.dmTarget=data?.targetUsername||runtime.dmTarget;runtime.dmHistory=data?.history||[];if(state.view==='social')renderView();});
  socket.on('dm_sent_success',data=>{runtime.dmHistory=data?.history||[];if(state.view==='social')renderView();});
  socket.on('receive_direct_message',data=>{if(runtime.dmTarget===data?.senderUsername)runtime.dmHistory=data?.history||[];toast(`Message from ${data?.senderUsername||'friend'}.`);if(state.view==='social')renderView();});
  socket.on('dm_error',data=>toast(data?.message||'Message failed.','error'));
  socket.on('account_required',data=>{toast(data?.message||'Log in for that feature.','warn');accountModal();});

  // Rooms / FFA
  socket.on('public_rooms_update',rooms=>{runtime.publicRooms=Array.isArray(rooms)?rooms:[];if(state.view==='public')renderView();});
  socket.on('room_created',room=>roomModal(room));
  socket.on('ffa_lobby_ready',room=>roomModal(room));
  socket.on('ffa_no_lobby',data=>toast(data?.message||'No FFA lobby available.','warn'));
  socket.on('room_error',data=>toast(data?.message||'Room error.','error'));
  socket.on('saved_room_update',room=>{if(runtime.currentRoom?.roomId===room?.roomId){runtime.currentRoom=room;if(!$('#modalLayer').classList.contains('hidden'))roomModal(room);}});
  socket.on('lobby_game_code_updated',data=>{if(runtime.currentRoom?.roomId===data?.roomId){runtime.currentRoom.smashUrl=data.smashUrl;toast('Room link updated.');roomModal(runtime.currentRoom);}});
  socket.on('kicked_from_lobby',()=>{runtime.currentRoom=null;closeModal();toast('You were removed from the lobby.','warn');});
  socket.on('lobby_deleted',()=>{runtime.currentRoom=null;closeModal();toast('Lobby closed.');});

  // Matchmaking
  socket.on('matchmaking_counts',data=>{runtime.queueCounts=data?.queues||{};updateChrome();if(state.view==='arena')renderView();});
  socket.on('matchmaking_state',data=>{runtime.queueState=data;if(data?.matchId)runtime.activeMatchId=data.matchId;updateChrome();if(state.view==='arena')renderView();});
  socket.on('match_found',data=>{runtime.activeMatchId=data.matchId;runtime.queueState={state:'ready_check',...data};toast('1v1 match found.');if(state.autoReady)socket.emit('matchmaking_ready',{matchId:data.matchId,ready:true});else showModal('MATCH FOUND',`<p>${(data.players||[]).map(p=>esc(p.username)).join(' vs ')}</p>`,`<button class="danger" data-action="cancel-queue">DECLINE</button><button class="success" data-action="manual-ready">READY</button>`);updateChrome();});
  actions['manual-ready']=()=>{if(runtime.activeMatchId)socket.emit('matchmaking_ready',{matchId:runtime.activeMatchId,ready:true});closeModal();};
  socket.on('match_ready_update',data=>{runtime.queueState={state:'ready_check',...data};updateChrome();});
  socket.on('match_room_bot_status',data=>{runtime.roomBotStatus=data?.message||data?.status||'';updateChrome();if(state.view==='arena')renderView();});
  socket.on('match_room_host_required',data=>matchHostModal(data));
  socket.on('match_room_waiting',data=>toast(`Waiting for ${data?.hostUsername||'the host'} to create the room.`));
  socket.on('matchmaking_room_ready',room=>{runtime.queueState=null;runtime.activeMatchId='';runtime.roomBotStatus='';runtime.currentRoom=room;closeModal();toast('Match room ready.');if(state.autoOpenMatch)launchGame(room.smashUrl,'1v1 MATCH');else roomModal(room);updateChrome();});
  socket.on('matchmaking_match_failed',data=>{runtime.queueState=null;runtime.activeMatchId='';runtime.roomBotStatus='';closeModal();toast(data?.message||'Match failed.','warn');updateChrome();if(state.view==='arena')renderView();});
  socket.on('matchmaking_error',data=>toast(data?.message||'Matchmaking error.','error'));
  socket.on('matchmaking_cancelled',()=>{runtime.queueState=null;runtime.activeMatchId='';runtime.roomBotStatus='';updateChrome();if(state.view==='arena')renderView();});

  // Tournaments / streaming
  socket.on('tournament_list',data=>{runtime.tournaments=Array.isArray(data?.tournaments)?data.tournaments:[];runtime.canCreateTournament=!!data?.canCreate;if(state.view==='tournaments')renderView();});
  socket.on('tournament_created',t=>{closeModal();toast(`Tournament created: ${t?.name||''}`);socket.emit('get_tournaments');});
  socket.on('tournament_invite',t=>toast(`Tournament invite: ${t?.name||'event'}`));
  socket.on('tournament_error',data=>toast(data?.message||'Tournament error.','error'));
  socket.on('streamer_state',data=>{runtime.streamerLive=!!data?.live;toast(runtime.streamerLive?'Streamer LIVE enabled.':'Streamer LIVE disabled.');if(state.view==='settings')renderView();});

  // Feature / UI self-test
  window.__kartHubButtonAudit = () => {
    const missing = [...new Set($$('[data-action]').map(el=>el.dataset.action).filter(name=>!actions[name]))];
    return { totalButtons: $$('[data-action]').length, registeredActions: Object.keys(actions).length, missing };
  };

  setInterval(()=>{ const text=formatTime(sessionSeconds()); if($('#miniSession'))$('#miniSession').textContent=text; if($('#grindClock'))$('#grindClock').textContent=text; },1000);

  applyVisualSettings();
  updateChrome();
  renderView();
  if (!socket.connected) { $('#connectionText').textContent='Connecting'; }
  console.log(`[KART HUB V24] Loaded ${featureCatalog.length} vault items.`, window.__kartHubButtonAudit());
})();
