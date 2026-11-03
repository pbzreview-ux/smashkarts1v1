const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// =========================================================
// SPOTIFY CONFIG + EXISTING SCRIPT.JS + THIS UPGRADE PACK
// =========================================================
// The Spotify Client ID belongs to the WEBSITE, not each player.
// Every browser gets the same public Client ID from this endpoint.
// No Client Secret is ever sent to the browser.
app.get('/api/spotify-config', (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });

    res.json({
        clientId: String(process.env.SPOTIFY_CLIENT_ID || '').trim()
    });
});

app.get('/script.js', (req, res) => {
    const filename = ['script.js', 'script(1).js'].find(name =>
        fs.existsSync(path.join(__dirname, name))
    );

    if (!filename) {
        return res.status(404).send('Missing script.js or script(1).js');
    }

    // Do not let Render/CDN/browser cache an old copy that was generated
    // before SPOTIFY_CLIENT_ID was added.
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });

    res.type('application/javascript').send(
        fs.readFileSync(path.join(__dirname, filename), 'utf8') +
        '\nwindow.__SPOTIFY_CLIENT_ID__ = ' + JSON.stringify(String(process.env.SPOTIFY_CLIENT_ID || '').trim()) + ';' +
        '\n;(' + installMegaArena.toString() + ')();' +
        '\n;(' + installV12Platform.toString() + ')();' +
        '\n;(' + installV17Matchmaker.toString() + ')();'
    );
});

app.use((req, res, next) => {
    if (/^\/data(?:\/|$)/i.test(req.path)) return res.sendStatus(404);
    if (req.path === '/' || /\.(html|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|mp3|mp4)$/i.test(req.path)) {
        return next();
    }
    res.sendStatus(404);
});

app.use(express.static(__dirname));

// =========================================================
// PERSISTED DATA
// =========================================================
// V16: Free persistent cloud storage through Upstash Redis REST.
// No extra npm package is required; Node's built-in fetch talks directly to
// Upstash. Put UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Render.
//
// The existing platform still works with its in-memory objects, while the
// complete state is compressed and saved remotely. This keeps accounts, login
// sessions, PFPs, settings, roles, friends, DMs, groups, tournaments, ratings,
// reports, bans and audit history through Render restarts/redeploys.
const connectedPlayers = {};
const activeRoomsMap = new Map();
const automaticDataDirectory = fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data');
const dataDirectory = path.resolve(process.env.SMASH_DATA_DIR || automaticDataDirectory);
fs.mkdirSync(dataDirectory, { recursive: true });
const dataFile = path.join(dataDirectory, 'history.json');

const UPSTASH_REDIS_REST_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/$/, '');
const UPSTASH_REDIS_REST_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const UPSTASH_STATE_KEY = String(process.env.UPSTASH_STATE_KEY || 'smashkarts1v1s:platform-state:v1').trim();

function emptySavedState() {
    return { profiles: {}, stats: {}, directMessages: {}, matches: {}, accounts: {}, sessions: {}, groups: {}, tournaments: {}, reports: [], auditLog: [] };
}

function normalizeSavedState(value) {
    const state = value && typeof value === 'object' ? value : emptySavedState();
    state.profiles ||= {};
    state.stats ||= {};
    state.directMessages ||= {};
    state.matches ||= {};
    state.accounts ||= {};
    state.sessions ||= {};
    state.groups ||= {};
    state.tournaments ||= {};
    if (!Array.isArray(state.reports)) state.reports = [];
    if (!Array.isArray(state.auditLog)) state.auditLog = [];
    return state;
}

function loadLocalState() {
    try {
        if (!fs.existsSync(dataFile)) return emptySavedState();
        return normalizeSavedState(JSON.parse(fs.readFileSync(dataFile, 'utf8')));
    } catch (error) {
        console.error('[DATA] Could not read local history.json:', error.message);
        return emptySavedState();
    }
}

const saved = loadLocalState();
const profiles = Object.assign(Object.create(null), saved.profiles);
const playerStats = Object.assign(Object.create(null), saved.stats);
const directMessageStore = Object.assign(Object.create(null), saved.directMessages);
const matchHistory = Object.assign(Object.create(null), saved.matches);
const accounts = Object.assign(Object.create(null), saved.accounts);
const authSessionStore = Object.assign(Object.create(null), saved.sessions);
const groupStore = Object.assign(Object.create(null), saved.groups);
const tournamentStore = Object.assign(Object.create(null), saved.tournaments);
const reportStore = saved.reports;
const auditLog = saved.auditLog;

let cloudStorageReady = false;
let cloudSaveTimer = null;
let cloudSaveInFlight = false;
let cloudSaveAgain = false;
let latestCloudSnapshot = null;
let lastCloudSaveAt = 0;
let lastCloudError = '';

function stateSnapshot() {
    return {
        profiles,
        stats: playerStats,
        directMessages: directMessageStore,
        matches: matchHistory,
        accounts,
        sessions: authSessionStore,
        groups: groupStore,
        tournaments: tournamentStore,
        reports: reportStore,
        auditLog
    };
}

function replaceObjectContents(target, source) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source || {});
}

function applySavedState(value) {
    const next = normalizeSavedState(value);
    replaceObjectContents(profiles, next.profiles);
    replaceObjectContents(playerStats, next.stats);
    replaceObjectContents(directMessageStore, next.directMessages);
    replaceObjectContents(matchHistory, next.matches);
    replaceObjectContents(accounts, next.accounts);
    replaceObjectContents(authSessionStore, next.sessions);
    replaceObjectContents(groupStore, next.groups);
    replaceObjectContents(tournamentStore, next.tournaments);
    reportStore.splice(0, reportStore.length, ...next.reports);
    auditLog.splice(0, auditLog.length, ...next.auditLog);
}

function saveLocalBackup(snapshot) {
    try {
        const temp = dataFile + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
        fs.renameSync(temp, dataFile);
    } catch (error) {
        console.error('[DATA] Local backup failed:', error.message);
    }
}

function encodeCloudState(snapshot) {
    const json = JSON.stringify(snapshot);
    return 'gz:' + zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 6 }).toString('base64');
}

function decodeCloudState(value) {
    if (typeof value !== 'string' || !value) return null;
    if (value.startsWith('gz:')) {
        const json = zlib.gunzipSync(Buffer.from(value.slice(3), 'base64')).toString('utf8');
        return JSON.parse(json);
    }
    return JSON.parse(value);
}

async function upstashCommand(command) {
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) throw new Error('Upstash credentials are missing');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(UPSTASH_REDIS_REST_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(command),
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
        const payload = await response.json();
        if (payload && payload.error) throw new Error(payload.error);
        return payload ? payload.result : null;
    } finally {
        clearTimeout(timeout);
    }
}

async function flushCloudSave() {
    if (!cloudStorageReady || cloudSaveInFlight || !latestCloudSnapshot) return;
    cloudSaveInFlight = true;
    const snapshot = latestCloudSnapshot;
    latestCloudSnapshot = null;
    cloudSaveAgain = false;
    try {
        const encoded = encodeCloudState(snapshot);
        await upstashCommand(['SET', UPSTASH_STATE_KEY, encoded]);
        lastCloudSaveAt = Date.now();
        lastCloudError = '';
    } catch (error) {
        lastCloudError = String(error?.message || error);
        console.error('[DATA] Upstash save failed:', lastCloudError);
        latestCloudSnapshot = stateSnapshot();
        cloudSaveAgain = true;
    } finally {
        cloudSaveInFlight = false;
        if (cloudSaveAgain || latestCloudSnapshot) {
            clearTimeout(cloudSaveTimer);
            cloudSaveTimer = setTimeout(() => flushCloudSave(), 1000);
        }
    }
}

function saveHistory() {
    const snapshot = stateSnapshot();
    // Local copy helps development and gives us a temporary fallback if the
    // cloud API has a short outage. The cloud copy is the permanent source.
    saveLocalBackup(snapshot);
    if (!cloudStorageReady) return;
    latestCloudSnapshot = snapshot;
    cloudSaveAgain = true;
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => flushCloudSave(), 350);
}

async function initializeCloudStorage() {
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
        console.warn('[DATA] Upstash is not configured. Using local history.json only.');
        console.warn('[DATA] Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Render for permanent storage.');
        return;
    }

    try {
        const remoteValue = await upstashCommand(['GET', UPSTASH_STATE_KEY]);
        if (remoteValue) {
            applySavedState(decodeCloudState(remoteValue));
            console.log('[DATA] Loaded permanent platform state from Upstash.');
        } else {
            await upstashCommand(['SET', UPSTASH_STATE_KEY, encodeCloudState(stateSnapshot())]);
            console.log('[DATA] Upstash was empty; imported the current local platform state.');
        }
        cloudStorageReady = true;
        lastCloudSaveAt = Date.now();
        console.log('[DATA] Upstash persistent storage is ACTIVE.');
    } catch (error) {
        cloudStorageReady = false;
        lastCloudError = String(error?.message || error);
        console.error('[DATA] Could not connect to Upstash:', lastCloudError);
        console.error('[DATA] Site will continue using local history.json until Upstash is fixed.');
    }
}

async function flushPersistenceBeforeExit() {
    clearTimeout(cloudSaveTimer);
    if (!cloudStorageReady) return;
    latestCloudSnapshot = stateSnapshot();
    cloudSaveAgain = true;
    const started = Date.now();
    while (cloudSaveInFlight && Date.now() - started < 2500) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    await flushCloudSave();
}

function defaultSavedSettings() {
    return {
        gameplayMode: 'popup',
        queueType: 'casual',
        streamerHideCode: false,
        streamerSafeNotifications: false
    };
}

function normalizeSavedSettings(settings) {
    const value = settings && typeof settings === 'object' ? settings : {};
    return {
        gameplayMode: value.gameplayMode === 'embed' ? 'embed' : 'popup',
        queueType: value.queueType === 'ranked' ? 'ranked' : 'casual',
        streamerHideCode: !!value.streamerHideCode,
        streamerSafeNotifications: !!value.streamerSafeNotifications
    };
}

function profileFor(username) {
    if (!profiles[username]) {
        profiles[username] = {
            friends: [],
            requests: [],
            archivedDMs: [],
            isOnline: true,
            avatar: '',
            settings: defaultSavedSettings(),
            createdAt: Date.now()
        };
    }
    profiles[username].friends ||= [];
    profiles[username].requests ||= [];
    profiles[username].archivedDMs ||= [];
    if (typeof profiles[username].avatar !== 'string') profiles[username].avatar = '';
    profiles[username].settings = normalizeSavedSettings(profiles[username].settings);
    return profiles[username];
}

function savePlayer(player) {
    if (!player || player.isGuest) return;
    const profile = profileFor(player.username);
    profile.friends = Array.from(player.friends || []);
    profile.requests = Array.from(player.friendRequests || []);
    profile.isOnline = player.isOnline !== false;
}

function syncFriends(username) {
    const profile = profileFor(username);
    for (const player of Object.values(connectedPlayers)) {
        if (player.username !== username || player.isGuest) continue;
        player.friends = new Set(profile.friends || []);
        player.friendRequests = new Set(profile.requests || []);
        io.to(player.id).emit('saved_friends', {
            friends: profile.friends || [],
            requests: profile.requests || [],
            archivedDMs: profile.archivedDMs || []
        });
    }
}

// =========================================================
// HELPERS
// =========================================================
function escapeHTML(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeUsername(name) {
    const raw = typeof name === 'string' ? name.trim() : '';
    if (!raw || /^(undefined|null)$/i.test(raw)) return 'Player';
    return escapeHTML(raw.slice(0, 20));
}

function randomGuestName() {
    return 'Guest-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

function extractSmashUrl(rawInput) {
    if (!rawInput) return null;
    let text = String(rawInput).trim().replace(/["']+/g, '');
    if (/^ttps:\/\//i.test(text)) text = 'h' + text;

    const official = text.match(/https?:\/\/(?:www\.)?smashkarts\.io\/link\/\?[^\s]+/i);
    if (official) return official[0];

    const roomLabel = text.match(/^Room:\s*([A-Za-z0-9]+)$/i);
    if (roomLabel) {
        return 'https://smashkarts.io/link/?room=' + encodeURIComponent(roomLabel[1]);
    }

    if (/^[A-Za-z0-9]+$/.test(text)) {
        return 'https://smashkarts.io/link/?room=' + encodeURIComponent(text);
    }

    return null;
}

function extractVerifiedLookingRoomUrl(rawInput) {
    if (!rawInput) return null;

    const text = String(rawInput)
        .trim()
        .replace(/["']/g, '');

    function validCode(code) {
        return typeof code === 'string' &&
            /^[A-Za-z0-9]{4,16}$/.test(code) &&
            /[A-Za-z]/.test(code) &&
            /\d/.test(code);
    }

    function normalizeOfficialUrl(candidate) {
        if (!candidate) return null;
        try {
            const url = new URL(candidate);
            const host = url.hostname.toLowerCase();
            if (host !== 'smashkarts.io' && host !== 'www.smashkarts.io') return null;
            const room = url.searchParams.get('room');
            if (!validCode(room)) return null;
            url.protocol = 'https:';
            url.hostname = 'smashkarts.io';
            return url.toString();
        } catch {
            return null;
        }
    }

    // Whole share messages are accepted. Prefer the full official URL so
    // popup users keep arena/rules/weapon parameters from Smash Karts.
    const linkMatch = text.match(/https?:\/\/(?:www\.)?smashkarts\.io\/link\/?\?[^\s]+/i)
        || text.match(/https?:\/\/(?:www\.)?smashkarts\.io\/?\?[^\s]+/i);
    if (linkMatch) {
        const full = normalizeOfficialUrl(linkMatch[0]);
        if (full) return full;
    }

    const direct = normalizeOfficialUrl(text);
    if (direct) return direct;

    const labeled = text.match(/Room:\s*([A-Za-z0-9]+)/i);
    if (labeled && validCode(labeled[1])) {
        return 'https://smashkarts.io/link/?room=' + encodeURIComponent(labeled[1]);
    }

    if (validCode(text)) {
        return 'https://smashkarts.io/link/?room=' + encodeURIComponent(text);
    }

    return null;
}

function moderateText(text) {
    if (!text) return '';
    return String(text).slice(0, 400);
}

function legacyDMKey(a, b) {
    return JSON.stringify([String(a || ''), String(b || '')].sort());
}

function dmIdentityKey(username) {
    const account = accountByUsername(username);
    return account?.id ? `acct:${account.id}` : `name:${normalizeUsernameKey(username)}`;
}

function getDMKey(a, b) {
    return JSON.stringify([dmIdentityKey(a), dmIdentityKey(b)].sort());
}

function findSocketByUsername(username) {
    const target = String(username || '').toLowerCase();
    return Object.values(connectedPlayers).find(
        p => String(p.username || '').toLowerCase() === target
    );
}

function canonicalFriendName(list, targetName) {
    const target = String(targetName || '').toLowerCase();
    return (list || []).find(name => String(name || '').toLowerCase() === target) || null;
}

function ensureMutualFriendship(usernameA, usernameB) {
    const a = sanitizeUsername(usernameA);
    const b = sanitizeUsername(usernameB);
    if (!a || !b || a === b) return false;

    const profileA = profileFor(a);
    const profileB = profileFor(b);
    let changed = false;

    if (!canonicalFriendName(profileA.friends, b)) {
        profileA.friends.push(b);
        changed = true;
    }
    if (!canonicalFriendName(profileB.friends, a)) {
        profileB.friends.push(a);
        changed = true;
    }

    profileA.requests = (profileA.requests || []).filter(name => String(name).toLowerCase() !== b.toLowerCase());
    profileB.requests = (profileB.requests || []).filter(name => String(name).toLowerCase() !== a.toLowerCase());

    const socketA = findSocketByUsername(a);
    const socketB = findSocketByUsername(b);
    if (socketA && !socketA.isGuest) socketA.friends.add(b);
    if (socketB && !socketB.isGuest) socketB.friends.add(a);

    if (changed) saveHistory();
    syncFriends(a);
    syncFriends(b);
    return true;
}

function usersAreFriends(usernameA, usernameB) {
    const a = sanitizeUsername(usernameA);
    const b = sanitizeUsername(usernameB);
    if (!a || !b || a === b) return false;

    const profileA = profileFor(a);
    const profileB = profileFor(b);
    const aHasB = !!canonicalFriendName(profileA.friends, b);
    const bHasA = !!canonicalFriendName(profileB.friends, a);

    // Older versions occasionally left one side of a friendship out of sync.
    // If either account already has the other saved, heal both sides.
    if (aHasB || bHasA) {
        ensureMutualFriendship(a, b);
        return true;
    }

    return false;
}

function roomSummary(room) {
    return {
        roomId: room.roomId,
        hostName: room.hostName,
        hostSocketId: room.hostSocketId,
        winCondition: room.winCondition,
        mode: room.mode,
        queueType: room.queueType || 'casual',
        maxPlayers: room.maxPlayers,
        players: room.players,
        isPublic: room.isPublic !== false,
        createdAt: room.createdAt,
        readyCount: room.players.filter(p => p.ready).length
    };
}

function broadcastPublicRooms() {
    io.emit(
        'public_rooms_update',
        Array.from(activeRoomsMap.values())
            .filter(room => room.isPublic !== false)
            .map(roomSummary)
    );
}

function addParticipantToHistory(room, player) {
    if (!player || player.isGuest) return;
    const savedRoom = matchHistory[room.roomId];
    if (!savedRoom) return;
    savedRoom.participants ||= [];
    if (!savedRoom.participants.includes(player.username)) {
        savedRoom.participants.push(player.username);
    }
}

function addRoomHistory(room) {
    matchHistory[room.roomId] = {
        roomId: room.roomId,
        hostName: room.hostName,
        smashUrl: room.smashUrl,
        winCondition: room.winCondition,
        mode: room.mode,
        maxPlayers: room.maxPlayers,
        createdAt: room.createdAt,
        participants: [],
        messages: []
    };
}

function transferHostIfNeeded(room) {
    if (!room.players.length) return;
    const hostStillThere = room.players.some(p => p.id === room.hostSocketId);
    if (hostStillThere) return;
    const next = room.players[0];
    room.hostSocketId = next.id;
    room.hostName = next.name;
    io.to(room.roomId).emit('lobby_host_changed', {
        roomId: room.roomId,
        hostSocketId: room.hostSocketId,
        hostName: room.hostName
    });
}

function leaveLiveRoom(socket, roomId, reason = 'left') {
    const room = activeRoomsMap.get(roomId);
    if (!room) return;
    const member = room.players.find(p => p.id === socket.id);
    if (!member) return;

    socket.leave(roomId);
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
        activeRoomsMap.delete(roomId);
        io.emit('lobby_deleted', { roomId });
        broadcastPublicRooms();
        return;
    }

    transferHostIfNeeded(room);
    io.to(roomId).emit('saved_room_update', room);
    io.to(roomId).emit('lobby_system_message', {
        roomId,
        message: `${member.name} ${reason === 'kicked' ? 'was removed from' : 'left'} the lobby.`,
        timestamp: Date.now()
    });
    broadcastPublicRooms();
}

function leaveAllRoomsExcept(socket, keepRoomId = null) {
    for (const roomId of Array.from(activeRoomsMap.keys())) {
        if (roomId !== keepRoomId) leaveLiveRoom(socket, roomId);
    }
}

function joinRoom(socket, room, player, eventName = 'room_created') {
    if (!room || !player) return false;

    leaveAllRoomsExcept(socket, room.roomId);

    let member = room.players.find(p => p.id === socket.id);
    if (!member) {
        if (room.players.length >= room.maxPlayers) {
            socket.emit('room_error', { message: 'That lobby is full.' });
            return false;
        }

        member = {
            id: socket.id,
            name: player.username,
            isGuest: !!player.isGuest,
            avatar: player.avatar || '',
            roles: publicRoles(player.roles),
            level: player.level || 1,
            ready: false,
            team: null,
            joinedAt: Date.now()
        };
        room.players.push(member);
    }

    socket.join(room.roomId);
    addParticipantToHistory(room, player);
    saveHistory();

    socket.emit(eventName, room);
    io.to(room.roomId).emit('saved_room_update', room);
    io.to(room.roomId).emit('lobby_system_message', {
        roomId: room.roomId,
        message: `${player.username} joined the lobby.`,
        timestamp: Date.now()
    });
    broadcastPublicRooms();
    return true;
}


// =========================================================
// V12 SECURE ACCOUNTS / OWNER / ROLES
// =========================================================
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
const OWNER_SETUP_KEY = String(process.env.OWNER_SETUP_KEY || '').trim();
const RESERVED_OWNER_USERNAME = 'PRIME';
const SESSION_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000; // 5-year sliding session: normal updates should not log people out

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function normalizeUsernameKey(username) {
    return String(username || '').trim().toLowerCase();
}

function isReservedOwnerName(username) {
    return normalizeUsernameKey(username) === RESERVED_OWNER_USERNAME.toLowerCase();
}

function validUsername(username) {
    return /^[A-Za-z0-9_]{3,20}$/.test(String(username || '').trim());
}

function defaultRoles() {
    return { owner: false, moderator: false, streamer: false, tourneyHost: false };
}

function normalizeRoles(roles) {
    return {
        owner: !!roles?.owner,
        moderator: !!roles?.moderator,
        streamer: !!roles?.streamer,
        tourneyHost: !!roles?.tourneyHost
    };
}

function ensureAccountShape(account) {
    if (!account) return null;
    account.id ||= crypto.randomUUID();
    account.usernameHistory = Array.isArray(account.usernameHistory) ? account.usernameHistory : [];
    account.roles = normalizeRoles(account.roles);
    account.xp = Number.isFinite(account.xp) ? account.xp : 0;
    account.level = Math.max(1, Math.min(200, Number.isFinite(account.level) ? account.level : 1));
    account.rating1v1 = Number.isFinite(account.rating1v1) ? account.rating1v1 : 1000;
    account.ratingFFA = Number.isFinite(account.ratingFFA) ? account.ratingFFA : 1000;
    account.warnings = Number.isFinite(account.warnings) ? account.warnings : 0;
    account.mutedUntil = account.mutedUntil ?? null;
    account.bannedUntil = account.bannedUntil ?? null;
    account.banReason = String(account.banReason || '');
    account.streamerLive = !!account.streamerLive;
    account.createdAt ||= Date.now();
    account.lastLoginAt ||= null;
    return account;
}

let accountShapeMigrationChanged = false;
for (const account of Object.values(accounts)) {
    const beforeId = account?.id;
    ensureAccountShape(account);
    if (!beforeId && account?.id) accountShapeMigrationChanged = true;
}

function accountByEmail(email) {
    return ensureAccountShape(accounts[normalizeEmail(email)] || null);
}

function accountByUsername(username) {
    const key = normalizeUsernameKey(username);
    return Object.values(accounts).map(ensureAccountShape).find(account => normalizeUsernameKey(account.username) === key) || null;
}

function migrateDirectMessagesToStableAccountIds() {
    const rebuilt = Object.create(null);
    let changed = false;

    for (const [key, messages] of Object.entries(directMessageStore)) {
        let parts = null;
        try { parts = JSON.parse(key); } catch {}
        let targetKey = key;

        if (Array.isArray(parts) && parts.length === 2 && !parts.every(part => String(part).startsWith('acct:') || String(part).startsWith('name:'))) {
            const left = accountByUsername(parts[0]);
            const right = accountByUsername(parts[1]);
            if (left && right) {
                targetKey = JSON.stringify([`acct:${left.id}`, `acct:${right.id}`].sort());
                if (targetKey !== key) changed = true;
            }
        }

        rebuilt[targetKey] ||= [];
        rebuilt[targetKey].push(...(Array.isArray(messages) ? messages : []));
    }

    if (changed) {
        for (const key of Object.keys(directMessageStore)) delete directMessageStore[key];
        Object.assign(directMessageStore, rebuilt);
    }

    if (changed || accountShapeMigrationChanged) saveHistory();
}
migrateDirectMessagesToStableAccountIds();

function publicRoles(roles) {
    return normalizeRoles(roles);
}

function publicAccountState(account) {
    account = ensureAccountShape(account);
    if (!account) return null;
    return {
        id: account.id,
        username: account.username,
        email: account.email,
        roles: publicRoles(account.roles),
        level: account.level,
        xp: account.xp,
        rating1v1: account.rating1v1,
        ratingFFA: account.ratingFFA,
        warnings: account.warnings,
        mutedUntil: account.mutedUntil,
        bannedUntil: account.bannedUntil,
        banReason: account.banReason,
        streamerLive: !!account.streamerLive,
        createdAt: account.createdAt
    };
}

function publicProfileState(username, viewer = null) {
    const account = accountByUsername(username);
    if (!account) return null;
    const profile = profileFor(account.username);
    const onlinePlayer = findSocketByUsername(account.username);
    const activeRoom = Array.from(activeRoomsMap.values()).find(room => room.players.some(p => p.name === account.username));
    return {
        username: account.username,
        avatar: profile.avatar || '',
        roles: publicRoles(account.roles),
        level: account.level,
        rating1v1: account.rating1v1,
        ratingFFA: account.ratingFFA,
        matches: playerStats[account.username] || 0,
        friendsCount: (profile.friends || []).length,
        online: !!onlinePlayer && onlinePlayer.isOnline !== false,
        playing: activeRoom ? String(activeRoom.mode || '').toUpperCase() : '',
        streamerLive: !!account.streamerLive,
        canSeeMusic: !!viewer && !viewer.isGuest && usersAreFriends(viewer.username, account.username)
    };
}

function passwordHash(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function passwordMatches(account, password) {
    if (!account?.passwordHash || !account?.passwordSalt) return false;
    const actual = Buffer.from(passwordHash(password, account.passwordSalt), 'hex');
    const expected = Buffer.from(account.passwordHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hashSessionToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function issueSessionToken(email) {
    const raw = crypto.randomBytes(32).toString('hex');
    authSessionStore[hashSessionToken(raw)] = {
        email: normalizeEmail(email),
        expiresAt: Date.now() + SESSION_TTL_MS
    };
    saveHistory();
    return raw;
}

function accountFromToken(token) {
    const hash = hashSessionToken(token);
    const record = authSessionStore[hash];
    if (!record) return null;
    if (!record.expiresAt || record.expiresAt < Date.now()) {
        delete authSessionStore[hash];
        saveHistory();
        return null;
    }
    const account = accountByEmail(record.email);
    if (!account) {
        delete authSessionStore[hash];
        saveHistory();
        return null;
    }
    // Sliding expiration: normal site updates/redeploys should not log a player
    // out as long as the persisted session store is still present.
    record.expiresAt = Date.now() + SESSION_TTL_MS;
    saveHistory();
    return { account, hash };
}

function revokeSessionToken(token) {
    const hash = hashSessionToken(token);
    if (authSessionStore[hash]) {
        delete authSessionStore[hash];
        saveHistory();
    }
}

function banIsActive(account) {
    if (!account?.bannedUntil) return false;
    return account.bannedUntil === -1 || account.bannedUntil > Date.now();
}

function muteIsActive(account) {
    if (!account?.mutedUntil) return false;
    return account.mutedUntil === -1 || account.mutedUntil > Date.now();
}

function isOwnerPlayer(player) {
    return !!player?.roles?.owner;
}

function isModeratorPlayer(player) {
    return !!player && (player.roles?.owner || player.roles?.moderator);
}

function canHostTournament(player) {
    return !!player && (player.roles?.owner || player.roles?.tourneyHost);
}

function roleBadges(roles) {
    const r = normalizeRoles(roles);
    const badges = [];
    if (r.owner) badges.push('DEV');
    if (r.moderator) badges.push('MOD');
    if (r.streamer) badges.push('STREAMER');
    if (r.tourneyHost) badges.push('TOURNEY HOST');
    return badges;
}

function logAudit(actor, action, target = '', details = '') {
    auditLog.unshift({
        id: crypto.randomUUID(),
        actor: actor?.username || 'SYSTEM',
        action: String(action || ''),
        target: String(target || ''),
        details: String(details || '').slice(0, 600),
        timestamp: Date.now()
    });
    if (auditLog.length > 1000) auditLog.length = 1000;
    saveHistory();
}

function syncAccountProgress(account) {
    account = ensureAccountShape(account);
    account.level = Math.max(1, Math.min(200, 1 + Math.floor(account.xp / 250)));
    return account;
}

function attachAuthenticatedPlayer(socket, account, token = null, resumed = false) {
    account = ensureAccountShape(account);
    const player = connectedPlayers[socket.id];
    if (!player || !account) return;

    const profile = profileFor(account.username);
    player.username = account.username;
    player.email = account.email;
    player.accountEmail = account.email;
    player.isGuest = false;
    player.isAuthenticated = true;
    player.isOnline = profile.isOnline !== false;
    player.avatar = profile.avatar || '';
    player.friends = new Set(profile.friends || []);
    player.friendRequests = new Set(profile.requests || []);
    player.roles = publicRoles(account.roles);
    player.level = account.level;
    player.rating1v1 = account.rating1v1;
    player.ratingFFA = account.ratingFFA;
    player.sessionTokenHash = token ? hashSessionToken(token) : null;

    account.lastLoginAt = Date.now();

    for (const room of activeRoomsMap.values()) {
        const member = room.players.find(p => p.id === socket.id);
        if (!member) continue;
        member.name = account.username;
        member.isGuest = false;
        member.avatar = player.avatar || '';
        member.roles = publicRoles(account.roles);
        member.level = account.level;
        if (room.hostSocketId === socket.id) room.hostName = account.username;
        io.to(room.roomId).emit('saved_room_update', room);
    }

    socket.emit('saved_friends', { friends: profile.friends || [], requests: profile.requests || [], archivedDMs: profile.archivedDMs || [] });
    socket.emit('friend_requests_update', Array.from(player.friendRequests));
    socket.emit('saved_profile', { avatar: player.avatar || '' });
    socket.emit('saved_settings', { ...profile.settings });
    socket.emit('auth_success', {
        token,
        resumed,
        user: publicAccountState(account),
        badges: roleBadges(account.roles)
    });
    socket.emit('session_mode', { username: account.username, isGuest: false, savesStats: true });
    saveHistory();
    broadcastOnlineUsers();
    broadcastPublicRooms();
}

function attachGuestPlayer(socket, requestedUsername) {
    const player = connectedPlayers[socket.id];
    if (!player) return;
    let username = sanitizeUsername(requestedUsername || randomGuestName());
    if (isReservedOwnerName(username) || accountByUsername(username)) {
        const requested = username;
        username = randomGuestName();
        socket.emit('username_reserved', { message: isReservedOwnerName(requested) ? 'PRIME is reserved for the site owner.' : 'That username belongs to a saved account. Guests cannot impersonate saved accounts.' });
    }
    player.username = username;
    player.email = null;
    player.accountEmail = null;
    player.isGuest = true;
    player.isAuthenticated = false;
    player.isOnline = true;
    player.avatar = '';
    player.friends = new Set();
    player.friendRequests = new Set();
    player.roles = defaultRoles();
    player.level = 1;
    player.rating1v1 = 1000;
    player.ratingFFA = 1000;
    socket.emit('saved_friends', { friends: [], requests: [] });