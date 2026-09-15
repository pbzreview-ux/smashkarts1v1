const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
        '\n;(' + installV12Platform.toString() + ')();'
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
const connectedPlayers = {};
const activeRoomsMap = new Map();
const automaticDataDirectory = fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data');
const dataDirectory = path.resolve(process.env.SMASH_DATA_DIR || automaticDataDirectory);
fs.mkdirSync(dataDirectory, { recursive: true });
console.log(`[DATA] Using ${dataDirectory}${dataDirectory === path.resolve(path.join(__dirname, 'data')) ? ' (attach persistent storage before relying on deploy-to-deploy retention)' : ' (persistent path)'}`);
const dataFile = path.join(dataDirectory, 'history.json');

const saved = fs.existsSync(dataFile)
    ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    : { profiles: {}, stats: {}, directMessages: {}, matches: {}, accounts: {}, sessions: {}, groups: {}, tournaments: {}, reports: [], auditLog: [] };

saved.profiles ||= {};
saved.stats ||= {};
saved.directMessages ||= {};
saved.matches ||= {};
saved.accounts ||= {};
saved.sessions ||= {};
saved.groups ||= {};
saved.tournaments ||= {};
if (!Array.isArray(saved.reports)) saved.reports = [];
if (!Array.isArray(saved.auditLog)) saved.auditLog = [];

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

function saveHistory() {
    const temp = dataFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({
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
    }), { mode: 0o600 });
    fs.renameSync(temp, dataFile);
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
            isOnline: true,
            avatar: '',
            settings: defaultSavedSettings(),
            createdAt: Date.now()
        };
    }
    profiles[username].friends ||= [];
    profiles[username].requests ||= [];
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
            requests: profile.requests || []
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

function getDMKey(a, b) {
    return JSON.stringify([a, b].sort());
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
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days, refreshed whenever the account resumes

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

for (const account of Object.values(accounts)) ensureAccountShape(account);

function accountByEmail(email) {
    return ensureAccountShape(accounts[normalizeEmail(email)] || null);
}

function accountByUsername(username) {
    const key = normalizeUsernameKey(username);
    return Object.values(accounts).map(ensureAccountShape).find(account => normalizeUsernameKey(account.username) === key) || null;
}

function publicRoles(roles) {
    return normalizeRoles(roles);
}

function publicAccountState(account) {
    account = ensureAccountShape(account);
    if (!account) return null;
    return {
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

    socket.emit('saved_friends', { friends: profile.friends || [], requests: profile.requests || [] });
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
    socket.emit('saved_profile', { avatar: '' });
    socket.emit('session_mode', { username, isGuest: true, savesStats: false });
    broadcastOnlineUsers();
}

function canModerateTarget(actor, targetAccount) {
    if (!actor || !targetAccount) return false;
    if (targetAccount.roles?.owner) return false;
    if (actor.roles?.owner) return true;
    if (actor.roles?.moderator && !targetAccount.roles?.moderator) return true;
    return false;
}

function renameUserEverywhere(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;

    if (profiles[oldName]) {
        profiles[newName] = profiles[oldName];
        delete profiles[oldName];
    }
    if (Object.prototype.hasOwnProperty.call(playerStats, oldName)) {
        playerStats[newName] = playerStats[oldName];
        delete playerStats[oldName];
    }

    for (const profile of Object.values(profiles)) {
        profile.friends = (profile.friends || []).map(name => normalizeUsernameKey(name) === normalizeUsernameKey(oldName) ? newName : name);
        profile.requests = (profile.requests || []).map(name => normalizeUsernameKey(name) === normalizeUsernameKey(oldName) ? newName : name);
    }

    const rebuiltDMs = {};
    for (const [key, messages] of Object.entries(directMessageStore)) {
        let names;
        try { names = JSON.parse(key); } catch { names = []; }
        if (Array.isArray(names) && names.length === 2) {
            names = names.map(name => normalizeUsernameKey(name) === normalizeUsernameKey(oldName) ? newName : name);
            const newKey = getDMKey(names[0], names[1]);
            rebuiltDMs[newKey] = (rebuiltDMs[newKey] || []).concat(messages.map(message => ({
                ...message,
                senderUsername: normalizeUsernameKey(message.senderUsername) === normalizeUsernameKey(oldName) ? newName : message.senderUsername
            })));
        } else {
            rebuiltDMs[key] = messages;
        }
    }
    for (const key of Object.keys(directMessageStore)) delete directMessageStore[key];
    Object.assign(directMessageStore, rebuiltDMs);

    for (const group of Object.values(groupStore)) {
        if (group.owner === oldName) group.owner = newName;
        group.admins = (group.admins || []).map(name => name === oldName ? newName : name);
        group.members = (group.members || []).map(name => name === oldName ? newName : name);
        for (const message of group.messages || []) {
            if (message.senderUsername === oldName) message.senderUsername = newName;
        }
    }

    for (const tournament of Object.values(tournamentStore)) {
        if (tournament.hostUsername === oldName) tournament.hostUsername = newName;
        tournament.participants = (tournament.participants || []).map(name => name === oldName ? newName : name);
        tournament.invited = (tournament.invited || []).map(name => name === oldName ? newName : name);
    }

    for (const room of activeRoomsMap.values()) {
        if (room.hostName === oldName) room.hostName = newName;
        for (const member of room.players || []) {
            if (member.name === oldName) member.name = newName;
        }
    }
}

function safeDurationMs(raw, fallbackMs = 60 * 60 * 1000) {
    if (raw === 'permanent') return -1;
    const numeric = Number(raw);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallbackMs;
}

function tournamentVisibleTo(tournament, player) {
    if (!tournament || !player) return false;
    if (tournament.isPublic) return true;
    if (player.roles?.owner || player.roles?.moderator) return true;
    if (tournament.hostUsername === player.username) return true;
    return (tournament.invited || []).includes(player.username) || (tournament.participants || []).includes(player.username);
}

function tournamentListFor(player) {
    return Object.values(tournamentStore)
        .filter(t => tournamentVisibleTo(t, player))
        .sort((a, b) => (a.startAt || 0) - (b.startAt || 0));
}

function groupVisibleTo(group, player) {
    return !!group && !!player && !player.isGuest && (group.members || []).includes(player.username);
}

function groupSummary(group) {
    return {
        id: group.id,
        name: group.name,
        owner: group.owner,
        admins: group.admins || [],
        members: group.members || [],
        createdAt: group.createdAt,
        updatedAt: group.updatedAt || group.createdAt,
        lastMessage: (group.messages || []).slice(-1)[0] || null
    };
}

function reportsForModerators() {
    return reportStore.slice().sort((a, b) => b.timestamp - a.timestamp);
}

function broadcastTournamentLists() {
    for (const player of Object.values(connectedPlayers)) {
        const socket = io.sockets.sockets.get(player.id);
        if (!socket) continue;
        socket.emit('tournament_list', {
            tournaments: tournamentListFor(player),
            canCreate: canHostTournament(player),
            roles: publicRoles(player.roles)
        });
    }
}

// =========================================================
// SOCKET SERVER
// =========================================================
io.on('connection', socket => {
    connectedPlayers[socket.id] = {
        id: socket.id,
        username: randomGuestName(),
        email: null,
        isAuthenticated: false,
        isGuest: true,
        isOnline: true,
        avatar: '',
        roles: defaultRoles(),
        level: 1,
        rating1v1: 1000,
        ratingFFA: 1000,
        accountEmail: null,
        friends: new Set(),
        friendRequests: new Set()
    };

    socket.on('set_user_session', userData => {
        // V12: this legacy event is GUEST-ONLY. If an older client claims it
        // is a saved account, ignore the claim and wait for account_resume.
        if (userData && userData.isGuest === false) return;
        const requestedName = userData && userData.username ? userData.username : randomGuestName();
        attachGuestPlayer(socket, requestedName);
    });

    socket.on('account_register', payload => {
        const username = String(payload?.username || '').trim();
        const email = normalizeEmail(payload?.email);
        const password = String(payload?.password || '');
        const ownerSetupKey = String(payload?.ownerSetupKey || '');

        if (!validUsername(username)) {
            return socket.emit('auth_error', { message: 'Username must be 3-20 characters using only letters, numbers, or underscore.' });
        }
        if (!/^\S+@\S+\.\S+$/.test(email)) {
            return socket.emit('auth_error', { message: 'Enter a valid email address.' });
        }
        if (password.length < 6) {
            return socket.emit('auth_error', { message: 'Password must be at least 6 characters.' });
        }
        if (accountByEmail(email)) {
            return socket.emit('auth_error', { message: 'That email already has an account. Log in instead.' });
        }
        if (accountByUsername(username)) {
            return socket.emit('auth_error', { message: 'That username is already taken.' });
        }

        const wantsPrime = isReservedOwnerName(username);
        const isOwnerEmail = !!OWNER_EMAIL && email === OWNER_EMAIL;

        if (wantsPrime && !isOwnerEmail) {
            return socket.emit('auth_error', { message: 'PRIME is reserved exclusively for the site owner.' });
        }
        if (isOwnerEmail && !wantsPrime) {
            return socket.emit('auth_error', { message: 'The configured owner account must use the username PRIME.' });
        }
        if (wantsPrime) {
            if (!OWNER_EMAIL || !OWNER_SETUP_KEY) {
                return socket.emit('auth_error', { message: 'Owner setup is not configured on the server yet.' });
            }
            const a = Buffer.from(ownerSetupKey);
            const b = Buffer.from(OWNER_SETUP_KEY);
            if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
                return socket.emit('auth_error', { message: 'Wrong owner setup key. PRIME was not created.' });
            }
        }

        const salt = crypto.randomBytes(16).toString('hex');
        const account = ensureAccountShape({
            email,
            username: wantsPrime ? RESERVED_OWNER_USERNAME : username,
            passwordSalt: salt,
            passwordHash: passwordHash(password, salt),
            roles: wantsPrime ? { owner: true, moderator: false, streamer: false, tourneyHost: false } : defaultRoles(),
            xp: 0,
            level: 1,
            rating1v1: 1000,
            ratingFFA: 1000,
            warnings: 0,
            mutedUntil: null,
            bannedUntil: null,
            banReason: '',
            streamerLive: false,
            createdAt: Date.now(),
            lastLoginAt: Date.now()
        });

        accounts[email] = account;
        profileFor(account.username);
        const token = issueSessionToken(email);
        logAudit({ username: account.username }, wantsPrime ? 'OWNER_ACCOUNT_CREATED' : 'ACCOUNT_CREATED', account.username, email);
        attachAuthenticatedPlayer(socket, account, token, false);
    });

    socket.on('account_login', payload => {
        const email = normalizeEmail(payload?.email);
        const password = String(payload?.password || '');
        const account = accountByEmail(email);
        if (!account || !passwordMatches(account, password)) {
            return socket.emit('auth_error', { message: 'Incorrect email or password.' });
        }
        if (banIsActive(account)) {
            const expires = account.bannedUntil === -1 ? 'Permanent' : new Date(account.bannedUntil).toLocaleString();
            return socket.emit('auth_error', { message: `This account is banned. ${account.banReason || 'No reason given.'} (${expires})` });
        }
        const token = issueSessionToken(email);
        attachAuthenticatedPlayer(socket, account, token, false);
    });

    socket.on('account_resume', ({ token }) => {
        const found = accountFromToken(token);
        if (!found) {
            return socket.emit('auth_session_invalid', { message: 'Your saved login expired. You can keep playing as a guest or log in again.' });
        }
        if (banIsActive(found.account)) {
            return socket.emit('auth_session_invalid', { message: `This account is banned. ${found.account.banReason || ''}` });
        }
        attachAuthenticatedPlayer(socket, found.account, token, true);
    });

    socket.on('account_logout', ({ token }) => {
        revokeSessionToken(token);
        attachGuestPlayer(socket, randomGuestName());
    });

    socket.on('account_rename', ({ newUsername }) => {
        const player = connectedPlayers[socket.id];
        if (!player || player.isGuest) return socket.emit('account_required', { message: 'Log in to rename a saved account.' });
        const account = accountByEmail(player.accountEmail);
        if (!account) return;
        const next = String(newUsername || '').trim();
        if (!validUsername(next)) return socket.emit('account_rename_error', { message: 'Username must be 3-20 letters, numbers, or underscore.' });
        if (account.roles.owner && !isReservedOwnerName(next)) {
            return socket.emit('account_rename_error', { message: 'The OWNER account is permanently named PRIME.' });
        }
        if (!account.roles.owner && isReservedOwnerName(next)) {
            return socket.emit('account_rename_error', { message: 'PRIME is reserved for the OWNER.' });
        }
        const collision = accountByUsername(next);
        if (collision && collision.email !== account.email) {
            return socket.emit('account_rename_error', { message: 'That username is already taken.' });
        }
        const old = account.username;
        if (old === next) return;
        renameUserEverywhere(old, next);
        account.username = next;
        player.username = next;
        logAudit(player, 'USERNAME_CHANGED', next, `${old} -> ${next}`);
        saveHistory();
        socket.emit('account_renamed', { username: next, user: publicAccountState(account) });
        broadcastOnlineUsers();
        broadcastPublicRooms();
    });

    socket.on('update_saved_settings', patch => {
        const player = connectedPlayers[socket.id];
        if (!player || player.isGuest) return;
        const profile = profileFor(player.username);
        const current = normalizeSavedSettings(profile.settings);
        const next = { ...current };

        if (patch && Object.prototype.hasOwnProperty.call(patch, 'gameplayMode')) {
            next.gameplayMode = patch.gameplayMode === 'embed' ? 'embed' : 'popup';
        }
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'queueType')) {
            next.queueType = patch.queueType === 'ranked' ? 'ranked' : 'casual';
        }
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'streamerHideCode')) {
            next.streamerHideCode = !!patch.streamerHideCode;
        }
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'streamerSafeNotifications')) {
            next.streamerSafeNotifications = !!patch.streamerSafeNotifications;
        }

        profile.settings = normalizeSavedSettings(next);
        saveHistory();
        socket.emit('saved_settings', { ...profile.settings });
    });

    socket.on('toggle_online_status', isOnline => {
        const player = connectedPlayers[socket.id];
        if (!player) return;
        player.isOnline = !!isOnline;
        savePlayer(player);
        if (!player.isGuest) saveHistory();
        broadcastOnlineUsers();
    });

    // ---------------- PROFILE PICTURE (ACCOUNT ONLY) ----------------
    socket.on('update_profile_picture', ({ dataUrl }) => {
        const player = connectedPlayers[socket.id];
        if (!player || player.isGuest) {
            return socket.emit('account_required', {
                message: 'Log in to save a profile picture.'
            });
        }

        const value = typeof dataUrl === 'string' ? dataUrl : '';
        if (value) {
            const valid = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
            if (!valid || value.length > 450000) {
                return socket.emit('profile_picture_error', {
                    message: 'Use a JPG, PNG, or WebP image under 8 MB.'
                });
            }
        }

        const profile = profileFor(player.username);
        profile.avatar = value;
        player.avatar = value;

        for (const room of activeRoomsMap.values()) {
            const member = room.players.find(p => p.id === socket.id);
            if (!member) continue;
            member.avatar = value;
            io.to(room.roomId).emit('saved_room_update', room);
        }

        saveHistory();
        socket.emit('profile_picture_updated', { avatar: value });
        broadcastOnlineUsers();
    });

    // ---------------- FRIENDS (ACCOUNT ONLY) ----------------
    socket.on('send_friend_request', ({ targetSocketId }) => {
        const sender = connectedPlayers[socket.id];
        const target = connectedPlayers[targetSocketId];
        if (!sender || !target) return;
        if (sender.isGuest || target.isGuest) {
            return socket.emit('account_required', {
                message: 'Log in to use friends and direct messages.'
            });
        }
        if (sender.username === target.username || usersAreFriends(sender.username, target.username)) return;

        target.friendRequests.add(sender.username);
        savePlayer(target);
        saveHistory();
        syncFriends(target.username);

        io.to(targetSocketId).emit('receive_friend_request', {
            fromSocketId: socket.id,
            fromUsername: sender.username
        });
        io.to(targetSocketId).emit('friend_requests_update', Array.from(target.friendRequests));
    });

    socket.on('decline_friend_request', ({ challengerUsername }) => {
        const user = connectedPlayers[socket.id];
        if (!user || user.isGuest) return;
        user.friendRequests.delete(challengerUsername);
        savePlayer(user);
        saveHistory();
        syncFriends(user.username);
        socket.emit('friend_requests_update', Array.from(user.friendRequests));
    });

    socket.on('accept_friend_request', ({ challengerUsername }) => {
        const user = connectedPlayers[socket.id];
        if (!user || user.isGuest || !user.friendRequests.has(challengerUsername)) return;

        user.friends.add(challengerUsername);
        user.friendRequests.delete(challengerUsername);

        savePlayer(user);
        ensureMutualFriendship(user.username, challengerUsername);
        saveHistory();

        const challenger = findSocketByUsername(challengerUsername);
        if (challenger) {
            challenger.friends.add(user.username);
            io.to(challenger.id).emit('friend_request_accepted', { username: user.username });
        }

        socket.emit('friend_requests_update', Array.from(user.friendRequests));
        socket.emit('friend_request_accepted', { username: challengerUsername });
        broadcastOnlineUsers();
    });

    // ---------------- DIRECT MESSAGES (ACCOUNT ONLY) ----------------
    socket.on('send_direct_message', ({ targetUsername, message }) => {
        const sender = connectedPlayers[socket.id];
        if (!sender || sender.isGuest || !message || !message.trim()) {
            if (sender && sender.isGuest) {
                socket.emit('account_required', { message: 'Log in to save and use direct messages.' });
            }
            return;
        }

        const senderAccount = accountByUsername(sender.username);
        if (muteIsActive(senderAccount)) {
            return socket.emit('dm_error', { message: 'You are currently muted.' });
        }

        const targetName = sanitizeUsername(targetUsername);
        if (!usersAreFriends(sender.username, targetName)) {
            return socket.emit('dm_error', { message: 'You can only message users on your friends list.' });
        }

        const key = getDMKey(sender.username, targetName);
        directMessageStore[key] ||= [];
        const msg = {
            id: crypto.randomUUID(),
            senderUsername: sender.username,
            message: moderateText(message.trim()),
            timestamp: Date.now(),
            editedAt: null
        };
        directMessageStore[key].push(msg);
        saveHistory();

        const target = findSocketByUsername(targetName);
        if (target) {
            io.to(target.id).emit('receive_direct_message', {
                senderSocketId: socket.id,
                senderUsername: sender.username,
                message: msg.message,
                history: directMessageStore[key]
            });
        }

        socket.emit('dm_sent_success', {
            targetUsername: targetName,
            history: directMessageStore[key]
        });
    });

    socket.on('get_dm_history', ({ targetUsername }) => {
        const sender = connectedPlayers[socket.id];
        if (!sender || sender.isGuest) return;
        const targetName = sanitizeUsername(targetUsername);
        if (!usersAreFriends(sender.username, targetName)) {
            return socket.emit('dm_error', { message: 'You can only message users on your friends list.' });
        }
        const key = getDMKey(sender.username, targetName);
        socket.emit('load_dm_history', {
            targetUsername: targetName,
            history: directMessageStore[key] || []
        });
    });

    // ---------------- STATS ----------------
    socket.on('record_match_played', () => {
        const player = connectedPlayers[socket.id];
        if (!player || player.isGuest) {
            socket.emit('guest_match_recorded', { saved: false });
            return;
        }
        playerStats[player.username] = (playerStats[player.username] || 0) + 1;
        const account = accountByUsername(player.username);
        if (account) {
            account.xp += 25;
            syncAccountProgress(account);
            player.level = account.level;
        }
        saveHistory();
        broadcastLeaderboard();
        broadcastOnlineUsers();
        socket.emit('account_match_recorded', {
            saved: true,
            matches: playerStats[player.username],
            level: account?.level || 1,
            xp: account?.xp || 0
        });
    });

    // ---------------- FRIEND CHALLENGES ----------------
    socket.on('send_match_challenge', ({ targetSocketId, targetUsername, fromUsername, mode, smashUrl }) => {
        const sender = connectedPlayers[socket.id];
        const target = targetSocketId ? connectedPlayers[targetSocketId] : findSocketByUsername(targetUsername);
        if (!sender || !target) return;
        if (sender.isGuest) {
            return socket.emit('account_required', { message: 'Log in to challenge friends directly.' });
        }
        if (!usersAreFriends(sender.username, target.username)) return;

        const cleanUrl = extractSmashUrl(smashUrl);
        if (!cleanUrl) return socket.emit('room_error', { message: 'A valid Smash Karts room link or code is required.' });

        io.to(target.id).emit('receive_match_challenge', {
            challengerSocketId: socket.id,
            fromUsername: sanitizeUsername(fromUsername || sender.username),
            mode: mode || '1v1',
            smashUrl: cleanUrl
        });
    });

    socket.on('accept_match_challenge', ({ challengerSocketId, targetUsername, smashUrl }) => {
        const cleanUrl = extractSmashUrl(smashUrl);
        const challenger = connectedPlayers[challengerSocketId];
        const player = connectedPlayers[socket.id];
        if (!cleanUrl || !challenger || !player) {
            return socket.emit('room_error', { message: 'That challenge is no longer valid.' });
        }

        const challengerSocket = io.sockets.sockets.get(challengerSocketId);
        leaveAllRoomsExcept(socket);
        if (challengerSocket) leaveAllRoomsExcept(challengerSocket);

        const roomId = crypto.randomUUID();
        const room = {
            roomId,
            hostName: challenger.username,
            hostSocketId: challengerSocketId,
            smashUrl: cleanUrl,
            winCondition: 'First to 3',
            mode: '1v1',
            maxPlayers: 2,
            isPublic: false,
            createdAt: Date.now(),
            players: [
                { id: challengerSocketId, name: challenger.username, isGuest: challenger.isGuest, avatar: challenger.avatar || '', roles: publicRoles(challenger.roles), level: challenger.level || 1, ready: false, team: null, joinedAt: Date.now() },
                { id: socket.id, name: sanitizeUsername(targetUsername || player.username), isGuest: player.isGuest, avatar: player.avatar || '', roles: publicRoles(player.roles), level: player.level || 1, ready: false, team: null, joinedAt: Date.now() }
            ],
            messages: []
        };

        activeRoomsMap.set(roomId, room);
        addRoomHistory(room);
        addParticipantToHistory(room, challenger);
        addParticipantToHistory(room, player);
        saveHistory();

        socket.join(roomId);
        if (challengerSocket) challengerSocket.join(roomId);
        io.to(roomId).emit('challenge_game_start', room);
    });

    // ---------------- NORMAL 1V1 ----------------
    socket.on('create_room', data => {
        const player = connectedPlayers[socket.id];
        if (!player) return;
        const cleanUrl = extractSmashUrl(data && data.smashUrl);
        if (!cleanUrl) {
            return socket.emit('room_error', { message: 'A valid Smash Karts room link or code is required.' });
        }

        leaveAllRoomsExcept(socket);
        const mode = '1v1';
        const roomId = crypto.randomUUID();
        const room = {
            roomId,
            hostName: player.username,
            hostSocketId: socket.id,
            smashUrl: cleanUrl,
            winCondition: escapeHTML(data.winCondition || 'First to 3'),
            mode,
            queueType: data?.queueType === 'ranked' ? 'ranked' : 'casual',
            maxPlayers: 2,
            isPublic: data.isPublic !== false,
            createdAt: Date.now(),
            players: [],
            messages: []
        };

        activeRoomsMap.set(roomId, room);
        addRoomHistory(room);
        joinRoom(socket, room, player, 'room_created');
    });

    // ---------------- FFA ----------------
    socket.on('play_ffa', options => {
        const player = connectedPlayers[socket.id];
        if (!player) return;
        const wantedQueue = options?.queueType === 'ranked' ? 'ranked' : 'casual';
        const room = Array.from(activeRoomsMap.values()).find(
            r => r.mode === 'ffa' && r.isPublic !== false && r.players.length < r.maxPlayers && (r.queueType || 'casual') === wantedQueue
        );
        if (!room) {
            return socket.emit('ffa_no_lobby', {
                message: 'No FFA lobby is open yet. Click CREATE LOBBY to make one.'
            });
        }
        joinRoom(socket, room, player, 'ffa_lobby_ready');
    });

    socket.on('create_ffa_lobby', options => {
        const player = connectedPlayers[socket.id];
        if (!player) return;
        leaveAllRoomsExcept(socket);

        const requestedPlayers = Number(options && options.maxPlayers) || 12;
        const maxPlayers = requestedPlayers === 24 ? 24 : 12;
        const roomId = crypto.randomUUID();
        const room = {
            roomId,
            hostName: player.username,
            hostSocketId: socket.id,
            smashUrl: 'https://smashkarts.io',
            winCondition: 'Free for all',
            mode: 'ffa',
            queueType: options?.queueType === 'ranked' ? 'ranked' : 'casual',
            maxPlayers,
            isPublic: !(options && options.isPublic === false),
            createdAt: Date.now(),
            players: [],
            messages: []
        };

        activeRoomsMap.set(roomId, room);
        addRoomHistory(room);
        joinRoom(socket, room, player, 'ffa_lobby_ready');
    });

    socket.on('get_public_rooms', broadcastPublicRooms);

    socket.on('join_public_room', ({ roomId }) => {
        const player = connectedPlayers[socket.id];
        const room = activeRoomsMap.get(roomId);
        if (!player || !room || room.isPublic === false) {
            return socket.emit('room_error', { message: 'That lobby is no longer available.' });
        }
        joinRoom(socket, room, player, room.mode === 'ffa' ? 'ffa_lobby_ready' : 'room_created');
    });

    socket.on('rejoin_room', ({ roomId }) => {
        const player = connectedPlayers[socket.id];
        const room = activeRoomsMap.get(roomId);
        if (!player || !room) {
            return socket.emit('room_error', { message: 'That lobby no longer exists.' });
        }
        joinRoom(socket, room, player, room.mode === 'ffa' ? 'ffa_lobby_ready' : 'room_created');
    });

    socket.on('get_room_snapshot', ({ roomId }) => {
        const room = activeRoomsMap.get(roomId);
        if (!room) return socket.emit('room_snapshot', null);
        socket.emit('room_snapshot', room);
    });

    socket.on('leave_match', ({ roomId }) => leaveLiveRoom(socket, roomId));

    // ---------------- LOBBY POWER FEATURES ----------------
    socket.on('set_ready_status', ({ roomId, ready }) => {
        const room = activeRoomsMap.get(roomId);
        if (!room) return;
        const member = room.players.find(p => p.id === socket.id);
        if (!member) return;
        member.ready = !!ready;
        io.to(roomId).emit('saved_room_update', room);
        const allReady = room.players.length > 1 && room.players.every(p => p.ready);
        io.to(roomId).emit('ready_state_changed', {
            roomId,
            readyCount: room.players.filter(p => p.ready).length,
            total: room.players.length,
            allReady
        });
    });

    socket.on('set_lobby_team', () => {
        // 2v2 was removed. Kept only so an old cached client cannot crash the server.
    });

    socket.on('toggle_room_privacy', ({ roomId, isPublic }) => {
        const room = activeRoomsMap.get(roomId);
        if (!room || room.hostSocketId !== socket.id) return;
        room.isPublic = !!isPublic;
        io.to(roomId).emit('saved_room_update', room);
        broadcastPublicRooms();
    });

    socket.on('kick_lobby_player', ({ roomId, targetSocketId }) => {
        const room = activeRoomsMap.get(roomId);
        if (!room || room.hostSocketId !== socket.id || targetSocketId === socket.id) return;
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (!targetSocket) return;
        io.to(targetSocketId).emit('kicked_from_lobby', { roomId, by: room.hostName });
        leaveLiveRoom(targetSocket, roomId, 'kicked');
    });

    socket.on('lobby_reaction', ({ roomId, reaction }) => {
        const room = activeRoomsMap.get(roomId);
        const player = connectedPlayers[socket.id];
        if (!room || !player || !room.players.some(p => p.id === socket.id)) return;
        const safe = String(reaction || '').slice(0, 8);
        if (!safe) return;
        io.to(roomId).emit('lobby_reaction', {
            roomId,
            from: player.username,
            reaction: safe,
            timestamp: Date.now()
        });
    });

    socket.on('lobby_announcement', ({ roomId, message }) => {
        const room = activeRoomsMap.get(roomId);
        if (!room || room.hostSocketId !== socket.id) return;
        const safe = moderateText(message).slice(0, 180);
        if (!safe) return;
        io.to(roomId).emit('lobby_system_message', {
            roomId,
            message: `HOST: ${safe}`,
            timestamp: Date.now()
        });
    });

    // ---------------- PASTE / UPDATE SMASH CODE ----------------
    socket.on('update_lobby_game_code', ({ roomId, code }) => {
        const player = connectedPlayers[socket.id];
        const room = activeRoomsMap.get(roomId);
        if (!player || !room || !room.players.some(p => p.id === socket.id)) {
            return socket.emit('room_error', { message: 'You are not inside that lobby.' });
        }

        const cleanUrl = extractVerifiedLookingRoomUrl(code);
        if (!cleanUrl) {
            return socket.emit('room_error', {
                message: 'That does not look like a valid Smash Karts room code. Nothing changed.'
            });
        }

        room.smashUrl = cleanUrl;
        room.gameCodeUpdatedBy = player.username;
        room.gameCodeUpdatedAt = Date.now();

        if (matchHistory[roomId]) {
            matchHistory[roomId].smashUrl = cleanUrl;
            matchHistory[roomId].gameCodeUpdatedBy = player.username;
            matchHistory[roomId].gameCodeUpdatedAt = room.gameCodeUpdatedAt;
        }

        saveHistory();
        io.to(roomId).emit('saved_room_update', room);
        io.to(roomId).emit('lobby_game_code_updated', {
            roomId,
            smashUrl: cleanUrl,
            updatedBy: player.username
        });
    });

    // ---------------- LOBBY CHAT ----------------
    socket.on('send_match_chat', ({ roomId, message }) => {
        const room = activeRoomsMap.get(roomId);
        const player = connectedPlayers[socket.id];
        if (!room || !player || !socket.rooms.has(roomId)) return;
        if (!player.isGuest && muteIsActive(accountByUsername(player.username))) {
            return socket.emit('room_error', { message: 'You are currently muted.' });
        }
        if (typeof message !== 'string' || !message.trim()) return;

        const msg = {
            roomId,
            senderName: player.username,
            message: moderateText(message.trim()),
            timestamp: Date.now(),
            isGuest: player.isGuest
        };

        room.messages.push(msg);
        if (room.messages.length > 200) room.messages.shift();

        if (matchHistory[roomId]) {
            matchHistory[roomId].messages = room.messages;
        }
        saveHistory();
        io.to(roomId).emit('receive_match_chat', msg);
    });

    // ---------------- HISTORY ----------------
    socket.on('get_saved_match_history', () => {
        const player = connectedPlayers[socket.id];
        if (!player || player.isGuest) {
            socket.emit('saved_match_history', []);
            return socket.emit('account_required', {
                message: 'Log in to save and view match history.'
            });
        }

        socket.emit(
            'saved_match_history',
            Object.values(matchHistory)
                .filter(room => Array.isArray(room.participants) && room.participants.includes(player.username))
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        );
    });

    socket.on('restore_legacy_friends', ({ friends }) => {
        const player = connectedPlayers[socket.id];
        if (!player || player.isGuest || !Array.isArray(friends)) return;

        // Migrate friendships accepted in older browser-only builds into the
        // server profiles. This prevents the false "you have to be friends"
        // error when both players already show as friends in the UI.
        for (const name of friends.slice(0, 250)) {
            if (typeof name !== 'string') continue;
            const targetName = sanitizeUsername(name);
            if (!targetName || targetName === player.username) continue;
            ensureMutualFriendship(player.username, targetName);
        }

        savePlayer(player);
        saveHistory();
        syncFriends(player.username);
        broadcastOnlineUsers();
    });


    // ---------------- V12 PUBLIC PROFILES ----------------
    socket.on('get_public_profile', ({ username }) => {
        const viewer = connectedPlayers[socket.id];
        const profile = publicProfileState(username, viewer);
        socket.emit('public_profile', profile || null);
    });

    // ---------------- V12 DIRECT MESSAGE EDIT / DELETE / REPORT ----------------
    socket.on('edit_direct_message', ({ targetUsername, messageId, message }) => {
        const sender = connectedPlayers[socket.id];
        if (!sender || sender.isGuest || !messageId || typeof message !== 'string' || !message.trim()) return;
        const targetName = sanitizeUsername(targetUsername);
        if (!usersAreFriends(sender.username, targetName)) return;
        const key = getDMKey(sender.username, targetName);
        const history = directMessageStore[key] || [];
        const item = history.find(entry => entry.id === messageId && entry.senderUsername === sender.username);
        if (!item) return;
        item.message = moderateText(message.trim());
        item.editedAt = Date.now();
        saveHistory();
        const payload = { targetUsername: targetName, history };
        socket.emit('dm_history_updated', payload);
        const target = findSocketByUsername(targetName);
        if (target) io.to(target.id).emit('dm_history_updated', { targetUsername: sender.username, history });
    });

    socket.on('delete_direct_message', ({ targetUsername, messageId }) => {
        const sender = connectedPlayers[socket.id];
        if (!sender || sender.isGuest || !messageId) return;
        const targetName = sanitizeUsername(targetUsername);
        const key = getDMKey(sender.username, targetName);
        const history = directMessageStore[key] || [];
        const index = history.findIndex(entry => entry.id === messageId && entry.senderUsername === sender.username);
        if (index < 0) return;
        history.splice(index, 1);
        saveHistory();
        socket.emit('dm_history_updated', { targetUsername: targetName, history });
        const target = findSocketByUsername(targetName);
        if (target) io.to(target.id).emit('dm_history_updated', { targetUsername: sender.username, history });
    });

    socket.on('report_message', ({ type, targetUsername, groupId, messageId, reason }) => {
        const reporter = connectedPlayers[socket.id];
        if (!reporter || reporter.isGuest || !messageId) return;
        let source = [];
        let context = [];
        let reported = null;
        let location = '';

        if (type === 'group') {
            const group = groupStore[groupId];
            if (!groupVisibleTo(group, reporter)) return;
            source = group.messages || [];
            location = `Group: ${group.name}`;
        } else {
            const targetName = sanitizeUsername(targetUsername);
            if (!usersAreFriends(reporter.username, targetName)) return;
            source = directMessageStore[getDMKey(reporter.username, targetName)] || [];
            location = `DM with ${targetName}`;
        }

        const index = source.findIndex(entry => entry.id === messageId);
        if (index < 0) return;
        reported = source[index];
        context = source.slice(Math.max(0, index - 2), Math.min(source.length, index + 3)).map(entry => ({
            id: entry.id,
            senderUsername: entry.senderUsername,
            message: entry.message,
            timestamp: entry.timestamp
        }));

        const report = {
            id: crypto.randomUUID(),
            reporter: reporter.username,
            reportedUser: reported.senderUsername,
            messageId,
            reason: String(reason || 'No reason given').slice(0, 300),
            location,
            context,
            status: 'open',
            timestamp: Date.now()
        };
        reportStore.push(report);
        saveHistory();
        socket.emit('report_submitted', { id: report.id });
        for (const mod of Object.values(connectedPlayers)) {
            if (isModeratorPlayer(mod)) io.to(mod.id).emit('moderation_report_received', report);
        }
    });

    // ---------------- V12 GROUP CHATS ----------------
    socket.on('get_groups', () => {
        const player = connectedPlayers[socket.id];
        if (!player || player.isGuest) return socket.emit('group_list', []);
        socket.emit('group_list', Object.values(groupStore).filter(group => groupVisibleTo(group, player)).map(groupSummary));
    });

    socket.on('create_group', ({ name, members }) => {
        const player = connectedPlayers[socket.id];
        if (!player || player.isGuest) return socket.emit('account_required', { message: 'Log in to create a group.' });
        const cleanName = String(name || '').trim().slice(0, 40);
        if (cleanName.length < 2) return socket.emit('group_error', { message: 'Give the group a name.' });
        const requested = Array.isArray(members) ? members : [];
        const unique = [];
        for (const raw of requested) {
            const username = sanitizeUsername(raw);
            if (username === player.username || unique.includes(username)) continue;
            if (!usersAreFriends(player.username, username)) continue;
            if (!accountByUsername(username)) continue;
            unique.push(username);
            if (unique.length >= 49) break;
        }
        const group = {
            id: crypto.randomUUID(),
            name: cleanName,
            owner: player.username,
            admins: [],
            members: [player.username, ...unique],
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        groupStore[group.id] = group;
        saveHistory();
        socket.emit('group_created', groupSummary(group));
        for (const memberName of group.members) {
            const member = findSocketByUsername(memberName);
            if (member) io.to(member.id).emit('group_list_changed');
        }
    });

    socket.on('open_group', ({ groupId }) => {
        const player = connectedPlayers[socket.id];
        const group = groupStore[groupId];
        if (!groupVisibleTo(group, player)) return socket.emit('group_error', { message: 'You do not have access to that group.' });
        socket.emit('group_snapshot', group);
    });

    socket.on('send_group_message', ({ groupId, message }) => {
        const player = connectedPlayers[socket.id];
        const group = groupStore[groupId];
        if (!groupVisibleTo(group, player) || typeof message !== 'string' || !message.trim()) return;
        const account = accountByUsername(player.username);
        if (muteIsActive(account)) return socket.emit('group_error', { message: 'You are currently muted.' });
        const msg = {
            id: crypto.randomUUID(),
            senderUsername: player.username,
            message: moderateText(message.trim()),
            timestamp: Date.now(),
            editedAt: null
        };
        group.messages ||= [];
        group.messages.push(msg);
        group.updatedAt = Date.now();
        saveHistory();
        for (const memberName of group.members) {
            const member = findSocketByUsername(memberName);
            if (!member) continue;
            io.to(member.id).emit('group_message', { groupId, message: msg, group });
            if (memberName !== player.username && msg.message.toLowerCase().includes('@' + memberName.toLowerCase())) {
                io.to(member.id).emit('group_mention', { groupId, groupName: group.name, from: player.username, message: msg.message });
            }
        }
    });

    socket.on('edit_group_message', ({ groupId, messageId, message }) => {
        const player = connectedPlayers[socket.id];
        const group = groupStore[groupId];
        if (!groupVisibleTo(group, player) || !messageId || typeof message !== 'string' || !message.trim()) return;
        const item = (group.messages || []).find(entry => entry.id === messageId && entry.senderUsername === player.username);
        if (!item) return;
        item.message = moderateText(message.trim());
        item.editedAt = Date.now();
        group.updatedAt = Date.now();
        saveHistory();
        for (const memberName of group.members) {
            const member = findSocketByUsername(memberName);
            if (member) io.to(member.id).emit('group_snapshot', group);
        }
    });

    socket.on('delete_group_message', ({ groupId, messageId }) => {
        const player = connectedPlayers[socket.id];
        const group = groupStore[groupId];
        if (!groupVisibleTo(group, player) || !messageId) return;
        const index = (group.messages || []).findIndex(entry => entry.id === messageId && entry.senderUsername === player.username);
        if (index < 0) return;
        group.messages.splice(index, 1);
        group.updatedAt = Date.now();
        saveHistory();
        for (const memberName of group.members) {
            const member = findSocketByUsername(memberName);
            if (member) io.to(member.id).emit('group_snapshot', group);
        }
    });

    socket.on('group_member_action', ({ groupId, targetUsername, action }) => {
        const player = connectedPlayers[socket.id];
        const group = groupStore[groupId];
        if (!groupVisibleTo(group, player)) return;
        const canManage = group.owner === player.username || (group.admins || []).includes(player.username);
        if (!canManage) return;
        const target = sanitizeUsername(targetUsername);
        if (!group.members.includes(target) || target === group.owner) return;
        if (action === 'remove') {
            group.members = group.members.filter(name => name !== target);
            group.admins = (group.admins || []).filter(name => name !== target);
        } else if (action === 'make_admin' && group.owner === player.username) {
            if (!group.admins.includes(target)) group.admins.push(target);
        } else if (action === 'remove_admin' && group.owner === player.username) {
            group.admins = group.admins.filter(name => name !== target);
        }
        group.updatedAt = Date.now();
        saveHistory();
        for (const memberName of [...group.members, target]) {
            const member = findSocketByUsername(memberName);
            if (member) io.to(member.id).emit('group_list_changed');
        }
    });

    socket.on('create_group_party', ({ groupId, mode, smashUrl }) => {
        const player = connectedPlayers[socket.id];
        const group = groupStore[groupId];
        if (!groupVisibleTo(group, player)) return;
        const normalizedMode = mode === 'ffa24' ? 'ffa24' : mode === 'ffa12' ? 'ffa12' : '1v1';
        let cleanUrl = 'https://smashkarts.io';
        let maxPlayers = 12;
        let roomMode = 'ffa';
        if (normalizedMode === '1v1') {
            cleanUrl = extractSmashUrl(smashUrl);
            if (!cleanUrl) return socket.emit('group_error', { message: 'Paste a valid Smash Karts link/code for the 1v1 party.' });
            maxPlayers = 2;
            roomMode = '1v1';
        } else if (normalizedMode === 'ffa24') {
            maxPlayers = 24;
        }

        leaveAllRoomsExcept(socket);
        const roomId = crypto.randomUUID();
        const room = {
            roomId,
            hostName: player.username,
            hostSocketId: socket.id,
            smashUrl: cleanUrl,
            winCondition: roomMode === '1v1' ? 'Group 1v1' : 'Group FFA',
            mode: roomMode,
            queueType: 'casual',
            maxPlayers,
            isPublic: false,
            createdAt: Date.now(),
            groupId,
            players: [],
            messages: []
        };
        activeRoomsMap.set(roomId, room);
        addRoomHistory(room);
        joinRoom(socket, room, player, roomMode === 'ffa' ? 'ffa_lobby_ready' : 'room_created');

        const msg = {
            id: crypto.randomUUID(),
            senderUsername: player.username,
            message: `${player.username} started a ${roomMode === 'ffa' ? `FFA ${maxPlayers}` : '1v1'} party.`,
            type: 'party',
            party: { roomId, mode: roomMode, maxPlayers },
            timestamp: Date.now(),
            editedAt: null
        };
        group.messages ||= [];
        group.messages.push(msg);
        group.updatedAt = Date.now();
        saveHistory();
        for (const memberName of group.members) {
            const member = findSocketByUsername(memberName);
            if (member) io.to(member.id).emit('group_message', { groupId, message: msg, group });
        }
    });

    // ---------------- V12 TOURNAMENTS ----------------
    socket.on('get_tournaments', () => {
        const player = connectedPlayers[socket.id];
        if (!player) return;
        socket.emit('tournament_list', {
            tournaments: tournamentListFor(player),
            canCreate: canHostTournament(player),
            roles: publicRoles(player.roles)
        });
    });

    socket.on('create_tournament', payload => {
        const player = connectedPlayers[socket.id];
        if (!canHostTournament(player)) return socket.emit('tournament_error', { message: 'You need TOURNEY HOST permission.' });
        const name = String(payload?.name || '').trim().slice(0, 60);
        const mode = payload?.mode === 'ffa' ? 'ffa' : '1v1';
        const capacity = mode === 'ffa' ? (Number(payload?.capacity) === 24 ? 24 : 12) : Math.max(4, Math.min(64, Number(payload?.capacity) || 16));
        if (name.length < 3) return socket.emit('tournament_error', { message: 'Tournament name is too short.' });
        const invited = String(payload?.invited || '').split(',').map(s => sanitizeUsername(s.trim())).filter(Boolean);
        const tournament = {
            id: crypto.randomUUID(),
            name,
            hostUsername: player.username,
            mode,
            capacity,
            isPublic: payload?.isPublic !== false,
            rules: String(payload?.rules || '').slice(0, 1200),
            startAt: Number(payload?.startAt) || Date.now(),
            registrationOpen: true,
            status: 'registration',
            invited: [...new Set(invited)],
            participants: [],
            bracket: null,
            createdAt: Date.now()
        };
        tournamentStore[tournament.id] = tournament;
        saveHistory();
        logAudit(player, 'TOURNAMENT_CREATED', tournament.name, tournament.isPublic ? 'public' : 'private');
        socket.emit('tournament_created', tournament);
        for (const invitedName of tournament.invited) {
            const target = findSocketByUsername(invitedName);
            if (target) io.to(target.id).emit('tournament_invite', tournament);
        }
        broadcastTournamentLists();
    });

    socket.on('register_tournament', ({ tournamentId }) => {
        const player = connectedPlayers[socket.id];
        const tournament = tournamentStore[tournamentId];
        if (!player || player.isGuest || !tournament || !tournamentVisibleTo(tournament, player)) return;
        if (!tournament.registrationOpen || tournament.status !== 'registration') return socket.emit('tournament_error', { message: 'Registration is closed.' });
        if (tournament.participants.includes(player.username)) return;
        if (tournament.participants.length >= tournament.capacity) return socket.emit('tournament_error', { message: 'Tournament is full.' });
        tournament.participants.push(player.username);
        saveHistory();
        broadcastTournamentLists();
    });

    socket.on('start_tournament', ({ tournamentId }) => {
        const player = connectedPlayers[socket.id];
        const tournament = tournamentStore[tournamentId];
        if (!tournament || !player) return;
        const canStart = player.roles?.owner || player.username === tournament.hostUsername;
        if (!canStart) return;
        tournament.registrationOpen = false;
        tournament.status = 'active';
        const entrants = tournament.participants.slice();
        if (tournament.mode === '1v1') {
            const pairs = [];
            for (let i = 0; i < entrants.length; i += 2) pairs.push({ a: entrants[i] || null, b: entrants[i + 1] || null, winner: null });
            tournament.bracket = { type: '1v1', rounds: [{ name: 'Round 1', matches: pairs }] };
        } else {
            tournament.bracket = tournament.capacity === 24
                ? { type: 'ffa', heats: [entrants.slice(0, 12), entrants.slice(12, 24)], final: [] }
                : { type: 'ffa', heats: [entrants.slice(0, 12)], final: entrants.slice(0, 12) };
        }
        saveHistory();
        logAudit(player, 'TOURNAMENT_STARTED', tournament.name, `${entrants.length} entrants`);
        broadcastTournamentLists();
    });

    socket.on('invite_tournament_player', ({ tournamentId, username }) => {
        const player = connectedPlayers[socket.id];
        const tournament = tournamentStore[tournamentId];
        if (!player || !tournament) return;
        if (!(player.roles?.owner || player.username === tournament.hostUsername)) return;
        const targetName = sanitizeUsername(username);
        if (!accountByUsername(targetName)) return socket.emit('tournament_error', { message: 'That account was not found.' });
        tournament.invited ||= [];
        if (!tournament.invited.includes(targetName)) tournament.invited.push(targetName);
        saveHistory();
        const target = findSocketByUsername(targetName);
        if (target) io.to(target.id).emit('tournament_invite', tournament);
        broadcastTournamentLists();
    });

    // ---------------- V12 STREAMER ----------------
    socket.on('set_streamer_live', ({ live }) => {
        const player = connectedPlayers[socket.id];
        if (!player || player.isGuest || !(player.roles?.streamer || player.roles?.owner)) return;
        const account = accountByEmail(player.accountEmail);
        if (!account) return;
        account.streamerLive = !!live;
        saveHistory();
        broadcastOnlineUsers();
        socket.emit('streamer_state', { live: account.streamerLive });
    });

    // ---------------- V12 ADMIN / MODERATION ----------------
    socket.on('admin_get_dashboard', () => {
        const actor = connectedPlayers[socket.id];
        if (!isOwnerPlayer(actor)) return;
        socket.emit('admin_dashboard', {
            users: Object.values(accounts).map(account => ({
                ...publicAccountState(account),
                avatar: profileFor(account.username).avatar || '',
                online: !!findSocketByUsername(account.username),
                badges: roleBadges(account.roles)
            })).sort((a, b) => a.username.localeCompare(b.username)),
            reports: reportsForModerators(),
            audit: auditLog.slice(0, 200),
            stats: {
                accounts: Object.keys(accounts).length,
                online: Object.values(connectedPlayers).filter(p => !p.isGuest).length,
                groups: Object.keys(groupStore).length,
                tournaments: Object.keys(tournamentStore).length,
                openReports: reportStore.filter(r => r.status === 'open').length
            }
        });
    });

    socket.on('moderation_get_reports', () => {
        const actor = connectedPlayers[socket.id];
        if (!isModeratorPlayer(actor)) return;
        socket.emit('moderation_reports', reportsForModerators());
    });

    socket.on('admin_set_roles', ({ username, roles }) => {
        const actor = connectedPlayers[socket.id];
        if (!isOwnerPlayer(actor)) return;
        const account = accountByUsername(username);
        if (!account || account.roles.owner) return;
        account.roles.moderator = !!roles?.moderator;
        account.roles.streamer = !!roles?.streamer;
        account.roles.tourneyHost = !!roles?.tourneyHost;
        logAudit(actor, 'ROLES_CHANGED', account.username, JSON.stringify(account.roles));
        saveHistory();
        const target = findSocketByUsername(account.username);
        if (target) {
            target.roles = publicRoles(account.roles);
            io.to(target.id).emit('account_state_changed', publicAccountState(account));
        }
        broadcastOnlineUsers();
        broadcastTournamentLists();
        socket.emit('admin_refresh');
    });

    socket.on('admin_moderation_action', ({ username, action, duration, reason }) => {
        const actor = connectedPlayers[socket.id];
        const account = accountByUsername(username);
        if (!isModeratorPlayer(actor) || !account || !canModerateTarget(actor, account)) return;
        const now = Date.now();
        const durationMs = safeDurationMs(duration);
        if (action === 'warn') {
            account.warnings += 1;
        } else if (action === 'mute') {
            account.mutedUntil = durationMs === -1 ? -1 : now + durationMs;
        } else if (action === 'unmute') {
            account.mutedUntil = null;
        } else if (action === 'ban') {
            account.bannedUntil = durationMs === -1 ? -1 : now + durationMs;
            account.banReason = String(reason || 'Banned by moderation').slice(0, 300);
            const live = findSocketByUsername(account.username);
            if (live) {
                io.to(live.id).emit('moderation_notice', { message: `You were banned. ${account.banReason}` });
                const liveSocket = io.sockets.sockets.get(live.id);
                if (liveSocket) setTimeout(() => liveSocket.disconnect(true), 150);
            }
        } else if (action === 'unban') {
            account.bannedUntil = null;
            account.banReason = '';
        } else if (action === 'reset_avatar') {
            profileFor(account.username).avatar = '';
        } else if (action === 'clear_warnings') {
            account.warnings = 0;
        } else if (action === 'kick') {
            const targetSocket = findSocketByUsername(account.username);
            if (targetSocket) {
                io.to(targetSocket.id).emit('moderation_notice', { message: reason || 'You were kicked by a moderator.' });
                targetSocket.socket?.disconnect?.(true);
                const liveSocket = io.sockets.sockets.get(targetSocket.id);
                if (liveSocket) liveSocket.disconnect(true);
            }
        }
        logAudit(actor, `MOD_${String(action).toUpperCase()}`, account.username, String(reason || ''));
        saveHistory();
        const target = findSocketByUsername(account.username);
        if (target) io.to(target.id).emit('account_state_changed', publicAccountState(account));
        socket.emit('moderation_action_complete', { username: account.username, action, bannedUntil: account.bannedUntil, mutedUntil: account.mutedUntil });
        socket.emit('admin_refresh');
    });

    socket.on('admin_set_progress', ({ username, level, rating1v1, ratingFFA }) => {
        const actor = connectedPlayers[socket.id];
        if (!isOwnerPlayer(actor)) return;
        const account = accountByUsername(username);
        if (!account || account.roles.owner) return;
        if (Number.isFinite(Number(level))) {
            account.level = Math.max(1, Math.min(200, Math.round(Number(level))));
            account.xp = (account.level - 1) * 250;
        }
        if (Number.isFinite(Number(rating1v1))) account.rating1v1 = Math.max(0, Math.round(Number(rating1v1)));
        if (Number.isFinite(Number(ratingFFA))) account.ratingFFA = Math.max(0, Math.round(Number(ratingFFA)));
        logAudit(actor, 'PROGRESS_CHANGED', account.username, `L${account.level} 1v1:${account.rating1v1} FFA:${account.ratingFFA}`);
        saveHistory();
        const target = findSocketByUsername(account.username);
        if (target) io.to(target.id).emit('account_state_changed', publicAccountState(account));
        broadcastOnlineUsers();
        socket.emit('admin_refresh');
    });

    socket.on('admin_force_username', ({ username, newUsername }) => {
        const actor = connectedPlayers[socket.id];
        if (!isOwnerPlayer(actor)) return;
        const account = accountByUsername(username);
        if (!account || account.roles.owner) return;
        const next = String(newUsername || '').trim();
        if (!validUsername(next) || isReservedOwnerName(next) || accountByUsername(next)) return socket.emit('admin_error', { message: 'That username cannot be used.' });
        const old = account.username;
        renameUserEverywhere(old, next);
        account.username = next;
        logAudit(actor, 'FORCE_RENAME', next, `${old} -> ${next}`);
        saveHistory();
        const target = findSocketByUsername(old);
        if (target) {
            target.username = next;
            io.to(target.id).emit('forced_username_changed', { username: next });
        }
        broadcastOnlineUsers();
        socket.emit('admin_refresh');
    });

    socket.on('resolve_report', ({ reportId, status }) => {
        const actor = connectedPlayers[socket.id];
        if (!isModeratorPlayer(actor)) return;
        const report = reportStore.find(r => r.id === reportId);
        if (!report) return;
        report.status = ['resolved', 'dismissed'].includes(status) ? status : 'resolved';
        report.resolvedBy = actor.username;
        report.resolvedAt = Date.now();
        logAudit(actor, 'REPORT_' + report.status.toUpperCase(), report.reportedUser, report.id);
        saveHistory();
        socket.emit('admin_refresh');
    });


    socket.on('disconnect', () => {
        for (const roomId of Array.from(activeRoomsMap.keys())) {
            leaveLiveRoom(socket, roomId);
        }
        delete connectedPlayers[socket.id];
        broadcastOnlineUsers();
        broadcastPublicRooms();
    });
});

function broadcastOnlineUsers() {
    const users = Object.values(connectedPlayers)
        .filter(p => p.isOnline !== false)
        .map(p => ({
            id: p.id,
            username: p.username,
            isGuest: !!p.isGuest,
            avatar: p.avatar || '',
            friends: p.isGuest ? [] : Array.from(p.friends || []),
            roles: publicRoles(p.roles),
            badges: roleBadges(p.roles),
            level: p.level || 1,
            rating1v1: p.rating1v1 || 1000,
            ratingFFA: p.ratingFFA || 1000,
            streamerLive: !p.isGuest && !!accountByUsername(p.username)?.streamerLive
        }));

    io.emit('online_users_update', {
        count: users.length,
        users
    });
}

function broadcastLeaderboard() {
    const topPlayers = Object.entries(playerStats)
        .map(([username, matches]) => ({ username, matches }))
        .filter(p => p.username && !/^Guest-/i.test(p.username))
        .sort((a, b) => b.matches - a.matches)
        .slice(0, 25);

    io.emit('leaderboard_update', topPlayers);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Smashkarts1v1s Mega Arena running on port ${PORT}`);
});

// ============================================================================
// BROWSER-SIDE MEGA UPGRADE
// Injected AFTER your existing script.js.
// ============================================================================
function installMegaArena() {
    const GUEST_KEY = 'smash_guest_profile_v4';
    const NOTES_KEY = 'smash_arena_notes_v4';
    const PREF_KEY = 'smash_arena_preferences_v4';
    const SESSION_STARTED = Date.now();

    function readJSON(key, fallback) {
        try {
            const value = JSON.parse(localStorage.getItem(key));
            return value == null ? fallback : value;
        } catch {
            return fallback;
        }
    }

    function writeJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }

    function randomGuestName() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let suffix = '';
        for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
        return `Guest-${suffix}`;
    }

    function getAccountSession() {
        try {
            const raw = localStorage.getItem('user_session');
            if (!raw) return null;
            const user = JSON.parse(raw);
            if (!user || !user.username || !user.email) return null;
            return { ...user, isGuest: false };
        } catch {
            return null;
        }
    }

    function getGuestSession() {
        let guest = readJSON(GUEST_KEY, null);
        if (!guest || !guest.username) {
            guest = {
                username: randomGuestName(),
                email: null,
                isGuest: true,
                createdAt: Date.now()
            };
            writeJSON(GUEST_KEY, guest);
        }
        return { ...guest, isGuest: true };
    }

    function isRealAccount() {
        return !!getAccountSession();
    }

    // ---------------------------------------------------------------------
    // OPTIONAL LOGIN / GUEST MODE
    // The site's original script thinks a session is required. We make a
    // guest session count as enough to PLAY, while the server still knows
    // whether this is a real account for persistent features.
    // ---------------------------------------------------------------------
    const originalAuthLogin = AuthSession.login.bind(AuthSession);

    AuthSession.getUser = function () {
        return getAccountSession() || getGuestSession();
    };

    AuthSession.isLoggedIn = function () {
        return true;
    };

    AuthSession.login = function (email, username) {
        originalAuthLogin(email, username);
        setTimeout(() => updateAccountUI(), 0);
    };

    AuthSession.logout = function () {
        localStorage.removeItem('user_session');
        window.location.reload();
    };

    function closeExclusiveModals(exceptId = null) {
        [
            'settingsModal',
            'editUsernameModal',
            'authModal',
            'onlineUsersModal',
            'preGameLobbyModal',
            'makeCodeModal',
            'findGameModal'
        ].forEach(id => {
            if (id === exceptId) return;
            document.getElementById(id)?.classList.add('hidden');
        });
    }

    function showExclusiveModal(id) {
        closeExclusiveModals(id);
        document.getElementById(id)?.classList.remove('hidden');
    }

    window.closeAuthModalOptional = function () {
        document.getElementById('authModal')?.classList.add('hidden');
    };

    window.openOptionalLogin = function () {
        showExclusiveModal('authModal');
    };

    // Override the old modal openers so two full-screen windows cannot stack.
    const originalOpenOnlineModal = openOnlineModal;
    openOnlineModal = function () {
        closeExclusiveModals('onlineUsersModal');
        originalOpenOnlineModal();
    };

    const originalOpenMakeCodeModal = openMakeCodeModal;
    openMakeCodeModal = function () {
        closeExclusiveModals('makeCodeModal');
        originalOpenMakeCodeModal();
    };

    const originalOpenFindGameModal = openFindGameModal;
    openFindGameModal = function () {
        closeExclusiveModals('findGameModal');
        originalOpenFindGameModal();
    };

    const originalPromptEditUsername = promptEditUsername;
    promptEditUsername = function () {
        closeExclusiveModals('editUsernameModal');
        originalPromptEditUsername();
    };

    // Settings is one normal modal. Connection status stays in the header.
    openSettingsModal = function () {
        closeExclusiveModals('settingsModal');
        syncMainSettings();
        document.getElementById('settingsModal')?.classList.remove('hidden');
    };

    closeSettingsModal = function () {
        document.getElementById('settingsModal')?.classList.add('hidden');
    };

    // Guest rename stays guest. It does NOT accidentally create a fake login.
    saveNewUsername = function () {
        const input = document.getElementById('newUsernameInput');
        const name = String(input?.value || '').trim().slice(0, 20);
        if (!name) return;

        const account = getAccountSession();
        if (account) {
            const oldName = account.username;
            account.username = name;
            localStorage.setItem('user_session', JSON.stringify(account));

            const users = AuthSession.getRegisteredUsers();
            const match = users.find(u =>
                String(u.email || '').toLowerCase() === String(account.email || '').toLowerCase()
            );
            if (match) {
                match.username = name;
                localStorage.setItem('registered_users', JSON.stringify(users));
            }

            showToast(`Username changed from ${oldName} to ${name}.`, '✏️');
        } else {
            const guest = getGuestSession();
            guest.username = name.startsWith('Guest-') ? name : name;
            writeJSON(GUEST_KEY, guest);
            showToast(`Guest name changed to ${name}.`, '✏️');
        }

        closeEditUsernameModal();
        updateUserUI();
        updateAccountUI();
    };

    // Do not use the original updateUserUI because we need to mark guests.
    updateUserUI = function () {
        const user = AuthSession.getUser();
        const account = getAccountSession();
        const tag = document.getElementById('userDisplayTag');
        if (tag) tag.textContent = user.username;

        socket.emit('set_user_session', {
            username: user.username,
            email: account ? account.email : null,
            isGuest: !account
        });

        updateAccountUI();
    };

    function updateAccountUI() {
        const user = AuthSession.getUser();
        const account = getAccountSession();
        const isGuest = !account;

        const tag = document.getElementById('userDisplayTag');
        if (tag) tag.textContent = user.username;

        const mode = document.getElementById('accountModeLabel');
        if (mode) mode.textContent = isGuest ? 'Guest Mode' : 'Saved Account';

        const headerButton = document.getElementById('headerAccountButton');
        if (headerButton) {
            headerButton.textContent = isGuest ? 'LOG IN TO SAVE STATS' : 'LOG OUT';
            headerButton.onclick = isGuest ? openOptionalLogin : () => AuthSession.logout();
            headerButton.className = isGuest
                ? 'bg-yellow-400 hover:bg-yellow-300 text-blue-950 text-xs font-black px-4 py-2 rounded-xl'
                : 'bg-red-600 hover:bg-red-500 text-white text-xs font-bold px-4 py-2 rounded-xl';
        }

        const settingsAccount = document.getElementById('settingsAccountButton');
        if (settingsAccount) {
            settingsAccount.textContent = isGuest ? 'LOG IN TO SAVE STATS' : 'LOG OUT TO GUEST MODE';
            settingsAccount.onclick = isGuest ? openOptionalLogin : () => AuthSession.logout();
        }

        const guestMessage = document.getElementById('guestMessagesNotice');
        if (guestMessage) guestMessage.classList.toggle('hidden', !isGuest);

        if (isGuest) currentProfileAvatar = '';
        renderOwnProfilePicture();
    }

    // ---------------------------------------------------------------------
    // SAVED PROFILE PICTURE
    // Account users can upload one circular PFP. The browser crops/compresses
    // it before sending it to the server, so history.json does not get huge.
    // ---------------------------------------------------------------------
    const AVATAR_CACHE_KEY = 'smash_avatar_cache_v1';
    let currentProfileAvatar = '';

    function avatarCache() {
        return readJSON(AVATAR_CACHE_KEY, {});
    }

    function cacheAvatar(username, avatar) {
        if (!username) return;
        const cache = avatarCache();
        if (avatar) cache[username] = avatar;
        else delete cache[username];
        writeJSON(AVATAR_CACHE_KEY, cache);
    }

    function avatarFor(username) {
        const self = AuthSession.getUser();
        if (self?.username === username && currentProfileAvatar) return currentProfileAvatar;
        const online = onlineUsersCache.find(user => user.username === username);
        if (online?.avatar) return online.avatar;
        return avatarCache()[username] || '';
    }

    function initialsFor(name) {
        return String(name || '?')
            .split(/[\s_-]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(part => part[0]?.toUpperCase() || '')
            .join('') || '?';
    }

    function fillAvatarBox(box, avatar, name, fallbackEmoji = null) {
        if (!box) return;
        box.replaceChildren();
        if (avatar) {
            const img = document.createElement('img');
            img.src = avatar;
            img.alt = `${name || 'User'} profile picture`;
            box.appendChild(img);
        } else {
            box.textContent = fallbackEmoji || initialsFor(name);
        }
    }

    function renderOwnProfilePicture() {
        const user = AuthSession.getUser();
        const account = getAccountSession();
        const avatar = account ? currentProfileAvatar : '';

        const headerImage = document.getElementById('headerProfileImage');
        const headerFallback = document.getElementById('headerProfileFallback');
        if (headerImage && headerFallback) {
            if (avatar) {
                headerImage.src = avatar;
                headerImage.classList.remove('hidden');
                headerFallback.classList.add('hidden');
            } else {
                headerImage.removeAttribute('src');
                headerImage.classList.add('hidden');
                headerFallback.classList.remove('hidden');
            }
        }

        const settingsImage = document.getElementById('settingsProfileImage');
        const settingsFallback = document.getElementById('settingsProfileFallback');
        if (settingsImage && settingsFallback) {
            if (avatar) {
                settingsImage.src = avatar;
                settingsImage.classList.remove('hidden');
                settingsFallback.classList.add('hidden');
            } else {
                settingsImage.removeAttribute('src');
                settingsImage.classList.add('hidden');
                settingsFallback.classList.remove('hidden');
            }
        }

        const upload = document.getElementById('uploadProfilePictureButton');
        const remove = document.getElementById('removeProfilePictureButton');
        const note = document.getElementById('profilePictureAccountNote');
        if (upload) {
            upload.disabled = !account;
            upload.textContent = account ? '📷 UPLOAD PROFILE PICTURE' : '🔒 LOG IN TO ADD PFP';
            upload.style.opacity = account ? '1' : '.6';
        }
        if (remove) remove.classList.toggle('hidden', !account || !avatar);
        if (note) note.textContent = account
            ? 'Your picture is saved with this account and shown as a circle.'
            : 'Log in to a saved account before uploading a profile picture.';

        if (user?.username && avatar) cacheAvatar(user.username, avatar);
    }

    window.openProfilePicturePicker = function () {
        if (!isRealAccount()) {
            showToast('Log in to save a profile picture.', '🔒');
            openOptionalLogin();
            return;
        }
        document.getElementById('profilePictureInput')?.click();
    };

    window.handleProfilePictureUpload = function (event) {
        const input = event?.target;
        const file = input?.files?.[0];
        if (!file) return;
        if (!isRealAccount()) {
            if (input) input.value = '';
            openOptionalLogin();
            return;
        }
        if (!/^image\/(?:png|jpeg|webp)$/i.test(file.type || '') || file.size > 8 * 1024 * 1024) {
            if (input) input.value = '';
            showToast('Choose a JPG, PNG, or WebP image under 8 MB.', '❌');
            return;
        }

        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            try {
                const size = Math.min(img.naturalWidth, img.naturalHeight);
                const sx = Math.max(0, (img.naturalWidth - size) / 2);
                const sy = Math.max(0, (img.naturalHeight - size) / 2);
                const canvas = document.createElement('canvas');
                canvas.width = 256;
                canvas.height = 256;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#1e3a8a';
                ctx.fillRect(0, 0, 256, 256);
                ctx.drawImage(img, sx, sy, size, size, 0, 0, 256, 256);
                let dataUrl = canvas.toDataURL('image/webp', 0.82);
                if (!/^data:image\/webp;base64,/i.test(dataUrl)) {
                    dataUrl = canvas.toDataURL('image/jpeg', 0.84);
                }
                socket.emit('update_profile_picture', { dataUrl });
            } finally {
                URL.revokeObjectURL(objectUrl);
                if (input) input.value = '';
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            if (input) input.value = '';
            showToast('That image could not be opened.', '❌');
        };
        img.src = objectUrl;
    };

    window.removeProfilePicture = function () {
        if (!isRealAccount()) return openOptionalLogin();
        socket.emit('update_profile_picture', { dataUrl: '' });
    };

    socket.on('saved_profile', data => {
        currentProfileAvatar = String(data?.avatar || '');
        renderOwnProfilePicture();
    });

    socket.on('profile_picture_updated', data => {
        currentProfileAvatar = String(data?.avatar || '');
        renderOwnProfilePicture();
        updateFriendsTabList();
        showToast(currentProfileAvatar ? 'Profile picture saved.' : 'Profile picture removed.', '👤');
    });

    socket.on('profile_picture_error', data => {
        showToast(data?.message || 'Could not save that profile picture.', '❌');
    });

    // Clean online-player list: friends show as FRIEND instead of another
    // Message button. Messages live only in the Messages page.
    renderOnlineUsersList = function (users) {
        const container = document.getElementById('onlineUsersList');
        if (!container) return;
        container.replaceChildren();

        const me = AuthSession.getUser()?.username || '';
        (users || []).forEach(user => {
            if (user.id === socket.id || user.username === me) return;
            if (user.avatar) cacheAvatar(user.username, user.avatar);

            const row = document.createElement('div');
            row.className = 'flex justify-between items-center gap-3 bg-blue-950/80 p-3 rounded-2xl border border-white/10';

            const identity = document.createElement('div');
            identity.className = 'flex items-center gap-2 min-w-0';
            const avatar = document.createElement('div');
            avatar.className = 'round-user-avatar';
            fillAvatarBox(avatar, user.avatar || avatarFor(user.username), user.username);
            const copy = document.createElement('div');
            copy.className = 'min-w-0';
            const name = document.createElement('div');
            name.className = 'font-bold text-xs text-white truncate';
            name.textContent = user.username;
            const meta = document.createElement('div');
            meta.className = 'text-[9px] text-blue-200';
            meta.textContent = user.isGuest ? 'Guest' : 'Saved account';
            copy.append(name, meta);
            identity.append(avatar, copy);

            const action = document.createElement('div');
            if (isUserFriend(user.username)) {
                const friend = document.createElement('span');
                friend.className = 'text-[10px] font-black text-emerald-300 px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-400/30';
                friend.textContent = '✓ FRIEND';
                action.appendChild(friend);
            } else if (user.isGuest) {
                const guest = document.createElement('span');
                guest.className = 'text-[9px] text-blue-300';
                guest.textContent = 'Guest';
                action.appendChild(guest);
            } else {
                const add = document.createElement('button');
                add.className = 'bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-2.5 py-1.5 rounded-lg';
                add.textContent = '+ ADD FRIEND';
                add.onclick = () => sendFriendRequest(user.id, user.username);
                action.appendChild(add);
            }

            row.append(identity, action);
            container.appendChild(row);
        });

        if (!container.children.length) {
            const empty = document.createElement('p');
            empty.className = 'text-xs text-blue-200 text-center py-4';
            empty.textContent = 'Nobody else is online right now.';
            container.appendChild(empty);
        }
    };

    // Keep a lightweight local avatar cache so an offline friend can still
    // retain the last profile picture you saw for them in DMs.
    socket.on('online_users_update', ({ users }) => {
        (users || []).forEach(user => {
            if (user.avatar) cacheAvatar(user.username, user.avatar);
        });
    });

    // Friend/DM actions explain account requirement immediately instead of
    // letting a guest think the button is broken.
    const originalSendFriendRequest = sendFriendRequest;
    sendFriendRequest = function (targetSocketId, username) {
        if (!isRealAccount()) {
            showToast('Log in if you want to save friends.', '🔒');
            openOptionalLogin();
            return;
        }
        originalSendFriendRequest(targetSocketId, username);
    };

    // Synchronize old browser-saved friends with the server. This also keeps
    // the Discord-style DM list and the server permission check identical.
    socket.on('saved_friends', data => {
        const account = getAccountSession();
        const user = AuthSession.getUser();
        if (!account || !user) return;

        const oldLocal = getLocalFriends(user.username).slice();
        const serverFriends = Array.isArray(data?.friends) ? data.friends : [];
        const serverRequests = Array.isArray(data?.requests) ? data.requests : [];

        saveLocalFriends(user.username, serverFriends);
        pendingFriendRequests = serverRequests;

        const self = onlineUsersCache.find(person => person.username === user.username);
        if (self) self.friends = serverFriends.slice();

        const missingOnServer = oldLocal.filter(name =>
            !serverFriends.some(serverName => String(serverName).toLowerCase() === String(name).toLowerCase())
        );
        if (missingOnServer.length) {
            socket.emit('restore_legacy_friends', { friends: missingOnServer });
        }

        updateFriendsTabList();
        renderOnlineUsersList(onlineUsersCache);
    });

    // ---------------------------------------------------------------------
    // NORMAL DASHBOARD PAGES
    // ---------------------------------------------------------------------
    function activateDashboardTab(tabId, navId) {
        closeExclusiveModals();
        document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.sidebar-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById(tabId)?.classList.remove('hidden');
        document.getElementById(navId)?.classList.add('active');
    }

    window.openFfaPage = function () {
        activateDashboardTab('ffaTab', 'btnNavFFA');
    };

    window.playFFAFromPage = function () {
        socket.emit('play_ffa');
    };

    window.createFFAFromPage = function () {
        const maxPlayers = Number(document.getElementById('ffaMaxPlayers')?.value || 12);
        const isPublic = document.getElementById('ffaPrivacy')?.value !== 'private';
        socket.emit('create_ffa_lobby', { maxPlayers, isPublic });
    };

    window.openMusicPage = function () {
        const game = document.getElementById('gameScreen');
        if (game && !game.classList.contains('hidden')) {
            openGameDock('music');
            return;
        }
        activateDashboardTab('musicTab', 'btnNavMusic');
        renderSpotifyEverywhere();
    };

    // Compatibility for any older buttons still cached by the browser.
    window.openHubPage = function (panel = 'settings') {
        if (panel === 'music') openMusicPage();
        else openSettingsModal();
    };

    // Only 1v1 remains. FFA has its own page.
    switchMatchMode = function () {
        currentMode = '1v1';
        showTab('setupTab');
        document.getElementById('btnNav1v1')?.classList.add('active');
        document.getElementById('btnNavFFA')?.classList.remove('active');
        document.getElementById('btnNavMusic')?.classList.remove('active');
        const title = document.getElementById('arenaTitle');
        const subtitle = document.getElementById('arenaSubtitle');
        if (title) title.textContent = '1v1 MATCHMAKING';
        if (subtitle) subtitle.textContent = 'Start or join a 1v1 match';
    };


    // ---------------------------------------------------------------------
    // DISCORD-LIKE DIRECT MESSAGES
    // One clean friends rail + one conversation. No stacked DM windows.
    // ---------------------------------------------------------------------
    const dmUnreadByUser = Object.create(null);
    let currentDMHistory = [];

    function dmInitials(name) {
        return String(name || '?')
            .split(/[\s_-]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(part => part[0]?.toUpperCase() || '')
            .join('') || '?';
    }

    function dmIsOnline(username) {
        return onlineUsersCache.some(user => user.username === username);
    }

    function getMergedFriendNames() {
        const currentUser = AuthSession.getUser();
        if (!currentUser || !isRealAccount()) return [];

        const names = getLocalFriends(currentUser.username).slice();
        const self = onlineUsersCache.find(user => user.username === currentUser.username);
        (self?.friends || []).forEach(name => {
            if (!names.includes(name)) names.push(name);
        });
        return names.sort((a, b) => {
            const onlineDiff = Number(dmIsOnline(b)) - Number(dmIsOnline(a));
            return onlineDiff || a.localeCompare(b);
        });
    }

    window.filterDiscordFriends = function () {
        updateFriendsTabList();
    };

    showMessagesTab = function () {
        activateDashboardTab('messagesTab', 'btnNavMessages');
        clearUnreadBadge();
        updateFriendsTabList();
    };

    updateFriendsTabList = function () {
        const container = document.getElementById('friendsTabList');
        if (!container) return;
        container.replaceChildren();

        if (!isRealAccount()) {
            const card = document.createElement('div');
            card.className = 'p-3 m-1 rounded-xl bg-yellow-500/10 border border-yellow-400/30 text-xs text-yellow-100';
            card.innerHTML = '<div class="font-black mb-1">LOG IN FOR DIRECT MESSAGES</div><div class="text-[10px] opacity-90">Guest lobby chat still works normally.</div>';
            const button = document.createElement('button');
            button.className = 'dock-action yellow mt-3';
            button.textContent = 'LOG IN';
            button.onclick = openOptionalLogin;
            card.appendChild(button);
            container.appendChild(card);
            return;
        }

        const query = String(document.getElementById('dmFriendSearch')?.value || '').trim().toLowerCase();

        if ((pendingFriendRequests || []).length) {
            const label = document.createElement('div');
            label.className = 'discord-section-label';
            label.textContent = `Friend requests — ${pendingFriendRequests.length}`;
            container.appendChild(label);

            pendingFriendRequests
                .filter(name => !query || name.toLowerCase().includes(query))
                .forEach(name => {
                    const wrap = document.createElement('div');
                    wrap.className = 'discord-request';

                    const title = document.createElement('div');
                    title.className = 'font-bold text-xs text-white mb-2';
                    title.textContent = name;

                    const actions = document.createElement('div');
                    actions.className = 'grid grid-cols-2 gap-1';

                    const accept = document.createElement('button');
                    accept.className = 'bg-emerald-600 hover:bg-emerald-500 text-white text-[9px] font-black px-2 py-1.5 rounded-lg';
                    accept.textContent = 'ACCEPT';
                    accept.onclick = () => acceptFriendRequestByName(name);

                    const decline = document.createElement('button');
                    decline.className = 'bg-red-600 hover:bg-red-500 text-white text-[9px] font-black px-2 py-1.5 rounded-lg';
                    decline.textContent = 'DECLINE';
                    decline.onclick = () => declineFriendRequestByName(name);

                    actions.append(accept, decline);
                    wrap.append(title, actions);
                    container.appendChild(wrap);
                });
        }

        const label = document.createElement('div');
        label.className = 'discord-section-label';
        label.textContent = 'Direct messages';
        container.appendChild(label);

        const friends = getMergedFriendNames().filter(name =>
            !query || name.toLowerCase().includes(query)
        );

        if (!friends.length) {
            const empty = document.createElement('div');
            empty.className = 'text-[10px] text-blue-200 p-2';
            empty.textContent = query
                ? 'No friends match that search.'
                : 'No friends yet. Click + FIND FRIENDS.';
            container.appendChild(empty);
            return;
        }

        friends.forEach(name => {
            const online = dmIsOnline(name);
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `discord-friend${activeDMTargetUser === name ? ' active' : ''}`;
            row.onclick = () => openTabDMWith(name);

            const avatar = document.createElement('div');
            avatar.className = 'discord-avatar';
            fillAvatarBox(avatar, avatarFor(name), name);
            const dot = document.createElement('span');
            dot.className = `discord-status-dot${online ? ' online' : ''}`;
            avatar.appendChild(dot);

            const copy = document.createElement('div');
            copy.className = 'min-w-0 flex-1';

            const title = document.createElement('div');
            title.className = 'text-xs font-black truncate';
            title.textContent = name;

            const sub = document.createElement('div');
            sub.className = 'text-[9px] text-blue-200 truncate';
            sub.textContent = online ? 'Online' : 'Offline';

            copy.append(title, sub);
            row.append(avatar, copy);

            const unread = Number(dmUnreadByUser[name] || 0);
            if (unread > 0) {
                const badge = document.createElement('span');
                badge.className = 'discord-unread';
                badge.textContent = unread > 99 ? '99+' : String(unread);
                row.appendChild(badge);
            }

            container.appendChild(row);
        });
    };

    openTabDMWith = function (username) {
        if (!isRealAccount()) {
            openOptionalLogin();
            return;
        }

        activeDMTargetUser = username;
        dmUnreadByUser[username] = 0;
        clearUnreadBadge();

        const header = document.getElementById('activeDMChatHeader');
        if (header) header.textContent = username;

        const status = document.getElementById('dmChatStatus');
        if (status) status.textContent = dmIsOnline(username) ? '● Online' : '○ Offline';

        const avatar = document.getElementById('dmChatAvatar');
        if (avatar) fillAvatarBox(avatar, avatarFor(username), username);

        const messages = document.getElementById('tabDMMessages');
        if (messages) messages.innerHTML = '<div class="h-full grid place-items-center text-xs text-blue-200">Loading messages…</div>';

        updateFriendsTabList();
        socket.emit('get_dm_history', { targetUsername: username });
    };

    sendTabDM = function () {
        const input = document.getElementById('tabDMInput');
        const message = String(input?.value || '').trim();

        if (!isRealAccount()) {
            openOptionalLogin();
            return;
        }
        if (!activeDMTargetUser) {
            showToast('Select a friend first.', '💬');
            return;
        }
        if (!message) return;

        socket.emit('send_direct_message', {
            targetUsername: activeDMTargetUser,
            message,
            senderUsername: AuthSession.getUser()?.username || 'Player'
        });
        input.value = '';
        input.focus();
    };

    renderDMMessages = function (history) {
        currentDMHistory = Array.isArray(history) ? history : [];
        const container = document.getElementById('tabDMMessages');
        if (!container) return;
        container.replaceChildren();

        if (!activeDMTargetUser) {
            const empty = document.createElement('div');
            empty.className = 'h-full grid place-items-center text-center text-blue-200 text-xs';
            empty.textContent = 'Select a friend to start messaging.';
            container.appendChild(empty);
            return;
        }

        if (!currentDMHistory.length) {
            const empty = document.createElement('div');
            empty.className = 'h-full grid place-items-center text-center text-blue-200 text-xs';
            empty.textContent = `This is the beginning of your conversation with ${activeDMTargetUser}.`;
            container.appendChild(empty);
            return;
        }

        const me = AuthSession.getUser()?.username || 'Player';

        currentDMHistory.forEach(message => {
            const own = message.senderUsername === me;
            const row = document.createElement('div');
            row.className = 'discord-message';

            const avatar = document.createElement('div');
            avatar.className = 'discord-avatar big';
            fillAvatarBox(avatar, avatarFor(message.senderUsername), message.senderUsername);

            const body = document.createElement('div');
            body.className = 'min-w-0';

            const head = document.createElement('div');
            const name = document.createElement('span');
            name.className = 'discord-message-name';
            name.textContent = own ? 'You' : message.senderUsername;

            const time = document.createElement('span');
            time.className = 'discord-message-time';
            time.textContent = message.timestamp
                ? new Date(message.timestamp).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                })
                : '';

            const text = document.createElement('div');
            text.className = 'discord-message-text';
            text.textContent = message.message;

            head.append(name, time);
            body.append(head, text);
            row.append(avatar, body);
            container.appendChild(row);
        });

        container.scrollTop = container.scrollHeight;
    };

    socket.off('receive_direct_message');
    socket.off('dm_sent_success');
    socket.off('load_dm_history');

    socket.on('receive_direct_message', data => {
        const from = data.senderUsername;
        if (activeDMTargetUser === from &&
            !document.getElementById('messagesTab')?.classList.contains('hidden')) {
            renderDMMessages(data.history || []);
        } else {
            dmUnreadByUser[from] = Number(dmUnreadByUser[from] || 0) + 1;
            incrementUnreadBadge();
            showToast(`New message from ${from}`, '💬');
        }
        updateFriendsTabList();
    });

    socket.on('dm_sent_success', data => {
        if (data.targetUsername === activeDMTargetUser) {
            renderDMMessages(data.history || []);
        }
    });

    socket.on('load_dm_history', data => {
        if (data.targetUsername === activeDMTargetUser) {
            renderDMMessages(data.history || []);
        }
    });

    // ---------------------------------------------------------------------
    // SINGLE IN-GAME DOCK
    // ---------------------------------------------------------------------
    let activeDockTab = null;

    function dockTitle(tab) {
        return {
            lobby: '👥 LOBBY',
            chat: '💬 LOBBY CHAT',
            music: '🎵 SPOTIFY',
            tools: '⚙ OPTIONS'
        }[tab] || 'ARENA';
    }

    window.openGameDock = function (tab = 'lobby') {
        const screen = document.getElementById('gameScreen');
        const isGameOpen = screen && !screen.classList.contains('hidden');

        if (!isGameOpen) {
            if (tab === 'lobby' || tab === 'chat') {
                if (activeRoomData) openPreGameLobby(activeRoomData);
                else showToast('You are not in a lobby yet.', 'ℹ️');
            } else if (tab === 'music') {
                closeExclusiveModals();
                openMusicPage();
            } else {
                closeExclusiveModals();
                openSettingsModal();
            }
            return;
        }

        activeDockTab = tab;
        screen.classList.add('game-dock-open');
        document.getElementById('gameDockTitle').textContent = dockTitle(tab);

        document.querySelectorAll('.game-dock-panel').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.dock-tab-button').forEach(el => el.classList.remove('active'));

        const panelMap = {
            lobby: 'dockLobbyPanel',
            chat: 'dockChatPanel',
            music: 'dockMusicPanel',
            tools: 'dockToolsPanel'
        };
        document.getElementById(panelMap[tab])?.classList.remove('hidden');
        document.querySelector(`[data-dock-tab="${tab}"]`)?.classList.add('active');

        document.getElementById('gameLobbyButton')?.classList.toggle('active', tab === 'lobby');
        document.getElementById('arenaChatButton')?.classList.toggle('active', tab === 'chat');
        document.getElementById('arenaOptionsButton')?.classList.toggle('active', tab === 'tools');

        if (activeRoomData) refreshRoomUI(activeRoomData);
        if (tab === 'chat') {
            document.getElementById('toggleChatBtnLabel').textContent = 'Hide Chat';
            document.getElementById('matchChatInput')?.focus();
        } else {
            document.getElementById('toggleChatBtnLabel').textContent = 'Show Chat';
        }
    };

    window.closeGameDock = function () {
        const screen = document.getElementById('gameScreen');
        screen?.classList.remove('game-dock-open');
        activeDockTab = null;
        document.querySelectorAll('.arena-button').forEach(button => {
            if (['gameLobbyButton', 'arenaChatButton', 'arenaOptionsButton'].includes(button.id)) {
                button.classList.remove('active');
            }
        });
        const label = document.getElementById('toggleChatBtnLabel');
        if (label) label.textContent = 'Show Chat';
    };

    // Keep the user's requested 5-second chat close behavior, but only the
    // one dock closes; nothing else piles up.
    triggerChatActivityTimer = function () {
        clearTimeout(chatInactivityTimer);
        openGameDock('chat');
        chatInactivityTimer = setTimeout(() => {
            if (activeDockTab === 'chat') closeGameDock();
        }, 5000);
    };

    toggleOverlayChat = function () {
        const screen = document.getElementById('gameScreen');
        if (screen?.classList.contains('game-dock-open') && activeDockTab === 'chat') {
            closeGameDock();
        } else {
            triggerChatActivityTimer();
        }
    };

    // ---------------------------------------------------------------------
    // ROOM / LOBBY UI
    // ---------------------------------------------------------------------
    function roomCodeFromUrl(url) {
        const match = String(url || '').match(/[?&]room=([A-Za-z0-9]+)/i);
        return match ? match[1] : '';
    }

    function localMember(room) {
        return room?.players?.find(player => player.id === socket.id) || null;
    }

    function playerLine(player, room, hostView) {
        const wrap = document.createElement('div');
        wrap.className = 'bg-blue-900/60 p-2 rounded-xl border border-white/10 flex items-center justify-between gap-2';

        const identity = document.createElement('div');
        identity.className = 'flex items-center gap-2 min-w-0';
        const avatar = document.createElement('div');
        avatar.className = 'round-user-avatar';
        fillAvatarBox(avatar, player.avatar || avatarFor(player.name), player.name);
        const left = document.createElement('div');
        left.className = 'min-w-0';
        const name = document.createElement('div');
        name.className = 'font-bold text-xs text-white truncate';
        name.textContent = `${player.id === room.hostSocketId ? '👑 ' : ''}${player.name}${player.isGuest ? ' · Guest' : ''}`;
        const meta = document.createElement('div');
        meta.className = 'text-[9px] text-blue-200';
        meta.textContent = player.ready ? '✅ Ready' : '⏳ Not ready';
        left.append(name, meta);
        identity.append(avatar, left);
        wrap.appendChild(identity);

        if (hostView && player.id !== socket.id) {
            const kick = document.createElement('button');
            kick.className = 'text-[9px] bg-red-600 hover:bg-red-500 text-white font-bold px-2 py-1 rounded-lg';
            kick.textContent = 'KICK';
            kick.onclick = () => socket.emit('kick_lobby_player', {
                roomId: room.roomId,
                targetSocketId: player.id
            });
            wrap.appendChild(kick);
        }
        return wrap;
    }

    updatePreGameLobbyUI = function (room) {
        if (!room) return;
        const list = document.getElementById('preGamePlayerList');
        if (!list) return;
        list.replaceChildren();
        const hostView = room.hostSocketId === socket.id;
        (room.players || []).forEach(player => list.appendChild(playerLine(player, room, hostView)));

        const heading = document.querySelector('#preGameLobbyModal h4');
        if (heading) heading.textContent = `👥 PLAYERS (${room.players?.length || 0}/${room.maxPlayers || '?'})`;

        const meta = document.getElementById('preGameLobbyMeta');
        if (meta) {
            const ready = (room.players || []).filter(p => p.ready).length;
            meta.textContent = `${String(room.mode || '').toUpperCase()} · ${ready}/${room.players?.length || 0} ready · ${room.isPublic === false ? 'Private' : 'Public'} · Host: ${room.hostName}`;
        }

        const me = localMember(room);
        const readyButton = document.getElementById('preGameReadyButton');
        if (readyButton) readyButton.textContent = me?.ready ? '↩ NOT READY' : '✓ READY';
    };

    function renderDockPlayers(room) {
        const list = document.getElementById('gameDockPlayerList');
        if (!list) return;
        list.replaceChildren();
        const hostView = room.hostSocketId === socket.id;
        (room.players || []).forEach(player => list.appendChild(playerLine(player, room, hostView)));

        let hostControls = document.getElementById('dockHostControls');
        if (!hostControls) {
            hostControls = document.createElement('div');
            hostControls.id = 'dockHostControls';
            hostControls.className = 'dock-card mt-2';
            document.getElementById('dockLobbyPanel')?.appendChild(hostControls);
        }

        if (hostView) {
            hostControls.classList.remove('hidden');
            hostControls.innerHTML = `
                <span class="dock-label">Host controls</span>
                <button id="dockPrivacyButton" class="dock-action">${room.isPublic === false ? '🔒 MAKE PUBLIC' : '🌐 MAKE PRIVATE'}</button>
            `;
            document.getElementById('dockPrivacyButton').onclick = () => socket.emit('toggle_room_privacy', {
                roomId: room.roomId,
                isPublic: room.isPublic === false
            });
        } else {
            hostControls.classList.add('hidden');
        }
    }

    function refreshRoomUI(room) {
        if (!room) return;
        activeRoomData = room;

        const players = Array.isArray(room.players) ? room.players : [];
        const readyCount = players.filter(player => player.ready).length;
        const code = roomCodeFromUrl(room.smashUrl);
        const me = localMember(room);

        const count = document.getElementById('gameLobbyPlayerCount');
        if (count) count.textContent = `👥 ${players.length}/${room.maxPlayers || '?'} IN LOBBY`;

        const names = document.getElementById('gameLobbyPlayerNames');
        if (names) {
            const text = players.length ? players.map(p => p.name).join(', ') : 'No active players';
            names.textContent = text;
            names.title = text;
        }

        const badge = document.getElementById('gameModeBadge');
        if (badge) badge.textContent = String(room.mode || '').toUpperCase();

        currentRoomCode = code;
        const display = document.getElementById('gameRoomCodeDisplay');
        if (display) display.textContent = code || (room.mode === 'ffa' ? 'NOT SET' : '------');

        const summary = document.getElementById('dockLobbySummary');
        if (summary) summary.textContent = `${String(room.mode || '').toUpperCase()} · ${players.length}/${room.maxPlayers || '?'} players · ${room.isPublic === false ? 'Private' : 'Public'}`;

        const readySummary = document.getElementById('dockReadySummary');
        if (readySummary) readySummary.textContent = `${readyCount}/${players.length} ready · Host: ${room.hostName}`;

        const readyButton = document.getElementById('dockReadyButton');
        if (readyButton) readyButton.textContent = me?.ready ? '↩ NOT READY' : '✓ READY';

        const teamControls = document.getElementById('dockTeamControls');
        if (teamControls) teamControls.classList.add('hidden');

        renderDockPlayers(room);
        if (!document.getElementById('preGameLobbyModal')?.classList.contains('hidden')) {
            updatePreGameLobbyUI(room);
        }
    }

    window.toggleMyReadyStatus = function () {
        if (!activeRoomData) return showToast('You are not in a lobby.', 'ℹ️');
        const me = localMember(activeRoomData);
        socket.emit('set_ready_status', {
            roomId: activeRoomData.roomId,
            ready: !me?.ready
        });
    };

    window.chooseLobbyTeam = function (team) {
        if (!activeRoomData) return;
        socket.emit('set_lobby_team', { roomId: activeRoomData.roomId, team });
    };

    window.sendLobbyReaction = function (reaction) {
        if (!activeRoomData) return;
        socket.emit('lobby_reaction', { roomId: activeRoomData.roomId, reaction });
    };

    function parseSmashShareInput(raw) {
        if (!raw) return null;
        const text = String(raw).trim().replace(/["']/g, '');
        const valid = code => /^[A-Za-z0-9]{4,16}$/.test(code || '') && /[A-Za-z]/.test(code) && /\d/.test(code);

        const fullLink = text.match(/https?:\/\/(?:www\.)?smashkarts\.io\/link\/?\?[^\s]+/i)
            || text.match(/https?:\/\/(?:www\.)?smashkarts\.io\/?\?[^\s]+/i);

        if (fullLink) {
            try {
                const url = new URL(fullLink[0]);
                const code = url.searchParams.get('room');
                if (['smashkarts.io', 'www.smashkarts.io'].includes(url.hostname.toLowerCase()) && valid(code)) {
                    return { code, url: fullLink[0] };
                }
            } catch {}
        }

        const label = text.match(/Room:\s*([A-Za-z0-9]+)/i);
        if (label && valid(label[1])) {
            return {
                code: label[1],
                url: `https://smashkarts.io/link/?room=${encodeURIComponent(label[1])}`
            };
        }

        if (valid(text)) {
            return {
                code: text,
                url: `https://smashkarts.io/link/?room=${encodeURIComponent(text)}`
            };
        }

        return null;
    }

    window.pasteCodeIntoCurrentLobby = function () {
        if (!activeRoomData) return showToast('You are not currently in a lobby.', '⚠️');
        const raw = window.prompt(
            'Paste the room code, full Smash Karts link, or the whole “Come play Smash Karts” share message:'
        );
        if (raw == null) return;

        const parsed = parseSmashShareInput(raw);
        if (!parsed) {
            return showToast('I could not find a valid Smash Karts room in that paste. Nothing changed.', '❌');
        }

        // The server keeps the FULL link for popup mode (arena/rules/etc.)
        // while the blue toolbar continues to show only the room code.
        socket.emit('update_lobby_game_code', {
            roomId: activeRoomData.roomId,
            code: raw
        });
    };

    // Better copy behavior for FFA before a real code has been pasted.
    copyActiveRoomCode = function (code) {
        const value = code || currentRoomCode || roomCodeFromUrl(activeRoomData?.smashUrl);
        if (!value) return showToast('No Smash Karts room code has been set yet.', 'ℹ️');
        navigator.clipboard?.writeText(value)
            .then(() => showToast(`Room code (${value}) copied!`, '📋'))
            .catch(() => showToast('Could not copy the room code.', '❌'));
    };

    // Make every pre-game lobby exclusive and refresh all player data.
    const originalOpenPreGameLobby = openPreGameLobby;
    openPreGameLobby = function (room) {
        closeExclusiveModals('preGameLobbyModal');
        originalOpenPreGameLobby(room);
        refreshRoomUI(room);
        const title = document.querySelector('#preGameLobbyModal h3');
        if (title) title.textContent = room.mode === 'ffa' ? '🔥 FFA LOBBY' : '👥 MATCH LOBBY';
    };

    // Game enter/exit: open a clean screen with NO stacked panels.
    const originalEnterGame = enterGameFromLobby;
    enterGameFromLobby = function (...args) {
        const result = originalEnterGame.apply(this, args);
        closeExclusiveModals();
        closeGameDock();
        setArenaToolbarOpen?.(true);
        if (activeRoomData) refreshRoomUI(activeRoomData);
        return result;
    };

    const originalLeaveGame = leaveEmbeddedGame;
    leaveEmbeddedGame = function (...args) {
        closeGameDock();
        setArenaToolbarOpen?.(false);
        return originalLeaveGame.apply(this, args);
    };

    // ---------------------------------------------------------------------
    // SPOTIFY HYBRID MODE
    // One normal Spotify connection for both account types:
    // - Premium: Web Playback SDK + in-site play/pause/skip/search.
    // - Free: same in-site search/library API, but songs load into Spotify's
    //   official Embed player instead of the Premium-only playback SDK.
    // ---------------------------------------------------------------------
    const SPOTIFY_TOKEN_KEY = 'sk_spotify_token_v3';
    const SPOTIFY_VERIFIER_KEY = 'sk_spotify_pkce_verifier_v3';
    const SPOTIFY_STATE_KEY = 'sk_spotify_oauth_state_v3';
    const SPOTIFY_DEFAULT_EMBED = 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M?utm_source=generator&theme=0';

    let spotifyPlayer = null;
    let spotifyDeviceId = null;
    let spotifySdkLoading = false;
    let spotifyCurrent = { track: null, paused: true };
    let spotifyLastResults = [];
    let spotifyFreeQueue = [];
    let spotifyFreeQueueIndex = -1;
    let spotifyFreeTrack = null;
    let spotifyAccountProduct = null;
    let spotifyWebWindow = null;
    let spotifyClientIdCache = String(window.__SPOTIFY_CLIENT_ID__ || '').trim();

    function spotifyClientId() {
        return spotifyClientIdCache || String(window.__SPOTIFY_CLIENT_ID__ || '').trim();
    }

    async function ensureSpotifyClientId() {
        const existing = spotifyClientId();
        if (existing) return existing;

        try {
            const response = await fetch('/api/spotify-config?ts=' + Date.now(), {
                cache: 'no-store',
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) return '';
            const data = await response.json();
            spotifyClientIdCache = String(data?.clientId || '').trim();
            window.__SPOTIFY_CLIENT_ID__ = spotifyClientIdCache;
            return spotifyClientIdCache;
        } catch {
            return '';
        }
    }

    function spotifyRedirectUri() {
        return `${location.origin}${location.pathname}`;
    }

    function spotifyReadTokens() {
        return readJSON(SPOTIFY_TOKEN_KEY, null);
    }

    function spotifyWriteTokens(data) {
        if (!data) {
            localStorage.removeItem(SPOTIFY_TOKEN_KEY);
            return;
        }
        writeJSON(SPOTIFY_TOKEN_KEY, data);
    }

    function spotifyIsConnected() {
        const token = spotifyReadTokens();
        return !!(token && (token.access_token || token.refresh_token));
    }

    function spotifyIsPremium() {
        return spotifyAccountProduct === 'premium';
    }

    function spotifyRandomString(length = 64) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => chars[byte % chars.length]).join('');
    }

    async function spotifyChallenge(verifier) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        return btoa(String.fromCharCode(...new Uint8Array(digest)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    async function spotifyAccessToken() {
        let token = spotifyReadTokens();
        if (!token) return null;
        if (token.access_token && Number(token.expires_at || 0) > Date.now() + 60000) {
            return token.access_token;
        }
        if (!token.refresh_token) return null;

        const clientId = await ensureSpotifyClientId();
        if (!clientId) return null;

        const body = new URLSearchParams({
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: token.refresh_token
        });

        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        if (!response.ok) {
            spotifyWriteTokens(null);
            spotifyAccountProduct = null;
            renderSpotifyEverywhere();
            return null;
        }

        const fresh = await response.json();
        token = {
            ...token,
            ...fresh,
            refresh_token: fresh.refresh_token || token.refresh_token,
            expires_at: Date.now() + Number(fresh.expires_in || 3600) * 1000
        };
        spotifyWriteTokens(token);
        return token.access_token;
    }

    async function spotifyApi(path, options = {}) {
        const token = await spotifyAccessToken();
        if (!token) throw new Error('Spotify is not connected.');

        const headers = new Headers(options.headers || {});
        headers.set('Authorization', `Bearer ${token}`);
        if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

        const response = await fetch(`https://api.spotify.com/v1${path}`, {
            ...options,
            headers
        });

        if (response.status === 204) return null;
        if (!response.ok) {
            let message = `Spotify request failed (${response.status})`;
            try {
                const body = await response.json();
                message = body?.error?.message || message;
            } catch {}
            throw new Error(message);
        }
        return response.json();
    }

    async function spotifyDetectAccountProduct() {
        if (!spotifyIsConnected()) {
            spotifyAccountProduct = null;
            return null;
        }
        try {
            const me = await spotifyApi('/me');
            spotifyAccountProduct = String(me?.product || 'free').toLowerCase();
        } catch {
            spotifyAccountProduct = spotifyAccountProduct || 'free';
        }
        renderSpotifyEverywhere();
        return spotifyAccountProduct;
    }

    function spotifyStatusText() {
        if (!spotifyClientId()) return 'Spotify setup needed by site owner';
        if (!spotifyIsConnected()) return 'Connect Spotify · Free and Premium supported';
        if (spotifyIsPremium()) {
            return spotifyDeviceId ? 'Premium · full player connected' : 'Premium · starting player…';
        }
        return 'Free account · official Spotify player';
    }

    function spotifyActiveTrack() {
        return spotifyIsPremium() ? spotifyCurrent.track : spotifyFreeTrack;
    }

    function spotifyTrackInfo() {
        const track = spotifyActiveTrack();
        return {
            title: track?.name || 'Spotify',
            artist: track?.artists?.map(a => a.name).join(', ') || (spotifyIsConnected() ? 'Search for something to play' : 'Connect Spotify to search your account'),
            art: track?.album?.images?.[0]?.url || ''
        };
    }

    function setImage(id, src) {
        const img = document.getElementById(id);
        if (!img) return;
        if (src) {
            img.src = src;
            img.style.visibility = 'visible';
        } else {
            img.removeAttribute('src');
            img.style.visibility = 'hidden';
        }
    }

    function spotifyEmbedForTrack(track) {
        const id = track?.id;
        return id
            ? `https://open.spotify.com/embed/track/${encodeURIComponent(id)}?utm_source=generator&theme=0`
            : SPOTIFY_DEFAULT_EMBED;
    }

    function updateSpotifyEmbeds() {
        const src = spotifyEmbedForTrack(spotifyFreeTrack);
        for (const id of ['spotifyPageEmbed', 'spotifyDockEmbed']) {
            const frame = document.getElementById(id);
            if (frame && frame.src !== src) frame.src = src;
        }
    }

    function renderSpotifyEverywhere() {
        const info = spotifyTrackInfo();
        const status = spotifyStatusText();
        const connected = spotifyIsConnected();
        const premium = spotifyIsPremium();
        const playIcon = premium && !spotifyCurrent.paused ? '⏸' : '▶';

        ['spotifyPageStatus', 'spotifyDockStatus', 'spotifySettingsStatus'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = status;
        });

        ['spotifyPageTrack', 'spotifyDockTrack'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = info.title;
        });
        ['spotifyPageArtist', 'spotifyDockArtist'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = info.artist;
        });

        const miniTrack = document.getElementById('spotifyMiniTrack');
        if (miniTrack) {
            miniTrack.textContent = `🎵 ${info.title}`;
            miniTrack.title = connected ? `${info.title} — ${info.artist}` : 'Open Spotify';
        }

        setImage('spotifyPageArt', info.art);
        setImage('spotifyDockArt', info.art);

        ['spotifyPagePlayButton', 'spotifyDockPlayButton'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = playIcon;
        });

        ['spotifyPageConnectButton', 'spotifyDockConnectButton', 'spotifySettingsConnectButton'].forEach(id => {
            const button = document.getElementById(id);
            if (!button) return;
            button.textContent = !connected
                ? 'CONNECT SPOTIFY'
                : premium
                    ? 'PREMIUM CONNECTED'
                    : 'FREE CONNECTED';
        });

        const pageFree = document.getElementById('spotifyFreePlayerWrap');
        const dockFree = document.getElementById('spotifyDockFreePlayerWrap');
        pageFree?.classList.toggle('hidden', premium);
        dockFree?.classList.toggle('hidden', premium);
        if (!premium) updateSpotifyEmbeds();
    }

    function syncMainSettings() {
        const pref = readJSON(PREF_KEY, {});
        const gameplay = document.getElementById('settingsGameplayMode');
        if (gameplay) gameplay.value = pref.gameplay || currentGameplayMode || 'popup';
        renderSpotifyEverywhere();
    }

    window.saveMainSettings = function () {
        const gameplay = document.getElementById('settingsGameplayMode')?.value === 'embed' ? 'embed' : 'popup';
        currentGameplayMode = gameplay;
        updateGameplayMode(gameplay);
        const pref = readJSON(PREF_KEY, {});
        pref.gameplay = gameplay;
        writeJSON(PREF_KEY, pref);
        const originalSelect = document.getElementById('gameplayModeSelect');
        if (originalSelect) originalSelect.value = gameplay;
        showToast('Settings saved.', '⚙️');
    };

    window.spotifyConnect = async function () {
        const clientId = await ensureSpotifyClientId();
        if (!clientId) {
            showToast('Spotify needs the site-wide Client ID set once by the site owner.', '🎵');
            if (typeof openSpotifySetupInfo === 'function') openSpotifySetupInfo();
            return;
        }

        if (spotifyIsConnected()) {
            await spotifyDetectAccountProduct();
            if (spotifyIsPremium()) {
                try { await ensureSpotifyPlayer(); } catch {}
            }
            renderSpotifyEverywhere();
            return;
        }

        const verifier = spotifyRandomString(64);
        const state = spotifyRandomString(24);
        localStorage.setItem(SPOTIFY_VERIFIER_KEY, verifier);
        localStorage.setItem(SPOTIFY_STATE_KEY, state);
        const challenge = await spotifyChallenge(verifier);

        const scopes = [
            'streaming',
            'user-read-email',
            'user-read-private',
            'user-read-playback-state',
            'user-modify-playback-state',
            'user-read-currently-playing',
            'playlist-read-private',
            'user-library-read',
            'user-read-recently-played'
        ].join(' ');

        const params = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: spotifyRedirectUri(),
            scope: scopes,
            code_challenge_method: 'S256',
            code_challenge: challenge,
            state
        });
        location.href = `https://accounts.spotify.com/authorize?${params}`;
    };

    async function handleSpotifyOAuthCallback() {
        const params = new URLSearchParams(location.search);
        const code = params.get('code');
        const returnedState = params.get('state');
        if (!code) return;

        const expectedState = localStorage.getItem(SPOTIFY_STATE_KEY);
        const verifier = localStorage.getItem(SPOTIFY_VERIFIER_KEY);
        const clientId = await ensureSpotifyClientId();

        if (!clientId || !verifier || !expectedState || returnedState !== expectedState) {
            showToast('Spotify login could not be verified. Try connecting again.', '❌');
            return;
        }

        const body = new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            code,
            redirect_uri: spotifyRedirectUri(),
            code_verifier: verifier
        });

        try {
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            });
            if (!response.ok) throw new Error('Spotify token exchange failed.');
            const token = await response.json();
            spotifyWriteTokens({
                ...token,
                expires_at: Date.now() + Number(token.expires_in || 3600) * 1000
            });
            localStorage.removeItem(SPOTIFY_STATE_KEY);
            localStorage.removeItem(SPOTIFY_VERIFIER_KEY);
            history.replaceState({}, document.title, spotifyRedirectUri());
            await spotifyDetectAccountProduct();
            if (spotifyIsPremium()) {
                try { await ensureSpotifyPlayer(); } catch {}
            }
            showToast(spotifyIsPremium()
                ? 'Spotify Premium connected — full controls enabled.'
                : 'Spotify Free connected — search and official player enabled.', '🎵');
        } catch (error) {
            showToast(error.message || 'Spotify connection failed.', '❌');
        }
        renderSpotifyEverywhere();
    }

    function loadSpotifySdk() {
        if (window.Spotify?.Player) return Promise.resolve();
        if (spotifySdkLoading) {
            return new Promise(resolve => {
                const wait = setInterval(() => {
                    if (window.Spotify?.Player) {
                        clearInterval(wait);
                        resolve();
                    }
                }, 100);
            });
        }

        spotifySdkLoading = true;
        return new Promise((resolve, reject) => {
            window.onSpotifyWebPlaybackSDKReady = () => {
                spotifySdkLoading = false;
                resolve();
            };
            const tag = document.createElement('script');
            tag.src = 'https://sdk.scdn.co/spotify-player.js';
            tag.async = true;
            tag.onerror = () => {
                spotifySdkLoading = false;
                reject(new Error('Could not load Spotify Web Playback SDK.'));
            };
            document.head.appendChild(tag);
        });
    }

    async function ensureSpotifyPlayer() {
        if (!spotifyIsConnected() || !spotifyIsPremium()) return null;
        if (spotifyPlayer) return spotifyPlayer;

        await loadSpotifySdk();
        const token = await spotifyAccessToken();
        if (!token) return null;

        spotifyPlayer = new window.Spotify.Player({
            name: 'SmashKarts Arena Player',
            getOAuthToken: async cb => cb(await spotifyAccessToken()),
            volume: 0.65
        });

        spotifyPlayer.addListener('ready', async ({ device_id }) => {
            spotifyDeviceId = device_id;
            renderSpotifyEverywhere();
            try {
                await spotifyApi('/me/player', {
                    method: 'PUT',
                    body: JSON.stringify({ device_ids: [device_id], play: false })
                });
            } catch {}
        });

        spotifyPlayer.addListener('not_ready', ({ device_id }) => {
            if (spotifyDeviceId === device_id) spotifyDeviceId = null;
            renderSpotifyEverywhere();
        });

        spotifyPlayer.addListener('player_state_changed', state => {
            if (!state) return;
            spotifyCurrent = {
                track: state.track_window?.current_track || null,
                paused: !!state.paused
            };
            renderSpotifyEverywhere();
        });

        spotifyPlayer.addListener('account_error', ({ message }) => {
            spotifyAccountProduct = 'free';
            try { spotifyPlayer?.disconnect(); } catch {}
            spotifyPlayer = null;
            spotifyDeviceId = null;
            renderSpotifyEverywhere();
            showToast(message || 'Spotify switched to Free player mode.', '🎵');
        });

        for (const eventName of ['initialization_error', 'authentication_error', 'playback_error']) {
            spotifyPlayer.addListener(eventName, ({ message }) => {
                showToast(message || 'Spotify player error.', '❌');
            });
        }

        await spotifyPlayer.connect();
        return spotifyPlayer;
    }

    window.spotifyDisconnect = function () {
        try { spotifyPlayer?.disconnect(); } catch {}
        spotifyPlayer = null;
        spotifyDeviceId = null;
        spotifyCurrent = { track: null, paused: true };
        spotifyFreeTrack = null;
        spotifyFreeQueue = [];
        spotifyFreeQueueIndex = -1;
        spotifyAccountProduct = null;
        spotifyWriteTokens(null);
        renderSpotifyEverywhere();
        showToast('Spotify disconnected.', '🎵');
    };

    async function ensurePremiumSpotifyReady() {
        if (!spotifyIsConnected()) {
            spotifyConnect();
            return false;
        }
        if (!spotifyIsPremium()) return false;
        try {
            await ensureSpotifyPlayer();
            if (!spotifyDeviceId) {
                showToast('Spotify is connecting. Try again in a moment.', '🎵');
                return false;
            }
            return true;
        } catch (error) {
            showToast(error.message || 'Spotify is unavailable.', '❌');
            return false;
        }
    }

    function selectFreeTrack(track, queue = spotifyLastResults) {
        if (!track) return;
        spotifyFreeTrack = track;
        spotifyFreeQueue = Array.isArray(queue) ? queue.slice() : [];
        spotifyFreeQueueIndex = spotifyFreeQueue.findIndex(item => item?.id === track.id);
        updateSpotifyEmbeds();
        renderSpotifyEverywhere();
    }

    window.spotifyTogglePlayback = async function () {
        if (!spotifyIsConnected()) return spotifyConnect();
        if (!spotifyIsPremium()) {
            if (document.getElementById('gameScreen')?.classList.contains('hidden')) openMusicPage();
            else openGameDock('music');
            showToast('Use the play button in the Spotify player.', '🎵');
            return;
        }
        if (!(await ensurePremiumSpotifyReady())) return;
        try {
            if (spotifyCurrent.paused) await spotifyPlayer.resume();
            else await spotifyPlayer.pause();
        } catch (error) {
            showToast(error.message || 'Could not change playback.', '❌');
        }
    };

    window.spotifyNextTrack = async function () {
        if (!spotifyIsConnected()) return spotifyConnect();
        if (!spotifyIsPremium()) {
            if (spotifyFreeQueue.length && spotifyFreeQueueIndex + 1 < spotifyFreeQueue.length) {
                spotifyFreeQueueIndex += 1;
                selectFreeTrack(spotifyFreeQueue[spotifyFreeQueueIndex], spotifyFreeQueue);
                return;
            }
            if (document.getElementById('gameScreen')?.classList.contains('hidden')) openMusicPage();
            else openGameDock('music');
            showToast('Search a few songs first, then ⏭ moves through those results.', '🎵');
            return;
        }
        if (!(await ensurePremiumSpotifyReady())) return;
        try {
            await spotifyApi(`/me/player/next?device_id=${encodeURIComponent(spotifyDeviceId)}`, { method: 'POST' });
        } catch (error) {
            showToast(error.message || 'Could not skip song.', '❌');
        }
    };

    window.spotifyPreviousTrack = async function () {
        if (!spotifyIsConnected()) return spotifyConnect();
        if (!spotifyIsPremium()) {
            if (spotifyFreeQueue.length && spotifyFreeQueueIndex > 0) {
                spotifyFreeQueueIndex -= 1;
                selectFreeTrack(spotifyFreeQueue[spotifyFreeQueueIndex], spotifyFreeQueue);
                return;
            }
            if (document.getElementById('gameScreen')?.classList.contains('hidden')) openMusicPage();
            else openGameDock('music');
            return;
        }
        if (!(await ensurePremiumSpotifyReady())) return;
        try {
            await spotifyApi(`/me/player/previous?device_id=${encodeURIComponent(spotifyDeviceId)}`, { method: 'POST' });
        } catch (error) {
            showToast(error.message || 'Could not go to the previous song.', '❌');
        }
    };

    window.spotifyPlayUri = async function (uri) {
        if (!spotifyIsConnected()) return spotifyConnect();
        if (!spotifyIsPremium()) {
            const track = spotifyLastResults.find(item => item?.uri === uri);
            if (track) selectFreeTrack(track, spotifyLastResults);
            else openMusicPage();
            return;
        }
        if (!(await ensurePremiumSpotifyReady())) return;
        try {
            await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(spotifyDeviceId)}`, {
                method: 'PUT',
                body: JSON.stringify({ uris: [uri] })
            });
        } catch (error) {
            showToast(error.message || 'Could not play that song.', '❌');
        }
    };

    function renderSpotifyResults(targetId, tracks) {
        const container = document.getElementById(targetId);
        if (!container) return;
        container.replaceChildren();

        if (!tracks.length) {
            const empty = document.createElement('div');
            empty.className = 'text-xs text-gray-400 p-3';
            empty.textContent = 'No songs found.';
            container.appendChild(empty);
            return;
        }

        tracks.forEach(track => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'spotify-result text-left';
            row.onclick = () => {
                if (spotifyIsPremium()) spotifyPlayUri(track.uri);
                else selectFreeTrack(track, tracks);
            };

            const image = document.createElement('img');
            image.alt = '';
            if (track.album?.images?.[0]?.url) image.src = track.album.images[0].url;

            const copy = document.createElement('div');
            copy.className = 'min-w-0';
            const title = document.createElement('div');
            title.className = 'spotify-result-title';
            title.textContent = track.name || 'Unknown track';
            const sub = document.createElement('div');
            sub.className = 'spotify-result-sub';
            sub.textContent = `${track.artists?.map(a => a.name).join(', ') || 'Unknown artist'} · ${track.album?.name || ''}`;
            copy.append(title, sub);

            const play = document.createElement('span');
            play.className = 'spotify-control primary flex items-center justify-center';
            play.textContent = '▶';

            row.append(image, copy, play);
            container.appendChild(row);
        });
    }

    window.spotifySearch = async function (surface = 'page') {
        const inputId = surface === 'dock' ? 'spotifyDockSearchInput' : 'spotifyPageSearchInput';
        const resultId = surface === 'dock' ? 'spotifyDockResults' : 'spotifyPageResults';
        const query = String(document.getElementById(inputId)?.value || '').trim();
        if (!query) return;
        if (!spotifyIsConnected()) {
            spotifyConnect();
            return;
        }

        const target = document.getElementById(resultId);
        if (target) target.textContent = 'Searching Spotify…';

        try {
            const data = await spotifyApi(`/search?q=${encodeURIComponent(query)}&type=track&limit=12`);
            spotifyLastResults = data?.tracks?.items || [];
            renderSpotifyResults(resultId, spotifyLastResults);
            const otherId = surface === 'dock' ? 'spotifyPageResults' : 'spotifyDockResults';
            renderSpotifyResults(otherId, spotifyLastResults);
        } catch (error) {
            if (target) target.textContent = error.message || 'Spotify search failed.';
        }
    };

    window.spotifyShowView = function (view = 'search') {
        const ids = {
            search: 'spotifySearchView',
            playlists: 'spotifyPlaylistsView',
            recent: 'spotifyRecentView'
        };
        Object.entries(ids).forEach(([key, id]) => {
            document.getElementById(id)?.classList.toggle('hidden', key !== view);
        });
        const navIds = {
            search: 'spotifyNavSearch',
            playlists: 'spotifyNavPlaylists',
            recent: 'spotifyNavRecent'
        };
        Object.entries(navIds).forEach(([key, id]) => {
            document.getElementById(id)?.classList.toggle('active', key === view);
        });
        if (view === 'playlists') spotifyLoadPlaylists();
        if (view === 'recent') spotifyLoadRecent();
    };

    function renderSpotifyPlaylists(playlists) {
        const container = document.getElementById('spotifyPlaylistResults');
        if (!container) return;
        container.replaceChildren();
        if (!playlists.length) {
            const empty = document.createElement('div');
            empty.className = 'text-xs text-gray-400 p-3';
            empty.textContent = 'No playlists found.';
            container.appendChild(empty);
            return;
        }

        playlists.forEach(playlist => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'spotify-playlist';
            row.onclick = () => spotifyOpenPlaylist(playlist.id, playlist.name);

            const image = document.createElement('img');
            image.alt = '';
            if (playlist.images?.[0]?.url) image.src = playlist.images[0].url;

            const copy = document.createElement('div');
            copy.className = 'min-w-0';
            const title = document.createElement('div');
            title.className = 'spotify-result-title';
            title.textContent = playlist.name || 'Playlist';
            const sub = document.createElement('div');
            sub.className = 'spotify-result-sub';
            sub.textContent = `${playlist.tracks?.total ?? 0} songs · ${playlist.owner?.display_name || 'Spotify'}`;
            copy.append(title, sub);
            row.append(image, copy);
            container.appendChild(row);
        });
    }

    window.spotifyLoadPlaylists = async function () {
        const container = document.getElementById('spotifyPlaylistResults');
        if (!spotifyIsConnected()) return spotifyConnect();
        if (container) container.textContent = 'Loading your playlists…';
        try {
            const data = await spotifyApi('/me/playlists?limit=30');
            renderSpotifyPlaylists(data?.items || []);
        } catch (error) {
            if (container) container.textContent = error.message || 'Could not load playlists.';
        }
    };

    window.spotifyOpenPlaylist = async function (playlistId, playlistName = 'Playlist') {
        const container = document.getElementById('spotifyPlaylistResults');
        if (!playlistId || !container) return;
        container.textContent = `Loading ${playlistName}…`;
        try {
            const data = await spotifyApi(`/playlists/${encodeURIComponent(playlistId)}/tracks?limit=50`);
            const tracks = (data?.items || []).map(item => item.track).filter(Boolean);
            spotifyLastResults = tracks;
            renderSpotifyResults('spotifyPlaylistResults', tracks);
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'spotify-nav-button';
            back.style.marginBottom = '8px';
            back.textContent = `← Back to playlists · ${playlistName}`;
            back.onclick = () => spotifyLoadPlaylists();
            container.prepend(back);
        } catch (error) {
            container.textContent = error.message || 'Could not open that playlist.';
        }
    };

    window.spotifyLoadRecent = async function () {
        const container = document.getElementById('spotifyRecentResults');
        if (!spotifyIsConnected()) return spotifyConnect();
        if (container) container.textContent = 'Loading recently played…';
        try {
            const data = await spotifyApi('/me/player/recently-played?limit=30');
            const seen = new Set();
            const tracks = [];
            for (const item of data?.items || []) {
                const track = item.track;
                if (!track?.id || seen.has(track.id)) continue;
                seen.add(track.id);
                tracks.push(track);
            }
            spotifyLastResults = tracks;
            renderSpotifyResults('spotifyRecentResults', tracks);
        } catch (error) {
            if (container) container.textContent = error.message || 'Could not load recently played music.';
        }
    };

    window.openSpotifyWebsite = function (targetUrl = 'https://open.spotify.com/') {
        try {
            if (spotifyWebWindow && !spotifyWebWindow.closed) {
                spotifyWebWindow.location.href = targetUrl;
                spotifyWebWindow.focus();
                return;
            }
        } catch {}
        spotifyWebWindow = window.open(
            targetUrl,
            'smashkarts_spotify_web',
            'width=1100,height=760,resizable=yes,scrollbars=yes'
        );
        if (!spotifyWebWindow) window.open(targetUrl, '_blank', 'noopener,noreferrer');
    };

    ensureSpotifyClientId().finally(() => renderSpotifyEverywhere());

    handleSpotifyOAuthCallback().then(async () => {
        if (spotifyIsConnected()) {
            await spotifyDetectAccountProduct();
            if (spotifyIsPremium()) {
                try { await ensureSpotifyPlayer(); } catch {}
            }
        }
        renderSpotifyEverywhere();
    });

    // ---------------------------------------------------------------------
    // HUB: HISTORY / NOTES / SETTINGS / UTILITIES
    // ---------------------------------------------------------------------
    window.requestSavedHistory = function () {
        const list = document.getElementById('hubHistoryList');
        if (!isRealAccount()) {
            if (list) list.textContent = 'Log in to save and view permanent match history.';
            return;
        }
        if (list) list.textContent = 'Loading saved matches…';
        socket.emit('get_saved_match_history');
    };

    socket.off('saved_match_history');
    socket.on('saved_match_history', rooms => {
        const list = document.getElementById('hubHistoryList');
        if (!list) return;
        list.replaceChildren();
        if (!rooms.length) {
            list.textContent = 'No saved matches yet.';
            return;
        }
        rooms.slice(0, 50).forEach(room => {
            const card = document.createElement('details');
            card.className = 'bg-blue-950/70 border border-white/10 rounded-xl p-3';
            const summary = document.createElement('summary');
            summary.className = 'cursor-pointer font-bold text-white';
            summary.textContent = `${new Date(room.createdAt || Date.now()).toLocaleString()} · ${String(room.mode || '').toUpperCase()} · ${(room.participants || []).join(', ')}`;
            card.appendChild(summary);
            (room.messages || []).slice(-30).forEach(message => {
                const p = document.createElement('p');
                p.className = 'text-[11px] text-blue-100 mt-1';
                p.textContent = `${message.senderName}: ${message.message}`;
                card.appendChild(p);
            });
            list.appendChild(card);
        });
    });

    function loadArenaNotes() {
        const input = document.getElementById('hubNotesInput');
        if (input) input.value = localStorage.getItem(NOTES_KEY) || '';
    }

    window.saveArenaNotes = function () {
        localStorage.setItem(NOTES_KEY, document.getElementById('hubNotesInput')?.value || '');
        showToast('Notes saved on this browser.', '📝');
    };

    window.clearArenaNotes = function () {
        localStorage.removeItem(NOTES_KEY);
        const input = document.getElementById('hubNotesInput');
        if (input) input.value = '';
        showToast('Notes cleared.', '🗑️');
    };

    function syncHubSettings() { syncMainSettings(); }

    window.applyHubGameplayMode = function () { saveMainSettings(); };

    window.rollArenaDice = function () {
        showToast(`You rolled a ${1 + Math.floor(Math.random() * 6)}.`, '🎲');
    };

    window.flipArenaCoin = function () {
        showToast(Math.random() < .5 ? 'Heads!' : 'Tails!', '🪙');
    };

    window.toggleArenaFullscreen = async function () {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await document.documentElement.requestFullscreen();
        } catch {
            showToast('Fullscreen is unavailable in this browser.', 'ℹ️');
        }
    };

    // ---------------------------------------------------------------------
    // PUBLIC LOBBIES - organized search/filter list
    // ---------------------------------------------------------------------
    function renderPublicRooms(rooms) {
        publicRoomsCache = Array.isArray(rooms) ? rooms : [];
        const container = document.getElementById('publicRoomsList');
        if (!container) return;

        const search = String(document.getElementById('publicRoomSearch')?.value || '').toLowerCase().trim();
        const filtered = publicRoomsCache.filter(room => {
            if (room.mode === '2v2') return false;
            if (!search) return true;
            return `${room.hostName} ${room.mode} ${room.winCondition}`.toLowerCase().includes(search);
        });

        container.replaceChildren();
        if (!filtered.length) {
            const empty = document.createElement('p');
            empty.className = 'text-center text-xs text-blue-200 py-4';
            empty.textContent = 'No matching public lobbies.';
            container.appendChild(empty);
            return;
        }

        filtered.forEach(room => {
            const row = document.createElement('div');
            row.className = 'flex justify-between items-center gap-3 bg-blue-950/80 p-3 rounded-2xl border border-white/10';
            const info = document.createElement('div');
            const ready = (room.players || []).filter(p => p.ready).length;
            info.innerHTML = `
                <p class="text-xs text-white font-bold">${escapeHTML(room.hostName)} · ${escapeHTML(String(room.mode).toUpperCase())}</p>
                <p class="text-[10px] text-blue-200">${room.players?.length || 0}/${room.maxPlayers || '?'} players · ${ready} ready · ${escapeHTML(room.winCondition || '')}</p>
            `;
            const join = document.createElement('button');
            join.className = 'bg-emerald-500 hover:bg-emerald-400 text-white font-black px-3 py-2 rounded-xl text-xs';
            join.textContent = 'JOIN';
            join.onclick = () => socket.emit('join_public_room', { roomId: room.roomId });
            row.append(info, join);
            container.appendChild(row);
        });
    }

    socket.off('public_rooms_update');
    socket.on('public_rooms_update', renderPublicRooms);
    document.getElementById('publicRoomSearch')?.addEventListener('input', () => renderPublicRooms(publicRoomsCache));

    // ---------------------------------------------------------------------
    // SOCKET ROOM EVENTS
    // ---------------------------------------------------------------------
    function acceptRoom(room, openLobby = true) {
        activeRoomData = room;
        refreshRoomUI(room);
        if (openLobby) openPreGameLobby(room);
    }

    socket.on('ffa_no_lobby', data => showToast(data?.message || 'No FFA lobby is open yet.', 'ℹ️'));
    socket.on('ffa_lobby_ready', room => acceptRoom(room, true));
    socket.on('saved_room_update', room => {
        if (!activeRoomData || activeRoomData.roomId !== room.roomId) return;
        refreshRoomUI(room);
    });
    socket.on('lobby_game_code_updated', data => {
        if (!activeRoomData || activeRoomData.roomId !== data.roomId) return;
        activeRoomData.smashUrl = data.smashUrl;
        refreshRoomUI(activeRoomData);
        showToast(`Lobby updated by ${data.updatedBy}. Code: ${roomCodeFromUrl(data.smashUrl) || 'set'}`, '📋');
    });
    socket.on('ready_state_changed', data => {
        if (!activeRoomData || activeRoomData.roomId !== data.roomId) return;
        const ready = document.getElementById('dockReadySummary');
        if (ready) ready.textContent = `${data.readyCount}/${data.total} ready${data.allReady ? ' · EVERYONE READY!' : ''}`;
    });
    socket.on('lobby_reaction', data => {
        if (!activeRoomData || activeRoomData.roomId !== data.roomId) return;
        showToast(`${data.from}: ${data.reaction}`, '🎉');
    });
    socket.on('lobby_system_message', data => {
        if (!activeRoomData || activeRoomData.roomId !== data.roomId) return;
        const line = `<div class="bg-blue-800/50 border border-white/10 p-2 rounded-xl text-[10px] text-blue-100">${escapeHTML(data.message)}</div>`;
        const pre = document.getElementById('preGameChatMessages');
        const match = document.getElementById('matchChatMessages');
        if (pre) pre.insertAdjacentHTML('beforeend', line);
        if (match) match.insertAdjacentHTML('beforeend', line);
    });
    socket.on('kicked_from_lobby', data => {
        if (!activeRoomData || activeRoomData.roomId !== data.roomId) return;
        activeRoomData = null;
        closeExclusiveModals();
        closeGameDock();
        showToast(`You were removed from the lobby by ${data.by}.`, '🚫');
    });
    socket.on('lobby_deleted', ({ roomId }) => {
        if (activeRoomData?.roomId !== roomId) return;
        activeRoomData = null;
        closeGameDock();
        closePreGameLobbyModal();
        showToast('That lobby closed because nobody remained in it.', 'ℹ️');
    });
    socket.on('account_required', data => {
        showToast(data?.message || 'Log in to use that saved-account feature.', '🔒');
        openOptionalLogin();
    });
    socket.on('session_mode', () => updateAccountUI());

    // ---------------------------------------------------------------------
    // CONNECTION STATUS IN HEADER - never covers Settings.
    // ---------------------------------------------------------------------
    function setConnectionState(state) {
        const dot = document.getElementById('connectionDot');
        const text = document.getElementById('connectionText');
        if (!dot || !text) return;
        if (state === 'connected') {
            dot.style.background = '#22c55e';
            text.textContent = 'Connected';
        } else if (state === 'connecting') {
            dot.style.background = '#facc15';
            text.textContent = 'Reconnecting…';
        } else {
            dot.style.background = '#ef4444';
            text.textContent = 'Offline';
        }
    }

    socket.on('connect', () => {
        setConnectionState('connected');
        updateUserUI();
    });
    socket.on('disconnect', () => setConnectionState('connecting'));
    socket.io?.on?.('reconnect_attempt', () => setConnectionState('connecting'));
    socket.io?.on?.('reconnect_failed', () => setConnectionState('offline'));

    window.addEventListener('online', () => setConnectionState(socket.connected ? 'connected' : 'connecting'));
    window.addEventListener('offline', () => setConnectionState('offline'));

    // ---------------------------------------------------------------------
    // SESSION TIMER + KEYBOARD SHORTCUTS
    // ---------------------------------------------------------------------
    setInterval(() => {
        const minutes = Math.floor((Date.now() - SESSION_STARTED) / 60000);
        const el = document.getElementById('hubSessionTime');
        if (el) el.textContent = `Session: ${minutes}m`;
    }, 15000);

    document.addEventListener('keydown', event => {
        const target = event.target;
        if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

        if (event.key === 'Escape') {
            const visibleModal = Array.from(document.querySelectorAll('.exclusive-modal')).find(el => !el.classList.contains('hidden'));
            if (visibleModal) {
                visibleModal.classList.add('hidden');
                return;
            }
            closeGameDock();
            return;
        }

        if (event.key.toLowerCase() === 'l') openGameDock('lobby');
        if (event.key.toLowerCase() === 'c') openGameDock('chat');
        if (event.key.toLowerCase() === 'm') openGameDock('music');
        if (event.key.toLowerCase() === 'r' && activeRoomData) toggleMyReadyStatus();
        if (event.key === '1') switchMatchMode('1v1');
        if (event.key === '3') openFfaPage();
    });

    // ---------------------------------------------------------------------
    // STARTUP
    // ---------------------------------------------------------------------
    const pref = readJSON(PREF_KEY, {});
    if (pref.gameplay === 'embed' || pref.gameplay === 'popup') {
        currentGameplayMode = pref.gameplay;
    }

    document.getElementById('authModal')?.classList.add('hidden');
    document.getElementById('settingsModal')?.classList.add('hidden');
    updateAccountUI();
    syncMainSettings();
    renderSpotifyEverywhere();
    setConnectionState(socket.connected ? 'connected' : 'connecting');

    // Ensure the guest/account session reaches the server even if the old
    // DOMContentLoaded handler already ran unusually early.
    updateUserUI();
}

// ============================================================================
// V14 PLATFORM LAYER
// Secure accounts + OWNER/DEV + PRIME reservation + groups + tournaments +
// profiles + permanent Discord-style messages + guide + streamer tools.
// ============================================================================
function installV12Platform() {
    // V14 keeps the existing function name so older deployment wiring stays compatible.
    const SECURE_KEY = 'smash_secure_account_v12';
    const QUEUE_KEY = 'smash_queue_type_v12';
    const STREAMER_PREF_KEY = 'smash_streamer_prefs_v12';
    let accountState = null;
    let groupsCache = [];
    let activeGroupId = null;
    let activeGroupSnapshot = null;
    let tournamentsCache = [];
    let canCreateTournament = false;
    let adminSelectedUsername = null;
    let pendingAuthAttempt = null;

    function readLocal(key, fallback = null) {
        try {
            const value = JSON.parse(localStorage.getItem(key));
            return value == null ? fallback : value;
        } catch {
            return fallback;
        }
    }

    function writeLocal(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }

    function secureSession() {
        return readLocal(SECURE_KEY, null);
    }

    function storeSecureSession(token, user) {
        const session = { token, ...user };
        writeLocal(SECURE_KEY, session);
        localStorage.setItem('user_session', JSON.stringify(session));
        accountState = user;
    }

    function clearSecureSession() {
        localStorage.removeItem(SECURE_KEY);
        localStorage.removeItem('user_session');
        accountState = null;
    }

    function roleList(roles) {
        const result = [];
        if (roles?.owner) result.push({ text: 'DEV', cls: 'owner' });
        if (roles?.moderator) result.push({ text: 'MOD', cls: 'mod' });
        if (roles?.streamer) result.push({ text: 'STREAMER', cls: 'streamer' });
        if (roles?.tourneyHost) result.push({ text: 'TOURNEY HOST', cls: 'tourney' });
        return result;
    }

    function badgeHTML(roles) {
        return roleList(roles).map(role => `<span class="v12-role-badge ${role.cls}">${role.text}</span>`).join('');
    }

    function avatarFor(username) {
        const user = (onlineUsersCache || []).find(item => item.username === username);
        return user?.avatar || '';
    }

    function fillAvatarBox(box, avatar, name) {
        if (!box) return;
        box.replaceChildren();
        if (avatar) {
            const img = document.createElement('img');
            img.src = avatar;
            img.alt = `${name || 'User'} profile picture`;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '999px';
            box.appendChild(img);
        } else {
            box.textContent = String(name || '?').split(/[\s_-]+/).filter(Boolean).slice(0,2).map(part => part[0]?.toUpperCase() || '').join('') || '?';
        }
    }

    function injectStyles() {
        if (document.getElementById('v12Styles')) return;
        const style = document.createElement('style');
        style.id = 'v12Styles';
        style.textContent = `
            .v12-role-badge{display:inline-flex;align-items:center;padding:2px 6px;border-radius:999px;font:900 8px Inter,sans-serif;letter-spacing:.03em;border:1px solid #ffffff25;white-space:nowrap}
            .v12-role-badge.owner{background:#7c3aed;color:#fff;border-color:#c4b5fd}.v12-role-badge.mod{background:#dc2626;color:#fff}.v12-role-badge.streamer{background:#ec4899;color:#fff}.v12-role-badge.tourney{background:#eab308;color:#172554}
            #headerRoleBadges{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:3px}
            #ownerAdminButton{border:1px solid #c4b5fd;background:#6d28d9;color:white;font:900 10px Inter,sans-serif;padding:8px 10px;border-radius:12px;cursor:pointer}
            .v12-modal-card{background:#102653;border:2px solid #ffe238;border-radius:22px;box-shadow:0 20px 60px #0009;color:white}
            .v12-grid{display:grid;grid-template-columns:260px minmax(0,1fr);gap:12px;min-height:520px}.v12-list{background:#0d2258;border:1px solid #ffffff1d;border-radius:14px;padding:8px;overflow:auto}.v12-detail{background:#132e70;border:1px solid #ffffff1d;border-radius:14px;padding:14px;overflow:auto}
            .v12-user-row{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;border-radius:10px;background:transparent;color:white;padding:9px;text-align:left;cursor:pointer}.v12-user-row:hover,.v12-user-row.active{background:#ffffff12}
            .v12-pill{display:inline-flex;padding:3px 7px;border-radius:999px;background:#ffffff12;border:1px solid #ffffff1e;font-size:9px;font-weight:800}
            .v12-section{background:#0f245b;border:1px solid #ffffff1c;border-radius:14px;padding:12px;margin-top:10px}.v12-section-title{color:#ffe238;font:900 10px Inter,sans-serif;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
            .v12-small-btn{border:1px solid #ffffff25;border-radius:9px;background:#244a9d;color:white;font:900 9px Inter,sans-serif;padding:7px 8px;cursor:pointer}.v12-small-btn.red{background:#b91c1c}.v12-small-btn.green{background:#059669}.v12-small-btn.yellow{background:#ffd318;color:#142f75}.v12-small-btn.purple{background:#6d28d9}
            .discord-message{grid-template-columns:40px minmax(0,1fr) 30px!important;align-items:start;position:relative}
            .v12-message-menu{position:relative;display:flex;justify-content:flex-end;align-items:flex-start;padding-top:1px}
            .v12-message-menu-button{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:#9fb2e3;font:1000 16px Inter,sans-serif;line-height:1;cursor:pointer;opacity:.2;transition:.15s}
            .discord-message:hover .v12-message-menu-button,.v12-message-menu-button:focus,.v12-message-menu.open .v12-message-menu-button{opacity:1;background:#ffffff0d;color:white}
            .v12-message-menu-popover{position:absolute;right:32px;top:0;z-index:25;min-width:128px;padding:5px;border:1px solid #ffffff20;border-radius:11px;background:#0c1b45;box-shadow:0 12px 30px #0008;display:none}
            .v12-message-menu.open .v12-message-menu-popover{display:flex;flex-direction:column;gap:3px}
            .v12-message-menu-item{width:100%;border:0;border-radius:7px;padding:7px 9px;background:transparent;color:#e8eeff;text-align:left;font:800 10px Inter,sans-serif;cursor:pointer}.v12-message-menu-item:hover{background:#ffffff10}.v12-message-menu-item.danger{color:#fca5a5}.v12-message-menu-item.mod{color:#fcd34d}
            .discord-composer{position:sticky;bottom:0;z-index:3;background:#182b62;flex:0 0 auto}.discord-chat{min-height:0}.discord-messages{min-height:0;overflow-y:auto!important}
            .v12-group-row{border-left:3px solid #8b5cf6}.v12-mention{background:#facc1530;border-radius:3px;padding:0 2px;color:#fde68a;font-weight:900}
            .v12-profile-hero{display:grid;grid-template-columns:120px minmax(0,1fr);gap:18px;align-items:center}.v12-profile-avatar{width:120px;height:120px;border-radius:50%;overflow:hidden;background:#1e3a8a;display:grid;place-items:center;font-size:32px;font-weight:900;border:4px solid #ffffff35}.v12-profile-avatar img{width:100%;height:100%;object-fit:cover}
            .v12-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}.v12-stat{background:#102653;border:1px solid #ffffff1a;border-radius:12px;padding:10px;text-align:center}.v12-stat b{display:block;color:#ffe238;font-size:18px}.v12-stat span{font-size:9px;color:#b9c9ef;text-transform:uppercase;font-weight:900}
            .v12-group-header{display:flex;align-items:center;justify-content:space-between;gap:8px}.v12-group-member{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #ffffff12}
            #btnNavTournaments,#btnNavStreamer{font-family:Bungee,sans-serif;font-size:9px;line-height:1.05}
            .v12-tournament-card{background:#173477;border:1px solid #ffffff1d;border-radius:14px;padding:12px;margin-bottom:9px}.v12-bracket{display:flex;gap:18px;overflow-x:auto;padding:10px 0}.v12-round{min-width:220px}.v12-match{background:#102653;border:1px solid #ffffff20;border-radius:10px;padding:8px;margin:8px 0}
            #guideModal .v12-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.v12-guide-card{background:#102653;border:1px solid #ffffff1f;border-radius:14px;padding:12px}.v12-guide-card h4{color:#ffe238;font-weight:900;font-size:11px;margin-bottom:5px}.v12-guide-card p{font-size:10px;color:#c8d6f7;line-height:1.45}
            #v12QueueSelector{display:flex;gap:6px;padding:5px;background:#102653;border:1px solid #ffffff1d;border-radius:14px}.v12-queue-btn{flex:1;border:0;border-radius:10px;padding:8px;color:#dbe7ff;background:transparent;font:900 10px Inter,sans-serif;cursor:pointer}.v12-queue-btn.active{background:#ffd318;color:#142f75}
            @media(max-width:760px){.v12-grid{grid-template-columns:1fr}.v12-list{max-height:200px}.v12-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.v12-profile-hero{grid-template-columns:1fr;text-align:center}.v12-profile-avatar{margin:auto}#guideModal .v12-guide-grid{grid-template-columns:1fr}}
        `;
        document.head.appendChild(style);
    }

    function injectHeaderBadges() {
        const userTag = document.getElementById('userDisplayTag');
        if (!userTag) return;
        const container = userTag.parentElement?.parentElement;
        if (!container) return;
        let badges = document.getElementById('headerRoleBadges');
        if (!badges) {
            badges = document.createElement('div');
            badges.id = 'headerRoleBadges';
            container.appendChild(badges);
        }
        badges.innerHTML = badgeHTML(accountState?.roles);
        let ownerButton = document.getElementById('ownerAdminButton');
        if (!ownerButton) {
            ownerButton = document.createElement('button');
            ownerButton.id = 'ownerAdminButton';
            ownerButton.textContent = '🛡 ADMIN';
            ownerButton.onclick = openAdminPanel;
            document.getElementById('onlineCounterBtn')?.parentElement?.appendChild(ownerButton);
        }
        ownerButton.classList.toggle('hidden', !accountState?.roles?.owner);

        let level = document.getElementById('headerLevelBadge');
        if (!level) {
            level = document.createElement('span');
            level.id = 'headerLevelBadge';
            level.className = 'v12-pill';
            userTag.parentElement?.appendChild(level);
        }
        level.textContent = accountState ? `LVL ${accountState.level || 1}` : 'LVL 1';
    }

    function updateConditionalNavigation() {
        const tourney = document.getElementById('btnNavTournaments');
        const streamer = document.getElementById('btnNavStreamer');
        const hasTournaments = tournamentsCache.length > 0;
        if (tourney) tourney.classList.toggle('hidden', !(hasTournaments || canCreateTournament || accountState?.roles?.owner || accountState?.roles?.moderator));
        if (streamer) streamer.classList.toggle('hidden', !(accountState?.roles?.streamer || accountState?.roles?.owner));
    }

    function accountSessionPayload(user) {
        return {
            username: user.username,
            email: user.email,
            roles: user.roles,
            level: user.level,
            xp: user.xp,
            rating1v1: user.rating1v1,
            ratingFFA: user.ratingFFA,
            warnings: user.warnings,
            streamerLive: user.streamerLive
        };
    }

    // ------------------------------------------------------------------
    // SECURE AUTHENTICATION
    // ------------------------------------------------------------------
    handleAuthSubmit = function (event, type) {
        event.preventDefault();
        if (type === 'register') {
            const username = String(document.getElementById('regUsername')?.value || '').trim();
            const email = String(document.getElementById('regEmail')?.value || '').trim();
            const password = String(document.getElementById('regPassword')?.value || '');
            let ownerSetupKey = '';
            if (username.toLowerCase() === 'prime') {
                ownerSetupKey = window.prompt('PRIME is the OWNER account. Enter your one-time OWNER_SETUP_KEY from Render:') || '';
                if (!ownerSetupKey) return;
            }
            pendingAuthAttempt = { type, username, email, password, ownerSetupKey };
            socket.emit('account_register', pendingAuthAttempt);
        } else {
            const email = String(document.getElementById('loginEmail')?.value || '').trim();
            const password = String(document.getElementById('loginPassword')?.value || '');
            pendingAuthAttempt = { type, email, password };
            socket.emit('account_login', pendingAuthAttempt);
        }
    };

    AuthSession.logout = function () {
        const session = secureSession();
        if (session?.token) socket.emit('account_logout', { token: session.token });
        clearSecureSession();
        window.location.reload();
    };

    const baseSaveNewUsername = saveNewUsername;
    saveNewUsername = function () {
        const next = String(document.getElementById('newUsernameInput')?.value || '').trim();
        if (!next) return;
        const session = secureSession();
        if (session?.token) {
            socket.emit('account_rename', { newUsername: next });
            return;
        }
        if (next.toLowerCase() === 'prime') {
            showToast('PRIME is reserved for the OWNER account.', '🛡️');
            return;
        }
        baseSaveNewUsername();
    };

    socket.on('auth_success', data => {
        if (!data?.user) return;
        accountState = data.user;
        const existing = secureSession();
        const token = data.token || existing?.token;
        if (token) storeSecureSession(token, accountSessionPayload(data.user));
        if (!data.resumed) {
            try {
                const legacy = JSON.parse(localStorage.getItem('registered_users') || '[]');
                const filtered = legacy.filter(item => String(item.email || '').toLowerCase() !== String(data.user.email || '').toLowerCase());
                localStorage.setItem('registered_users', JSON.stringify(filtered));
            } catch {}
            showToast(data.user.roles?.owner ? 'OWNER / DEV account authenticated.' : `Logged in as ${data.user.username}.`, data.user.roles?.owner ? '🛡️' : '✅');
            setTimeout(() => window.location.reload(), 250);
            return;
        }
        const tag = document.getElementById('userDisplayTag');
        if (tag) tag.textContent = data.user.username;
        const mode = document.getElementById('accountModeLabel');
        if (mode) mode.textContent = data.user.roles?.owner ? 'OWNER / DEV' : 'Saved Account';
        injectHeaderBadges();
        updateConditionalNavigation();
        socket.emit('get_groups');
        socket.emit('get_tournaments');
    });

    socket.on('auth_error', data => {
        const message = data?.message || 'Could not log in.';
        if (pendingAuthAttempt?.type === 'login' && /incorrect email or password/i.test(message)) {
            // Smooth migration from the older browser-only account system.
            try {
                const legacy = JSON.parse(localStorage.getItem('registered_users') || '[]');
                const found = legacy.find(u => String(u.email || '').toLowerCase() === pendingAuthAttempt.email.toLowerCase() && u.password === pendingAuthAttempt.password);
                if (found && confirm('This looks like one of your older browser-only accounts. Convert it to the new secure account system now?')) {
                    let ownerSetupKey = '';
                    if (String(found.username || '').toLowerCase() === 'prime') ownerSetupKey = prompt('Enter OWNER_SETUP_KEY to migrate PRIME:') || '';
                    socket.emit('account_register', { username: found.username, email: found.email, password: found.password, ownerSetupKey });
                    return;
                }
            } catch {}
        }
        showToast(message, '❌');
    });

    socket.on('auth_session_invalid', data => {
        clearSecureSession();
        showToast(data?.message || 'Your login expired.', '⚠️');
        setTimeout(() => window.location.reload(), 700);
    });

    socket.on('account_renamed', data => {
        const session = secureSession();
        if (session) {
            session.username = data.username;
            writeLocal(SECURE_KEY, session);
            localStorage.setItem('user_session', JSON.stringify(session));
        }
        showToast(`Username changed to ${data.username}.`, '✏️');
        closeEditUsernameModal();
        setTimeout(() => window.location.reload(), 250);
    });

    socket.on('account_rename_error', data => showToast(data?.message || 'Could not rename account.', '❌'));
    socket.on('username_reserved', data => showToast(data?.message || 'That username is reserved.', '🛡️'));
    socket.on('forced_username_changed', data => {
        const session = secureSession();
        if (session) {
            session.username = data.username;
            writeLocal(SECURE_KEY, session);
            localStorage.setItem('user_session', JSON.stringify(session));
        }
        showToast(`Your username was changed to ${data.username} by the OWNER.`, '🛡️');
        setTimeout(() => window.location.reload(), 500);
    });
    socket.on('moderation_notice', data => showToast(data?.message || 'Moderator action applied.', '🛡️'));

    socket.on('account_state_changed', user => {
        if (!user) return;
        accountState = user;
        const session = secureSession();
        if (session) storeSecureSession(session.token, accountSessionPayload(user));
        injectHeaderBadges();
        updateConditionalNavigation();
    });

    // Account settings are mirrored locally for instant load, but the server
    // is the durable source for saved accounts so site updates do not reset them.
    socket.on('saved_settings', settings => {
        if (!settings || !secureSession()?.token) return;
        const gameplayMode = settings.gameplayMode === 'embed' ? 'embed' : 'popup';
        const savedQueue = settings.queueType === 'ranked' ? 'ranked' : 'casual';
        currentGameplayMode = gameplayMode;
        updateGameplayMode(gameplayMode);
        const gameplay = document.getElementById('settingsGameplayMode');
        if (gameplay) gameplay.value = gameplayMode;
        const originalSelect = document.getElementById('gameplayModeSelect');
        if (originalSelect) originalSelect.value = gameplayMode;
        try {
            const pref = JSON.parse(localStorage.getItem('smash_arena_preferences_v4') || '{}');
            pref.gameplay = gameplayMode;
            localStorage.setItem('smash_arena_preferences_v4', JSON.stringify(pref));
            localStorage.setItem(QUEUE_KEY, savedQueue);
            localStorage.setItem(STREAMER_PREF_KEY, JSON.stringify({
                hideCode: !!settings.streamerHideCode,
                safeNotifications: !!settings.streamerSafeNotifications
            }));
        } catch {}
        queueType = savedQueue;
        refreshQueueButtons();
        const hideCode = document.getElementById('streamerHideCode');
        const safeNotifications = document.getElementById('streamerSafeNotifications');
        if (hideCode) hideCode.checked = !!settings.streamerHideCode;
        if (safeNotifications) safeNotifications.checked = !!settings.streamerSafeNotifications;
        const code = document.getElementById('copyRoomCodeBtn');
        if (code) code.style.visibility = settings.streamerHideCode ? 'hidden' : '';
    });

    const baseSaveMainSettingsV14 = window.saveMainSettings;
    window.saveMainSettings = function () {
        baseSaveMainSettingsV14?.();
        const gameplayMode = document.getElementById('settingsGameplayMode')?.value === 'embed' ? 'embed' : 'popup';
        if (secureSession()?.token) socket.emit('update_saved_settings', { gameplayMode });
    };

    // ------------------------------------------------------------------
    // GUIDE IN SETTINGS
    // ------------------------------------------------------------------
    function injectGuide() {
        const settingsCard = document.querySelector('#settingsModal .w-full.max-w-xl');
        if (settingsCard && !document.getElementById('settingsGuideButton')) {
            const wrap = document.createElement('div');
            wrap.className = 'hub-card mt-4';
            wrap.innerHTML = `<span class="dock-label">Help</span><p class="text-[11px] text-blue-200 mb-3">Learn 1v1, FFA, lobbies, friends, messages, groups, Spotify, tournaments, roles, and ranked play.</p><button id="settingsGuideButton" class="dock-action yellow">❓ HOW EVERYTHING WORKS</button>`;
            settingsCard.appendChild(wrap);
            wrap.querySelector('button').onclick = openGuide;
        }

        if (!document.getElementById('guideModal')) {
            const modal = document.createElement('div');
            modal.id = 'guideModal';
            modal.className = 'hidden fixed inset-0 modal-overlay z-[90] flex items-center justify-center p-4 exclusive-modal';
            modal.innerHTML = `<div class="v12-modal-card w-full max-w-4xl p-6 max-h-[90vh] overflow-y-auto"><div class="flex justify-between gap-3 items-center mb-4"><div><h3 class="font-bungee text-xl text-yellow-300">❓ HOW EVERYTHING WORKS</h3><p class="text-[11px] text-blue-200">Quick directions for the whole site.</p></div><button class="v12-small-btn red" id="guideClose">✕ CLOSE</button></div><div class="v12-guide-grid">
                <div class="v12-guide-card"><h4>1v1</h4><p>Choose Casual or Ranked, paste a Smash Karts share link/code, create a lobby, chat, ready up, then join the game.</p></div>
                <div class="v12-guide-card"><h4>FFA</h4><p>Choose 12 or 24 players. Public lobbies can be found by everyone; private lobbies are invite-only.</p></div>
                <div class="v12-guide-card"><h4>Paste Code</h4><p>You can paste a room code, full Smash Karts link, or the entire “Come play Smash Karts” share message. The full link is preserved for popup players.</p></div>
                <div class="v12-guide-card"><h4>Friends + DMs</h4><p>Add saved accounts from Online Players. Messages stay saved. You can edit/delete your own messages and report abusive messages.</p></div>
                <div class="v12-guide-card"><h4>Groups</h4><p>Create Discord-like groups with up to 50 friends. Group owners can appoint admins. Use @username mentions to get someone’s attention.</p></div>
                <div class="v12-guide-card"><h4>Profiles + Levels</h4><p>Saved accounts get circular PFPs, public roles, Level 1-200, separate 1v1/FFA ratings, match count, and tournament history as it grows.</p></div>
                <div class="v12-guide-card"><h4>Tournaments</h4><p>Public tournaments appear only when available. Private tournaments appear only for invited players. Tourney Hosts can create and manage them.</p></div>
                <div class="v12-guide-card"><h4>Roles</h4><p>DEV is the OWNER. MOD handles moderation. STREAMER gets creator tools. TOURNEY HOST can create tournaments. Roles are public badges.</p></div>
                <div class="v12-guide-card"><h4>Spotify</h4><p>Music stays in its own organized area. Premium can use fuller playback controls; Free users use Spotify’s supported playback experience.</p></div>
                <div class="v12-guide-card"><h4>Guest vs Account</h4><p>Guests can play. Saved accounts keep friends, DMs, PFP, progression, roles, tournament access, and other permanent data.</p></div>
            </div></div>`;
            document.body.appendChild(modal);
            modal.querySelector('#guideClose').onclick = () => modal.classList.add('hidden');
        }
    }

    function openGuide() {
        document.querySelectorAll('.exclusive-modal').forEach(el => el.classList.add('hidden'));
        document.getElementById('guideModal')?.classList.remove('hidden');
    }

    // ------------------------------------------------------------------
    // PROFILE OVERLAY
    // Clicking any PFP/name opens one overlay instead of replacing the page.
    // OWNER/DEV and MOD users also get quick moderation controls here.
    // ------------------------------------------------------------------
    let lastOpenedProfileUsername = null;

    function injectProfileOverlay() {
        if (document.getElementById('profileOverlayModal')) return;
        const modal = document.createElement('div');
        modal.id = 'profileOverlayModal';
        modal.className = 'hidden fixed inset-0 modal-overlay z-[110] flex items-center justify-center p-4 exclusive-modal';
        modal.innerHTML = `
            <div class="v12-modal-card w-full max-w-2xl p-5 max-h-[92vh] overflow-y-auto">
                <div class="flex justify-between items-center gap-3 mb-3">
                    <div>
                        <div class="font-bungee text-lg text-yellow-300">PLAYER PROFILE</div>
                        <div class="text-[10px] text-blue-200">Profile overlay</div>
                    </div>
                    <button id="profileOverlayClose" class="v12-small-btn red">✕ CLOSE</button>
                </div>
                <div id="profileOverlayContent"><div class="text-center text-blue-200 text-xs py-10">Loading profile…</div></div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#profileOverlayClose').onclick = () => modal.classList.add('hidden');
        modal.addEventListener('click', event => {
            if (event.target === modal) modal.classList.add('hidden');
        });
    }

    window.openPlayerProfile = function (username) {
        if (!username) return;
        lastOpenedProfileUsername = username;
        injectProfileOverlay();
        document.querySelectorAll('.exclusive-modal').forEach(el => {
            if (el.id !== 'profileOverlayModal') el.classList.add('hidden');
        });
        const modal = document.getElementById('profileOverlayModal');
        const content = document.getElementById('profileOverlayContent');
        if (content) content.innerHTML = '<div class="text-center text-blue-200 text-xs py-10">Loading profile…</div>';
        modal?.classList.remove('hidden');
        socket.emit('get_public_profile', { username });
    };

    window.openMyProfile = function () {
        const username = accountState?.username || AuthSession.getUser()?.username;
        const session = secureSession();
        if (!session || !username || /^Guest-/i.test(username)) {
            showToast('Log in to a saved account to open your full profile.', '👤');
            openOptionalLogin();
            return;
        }
        openPlayerProfile(username);
    };

    function profileQuickModeration(profile, content) {
        const canModerate = !!(accountState?.roles?.owner || accountState?.roles?.moderator);
        const targetIsOwner = !!profile?.roles?.owner;
        const isSelf = String(profile?.username || '').toLowerCase() === String(accountState?.username || '').toLowerCase();
        if (!canModerate || targetIsOwner || isSelf) return;

        const section = document.createElement('div');
        section.className = 'v12-section';
        section.innerHTML = `
            <div class="v12-section-title">🛡 MODERATION TOOLS</div>
            <div class="text-[10px] text-blue-200 mb-2">Only DEV/MOD accounts can see these controls.</div>
            <input id="profileModReason" class="smash-input w-full px-3 py-2 rounded-xl text-xs" placeholder="Reason / moderation note">
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                <button id="profileWarnBtn" class="v12-small-btn yellow">WARN</button>
                <button id="profileMuteBtn" class="v12-small-btn">MUTE 1H</button>
                <button id="profileKickBtn" class="v12-small-btn red">KICK</button>
                <button id="profileBanBtn" class="v12-small-btn red">🚫 BAN</button>
            </div>
            <div id="profileBanOptions" class="hidden mt-3 p-3 rounded-xl border border-red-400/30 bg-red-950/30">
                <div class="text-[10px] font-black text-red-200 mb-2">BAN ${escapeHTML(profile.username)}</div>
                <select id="profileBanDuration" class="smash-input w-full px-3 py-2 rounded-xl text-xs">
                    <option value="3600000">1 hour</option>
                    <option value="86400000">24 hours</option>
                    <option value="604800000">7 days</option>
                    <option value="permanent">Permanent</option>
                </select>
                <div class="flex gap-2 mt-2">
                    <button id="profileConfirmBan" class="v12-small-btn red flex-1">CONFIRM BAN</button>
                    <button id="profileCancelBan" class="v12-small-btn flex-1">CANCEL</button>
                </div>
            </div>
            ${accountState?.roles?.owner ? '<button id="profileOpenAdminBtn" class="v12-small-btn purple mt-3">OPEN FULL DEV CONTROLS</button>' : ''}`;
        content.appendChild(section);

        const reason = () => String(section.querySelector('#profileModReason')?.value || '').trim();
        const send = (action, duration = null) => socket.emit('admin_moderation_action', {
            username: profile.username,
            action,
            duration,
            reason: reason() || `${action} by ${accountState?.roles?.owner ? 'OWNER / DEV' : 'MOD'}`
        });

        section.querySelector('#profileWarnBtn').onclick = () => send('warn');
        section.querySelector('#profileMuteBtn').onclick = () => send('mute', '3600000');
        section.querySelector('#profileKickBtn').onclick = () => {
            if (confirm(`Kick ${profile.username} from the website now?`)) send('kick');
        };
        const options = section.querySelector('#profileBanOptions');
        section.querySelector('#profileBanBtn').onclick = () => options.classList.remove('hidden');
        section.querySelector('#profileCancelBan').onclick = () => options.classList.add('hidden');
        section.querySelector('#profileConfirmBan').onclick = () => {
            const select = section.querySelector('#profileBanDuration');
            const duration = select?.value || 'permanent';
            const label = duration === 'permanent' ? 'PERMANENTLY' : (select?.selectedOptions?.[0]?.textContent || 'temporarily');
            if (!confirm(`Ban ${profile.username} ${label}?`)) return;
            send('ban', duration);
            options.classList.add('hidden');
        };
        const openAdmin = section.querySelector('#profileOpenAdminBtn');
        if (openAdmin) openAdmin.onclick = () => {
            document.getElementById('profileOverlayModal')?.classList.add('hidden');
            adminSelectedUsername = profile.username;
            openAdminPanel();
        };
    }

    socket.on('public_profile', profile => {
        const modal = document.getElementById('profileOverlayModal');
        const content = document.getElementById('profileOverlayContent');
        if (!content || !modal || modal.classList.contains('hidden')) return;
        if (!profile) {
            content.innerHTML = '<div class="text-center text-red-200 text-xs py-10">Profile not found.</div>';
            return;
        }
        lastOpenedProfileUsername = profile.username;
        const avatar = profile.avatar
            ? `<img src="${profile.avatar}" alt="${escapeHTML(profile.username)} profile picture">`
            : escapeHTML(String(profile.username || '?').slice(0,2).toUpperCase());
        content.innerHTML = `
            <div class="v12-profile-hero">
                <div class="v12-profile-avatar">${avatar}</div>
                <div>
                    <div class="flex gap-2 items-center flex-wrap">
                        <h2 class="font-bungee text-2xl text-white">${escapeHTML(profile.username)}</h2>
                        ${badgeHTML(profile.roles)}
                        ${profile.streamerLive ? '<span class="v12-role-badge streamer">● LIVE</span>' : ''}
                    </div>
                    <div class="text-yellow-300 font-black mt-2">LEVEL ${profile.level}</div>
                    <div class="text-xs text-blue-200 mt-1">${profile.online ? '🟢 Online' : '⚫ Offline'}${profile.playing ? ` · Playing ${escapeHTML(profile.playing)}` : ''}</div>
                </div>
            </div>
            <div class="v12-stat-grid">
                <div class="v12-stat"><b>${profile.rating1v1}</b><span>1v1 Rating</span></div>
                <div class="v12-stat"><b>${profile.ratingFFA}</b><span>FFA Rating</span></div>
                <div class="v12-stat"><b>${profile.matches}</b><span>Matches</span></div>
                <div class="v12-stat"><b>${profile.friendsCount}</b><span>Friends</span></div>
            </div>
            <div class="v12-section"><div class="v12-section-title">Music privacy</div><div class="text-xs text-blue-200">${profile.canSeeMusic ? 'You are friends, so shared Spotify activity can appear here when enabled.' : 'Currently-playing music is visible to friends only.'}</div></div>`;
        profileQuickModeration(profile, content);
    });

    // Make Online Players names/PFPs open the full profile page.
    renderOnlineUsersList = function (users) {
        const container = document.getElementById('onlineUsersList');
        if (!container) return;
        container.replaceChildren();
        const me = AuthSession.getUser()?.username || '';
        (users || []).forEach(user => {
            if (user.id === socket.id || user.username === me) return;
            const row = document.createElement('div');
            row.className = 'flex justify-between items-center gap-3 bg-blue-950/80 p-3 rounded-2xl border border-white/10';
            const identity = document.createElement('button');
            identity.className = 'flex items-center gap-2 min-w-0 text-left flex-1';
            identity.onclick = () => { closeOnlineModal(); openPlayerProfile(user.username); };
            const avatar = document.createElement('div');
            avatar.className = 'round-user-avatar';
            fillAvatarBox(avatar, user.avatar || '', user.username);
            const copy = document.createElement('div');
            copy.className = 'min-w-0';
            copy.innerHTML = `<div class="font-bold text-xs text-white truncate">${escapeHTML(user.username)} <span class="text-[9px] text-yellow-300">LVL ${user.level || 1}</span></div><div class="flex gap-1 flex-wrap mt-1">${badgeHTML(user.roles)}</div>`;
            identity.append(avatar, copy);
            const action = document.createElement('div');
            if (isUserFriend(user.username)) action.innerHTML = '<span class="text-[10px] font-black text-emerald-300 px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-400/30">✓ FRIEND</span>';
            else if (user.isGuest) action.innerHTML = '<span class="text-[9px] text-blue-300">Guest</span>';
            else {
                const add = document.createElement('button');
                add.className = 'bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-2.5 py-1.5 rounded-lg';
                add.textContent = '+ ADD FRIEND';
                add.onclick = () => sendFriendRequest(user.id, user.username);
                action.appendChild(add);
            }
            row.append(identity, action);
            container.appendChild(row);
        });
        if (!container.children.length) container.innerHTML = '<p class="text-xs text-blue-200 text-center py-4">Nobody else is online right now.</p>';
    };

    // Public role/level badges inside lobby player lists.
    const baseLobbyRendererV12 = updatePreGameLobbyUI;
    updatePreGameLobbyUI = function (room) {
        baseLobbyRendererV12(room);
        const list = document.getElementById('preGamePlayerList');
        if (!list || !room?.players) return;
        Array.from(list.children).forEach((row, index) => {
            const player = room.players[index];
            if (!player) return;
            const nameArea = row.querySelector('.font-bold') || row.firstElementChild;
            if (!nameArea || row.querySelector('.v12-lobby-badges')) return;
            const badges = document.createElement('span');
            badges.className = 'v12-lobby-badges inline-flex gap-1 ml-1 align-middle';
            badges.innerHTML = `<span class="v12-pill">LVL ${player.level || 1}</span>${badgeHTML(player.roles)}`;
            nameArea.appendChild(badges);
        });
    };

    function decorateGameDockPlayers(room) {
        const list = document.getElementById('gameDockPlayerList');
        if (!list || !room?.players) return;
        Array.from(list.children).forEach((row, index) => {
            const player = room.players[index];
            if (!player || row.querySelector('.v12-lobby-badges')) return;
            const name = row.querySelector('.font-bold');
            if (!name) return;
            const badges = document.createElement('span');
            badges.className = 'v12-lobby-badges inline-flex gap-1 ml-1 align-middle';
            badges.innerHTML = `<span class="v12-pill">LVL ${player.level || 1}</span>${badgeHTML(player.roles)}`;
            name.appendChild(badges);
        });
    }
    socket.on('saved_room_update', room => setTimeout(() => decorateGameDockPlayers(room), 0));
    socket.on('room_created', room => setTimeout(() => decorateGameDockPlayers(room), 0));
    socket.on('ffa_lobby_ready', room => setTimeout(() => decorateGameDockPlayers(room), 0));

    // ------------------------------------------------------------------
    // PERMANENT DISCORD-LIKE DMs: edit, delete, report, fixed composer
    // ------------------------------------------------------------------
    function renderMessageText(element, text, mentionName = null) {
        element.textContent = text || '';
        if (!mentionName || !String(text).toLowerCase().includes('@' + mentionName.toLowerCase())) return;
        element.classList.add('bg-yellow-400/10', 'rounded-md', 'px-1');
    }

    function closeAllMessageMenus(except = null) {
        document.querySelectorAll('.v12-message-menu.open').forEach(menu => {
            if (menu !== except) menu.classList.remove('open');
        });
    }

    function quickBanFromMessage(username) {
        if (!(accountState?.roles?.owner || accountState?.roles?.moderator)) return;
        const choice = String(prompt(`Ban ${username} for how long? Type 1h, 24h, 7d, or permanent:`, '24h') || '').trim().toLowerCase();
        if (!choice) return;
        const durations = { '1h': 3600000, '24h': 86400000, '7d': 604800000, 'permanent': 'permanent', 'perm': 'permanent' };
        const duration = durations[choice];
        if (!duration) return showToast('Use 1h, 24h, 7d, or permanent.', '⚠️');
        const reason = String(prompt(`Reason for banning ${username}:`, '') || '').trim();
        if (!confirm(`Ban ${username} (${choice})${reason ? ` — ${reason}` : ''}?`)) return;
        socket.emit('admin_moderation_action', { username, action: 'ban', duration, reason });
    }

    function buildMessageMenu({ own, username, onEdit, onDelete, onReport }) {
        const wrap = document.createElement('div');
        wrap.className = 'v12-message-menu';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'v12-message-menu-button';
        trigger.textContent = '⋯';
        trigger.title = 'Message options';
        trigger.setAttribute('aria-label', 'Message options');
        const popover = document.createElement('div');
        popover.className = 'v12-message-menu-popover';

        const add = (label, handler, cls = '') => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `v12-message-menu-item ${cls}`.trim();
            button.textContent = label;
            button.onclick = event => {
                event.stopPropagation();
                wrap.classList.remove('open');
                handler?.();
            };
            popover.appendChild(button);
        };

        if (own) {
            add('Edit message', onEdit);
            add('Delete message', onDelete, 'danger');
        } else {
            add('Report message', onReport, 'danger');
            if (accountState?.roles?.owner || accountState?.roles?.moderator) {
                add('Ban player…', () => quickBanFromMessage(username), 'mod');
            }
        }

        trigger.onclick = event => {
            event.stopPropagation();
            const opening = !wrap.classList.contains('open');
            closeAllMessageMenus(wrap);
            wrap.classList.toggle('open', opening);
        };
        wrap.append(trigger, popover);
        return wrap;
    }

    if (!window.__v14MessageMenuOutsideClose) {
        window.__v14MessageMenuOutsideClose = true;
        document.addEventListener('click', () => closeAllMessageMenus());
        document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAllMessageMenus(); });
    }

    renderDMMessages = function (history) {
        const container = document.getElementById('tabDMMessages');
        if (!container) return;
        container.replaceChildren();
        if (!activeDMTargetUser) {
            container.innerHTML = '<div class="h-full grid place-items-center text-center text-blue-200 text-xs">Select a friend to start messaging.</div>';
            return;
        }
        if (!history?.length) {
            container.innerHTML = `<div class="h-full grid place-items-center text-center text-blue-200 text-xs">This is the beginning of your conversation with ${escapeHTML(activeDMTargetUser)}.</div>`;
            return;
        }
        const me = AuthSession.getUser()?.username || 'Player';
        history.forEach(message => {
            const own = message.senderUsername === me;
            const row = document.createElement('div');
            row.className = 'discord-message';
            const avatar = document.createElement('button');
            avatar.className = 'discord-avatar big';
            fillAvatarBox(avatar, '', message.senderUsername);
            avatar.onclick = () => openPlayerProfile(message.senderUsername);
            const body = document.createElement('div');
            body.className = 'min-w-0';
            const head = document.createElement('div');
            const name = document.createElement('button');
            name.className = 'discord-message-name';
            name.textContent = own ? 'You' : message.senderUsername;
            name.onclick = () => openPlayerProfile(message.senderUsername);
            const time = document.createElement('span');
            time.className = 'discord-message-time';
            time.textContent = message.timestamp ? new Date(message.timestamp).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
            if (message.editedAt) time.textContent += ' · edited';
            head.append(name, time);
            const text = document.createElement('div');
            text.className = 'discord-message-text';
            renderMessageText(text, message.message, me);
            body.append(head, text);
            let menu = document.createElement('div');
            if (message.id) {
                menu = buildMessageMenu({
                    own,
                    username: message.senderUsername,
                    onEdit: () => {
                        const next = prompt('Edit message:', message.message);
                        if (next && next.trim()) socket.emit('edit_direct_message', { targetUsername: activeDMTargetUser, messageId: message.id, message: next.trim() });
                    },
                    onDelete: () => {
                        if (confirm('Delete this message?')) socket.emit('delete_direct_message', { targetUsername: activeDMTargetUser, messageId: message.id });
                    },
                    onReport: () => {
                        const reason = prompt('Why are you reporting this message?') || 'No reason given';
                        socket.emit('report_message', { type:'dm', targetUsername: activeDMTargetUser, messageId: message.id, reason });
                    }
                });
            }
            row.append(avatar, body, menu);
            container.appendChild(row);
        });
        container.scrollTop = container.scrollHeight;
    };

    socket.on('dm_history_updated', data => {
        if (data.targetUsername === activeDMTargetUser && !activeGroupId) renderDMMessages(data.history || []);
    });
    socket.on('report_submitted', () => showToast('Report sent to moderators.', '🛡️'));

    // ------------------------------------------------------------------
    // GROUP CHATS
    // ------------------------------------------------------------------
    function injectGroupsUI() {
        const header = document.querySelector('#messagesTab > .flex.justify-between');
        if (header && !document.getElementById('createGroupButton')) {
            const actions = header.lastElementChild?.parentElement === header ? header : null;
            const button = document.createElement('button');
            button.id = 'createGroupButton';
            button.className = 'bg-purple-600 hover:bg-purple-500 text-white font-black text-xs px-4 py-2 rounded-xl';
            button.textContent = '+ CREATE GROUP';
            button.onclick = openCreateGroupModal;
            header.appendChild(button);
        }
        if (!document.getElementById('createGroupModal')) {
            const modal = document.createElement('div');
            modal.id = 'createGroupModal';
            modal.className = 'hidden fixed inset-0 modal-overlay z-[90] flex items-center justify-center p-4 exclusive-modal';
            modal.innerHTML = `<div class="v12-modal-card w-full max-w-lg p-5"><div class="flex justify-between items-center"><h3 class="font-bungee text-lg text-yellow-300">CREATE GROUP</h3><button class="v12-small-btn red" id="groupModalClose">✕</button></div><input id="newGroupName" class="smash-input w-full px-3 py-2 rounded-xl text-xs mt-4" placeholder="Group name"><div class="v12-section"><div class="v12-section-title">Choose up to 49 friends</div><div id="newGroupFriendChoices" class="max-h-64 overflow-y-auto space-y-1"></div></div><button id="createGroupConfirm" class="dock-action yellow mt-3">CREATE GROUP</button></div>`;
            document.body.appendChild(modal);
            modal.querySelector('#groupModalClose').onclick = () => modal.classList.add('hidden');
            modal.querySelector('#createGroupConfirm').onclick = () => {
                const name = document.getElementById('newGroupName')?.value || '';
                const members = Array.from(document.querySelectorAll('#newGroupFriendChoices input:checked')).map(input => input.value);
                socket.emit('create_group', { name, members });
            };
        }
    }

    function openCreateGroupModal() {
        const session = secureSession();
        if (!session) return openOptionalLogin();
        const choices = document.getElementById('newGroupFriendChoices');
        choices.replaceChildren();
        const friends = getLocalFriends(AuthSession.getUser()?.username || '');
        friends.slice(0, 49).forEach(name => {
            const label = document.createElement('label');
            label.className = 'flex items-center gap-2 p-2 rounded-lg hover:bg-white/5 text-xs';
            label.innerHTML = `<input type="checkbox" value="${escapeHTML(name)}"><span>${escapeHTML(name)}</span>`;
            choices.appendChild(label);
        });
        document.querySelectorAll('.exclusive-modal').forEach(el => el.classList.add('hidden'));
        document.getElementById('createGroupModal')?.classList.remove('hidden');
    }

    function appendGroupsToSidebar() {
        const container = document.getElementById('friendsTabList');
        if (!container || !secureSession()) return;
        const label = document.createElement('div');
        label.className = 'discord-section-label';
        label.textContent = `Groups — ${groupsCache.length}`;
        container.appendChild(label);
        if (!groupsCache.length) {
            const empty = document.createElement('div');
            empty.className = 'text-[10px] text-blue-200 p-2';
            empty.textContent = 'No groups yet. Create one with your friends.';
            container.appendChild(empty);
            return;
        }
        groupsCache.forEach(group => {
            const row = document.createElement('button');
            row.className = `discord-friend v12-group-row${activeGroupId === group.id ? ' active' : ''}`;
            row.onclick = () => openGroup(group.id);
            row.innerHTML = `<div class="discord-avatar">G</div><div class="min-w-0 flex-1"><div class="text-xs font-black truncate">${escapeHTML(group.name)}</div><div class="text-[9px] text-blue-200 truncate">${group.members.length} members</div></div>`;
            container.appendChild(row);
        });
    }

    const baseUpdateFriendsTabListV12 = updateFriendsTabList;
    updateFriendsTabList = function () {
        baseUpdateFriendsTabListV12();
        appendGroupsToSidebar();
    };

    const baseShowMessagesV12 = showMessagesTab;
    showMessagesTab = function () {
        baseShowMessagesV12();
        socket.emit('get_groups');
    };

    const baseOpenDmV12 = openTabDMWith;
    openTabDMWith = function (username) {
        activeGroupId = null;
        activeGroupSnapshot = null;
        baseOpenDmV12(username);
    };

    function openGroup(groupId) {
        activeGroupId = groupId;
        activeDMTargetUser = null;
        const header = document.getElementById('activeDMChatHeader');
        if (header) header.textContent = 'Loading group…';
        const status = document.getElementById('dmChatStatus');
        if (status) status.textContent = 'Group chat';
        document.getElementById('tabDMMessages').innerHTML = '<div class="h-full grid place-items-center text-xs text-blue-200">Loading group…</div>';
        socket.emit('open_group', { groupId });
        updateFriendsTabList();
    }

    function renderGroup(group) {
        if (!group || group.id !== activeGroupId) return;
        activeGroupSnapshot = group;
        const me = AuthSession.getUser()?.username || '';
        const header = document.getElementById('activeDMChatHeader');
        if (header) header.textContent = group.name;
        const status = document.getElementById('dmChatStatus');
        if (status) status.textContent = `${group.members.length} members · Owner: ${group.owner}`;
        const avatar = document.getElementById('dmChatAvatar');
        if (avatar) avatar.textContent = 'G';
        const container = document.getElementById('tabDMMessages');
        container.replaceChildren();

        const memberCard = document.createElement('div');
        memberCard.className = 'v12-section';
        memberCard.innerHTML = `<div class="v12-group-header"><div><div class="v12-section-title">Group members</div><div class="text-[10px] text-blue-200">Owner and admins can manage members.</div></div><span class="v12-pill">${group.members.length}/50</span></div>`;
        const canManage = group.owner === me || (group.admins || []).includes(me);
        if (canManage) {
            const members = document.createElement('div');
            members.className = 'mt-2';
            group.members.forEach(memberName => {
                const row = document.createElement('div');
                row.className = 'v12-group-member';
                const role = memberName === group.owner ? 'OWNER' : (group.admins || []).includes(memberName) ? 'ADMIN' : 'MEMBER';
                row.innerHTML = `<button class="text-xs font-bold text-white" onclick="openPlayerProfile('${escapeHTML(memberName)}')">${escapeHTML(memberName)}</button><span class="v12-pill">${role}</span>`;
                if (memberName !== group.owner && memberName !== me) {
                    const actions = document.createElement('div');
                    if (group.owner === me) {
                        const admin = document.createElement('button');
                        admin.className = 'v12-small-btn';
                        admin.textContent = (group.admins || []).includes(memberName) ? 'REMOVE ADMIN' : 'MAKE ADMIN';
                        admin.onclick = () => socket.emit('group_member_action', { groupId: group.id, targetUsername: memberName, action: (group.admins || []).includes(memberName) ? 'remove_admin' : 'make_admin' });
                        actions.appendChild(admin);
                    }
                    const remove = document.createElement('button');
                    remove.className = 'v12-small-btn red ml-1'; remove.textContent = 'REMOVE';
                    remove.onclick = () => socket.emit('group_member_action', { groupId: group.id, targetUsername: memberName, action:'remove' });
                    actions.appendChild(remove);
                    row.appendChild(actions);
                }
                members.appendChild(row);
            });
            memberCard.appendChild(members);
        }
        const partyBar = document.createElement('div');
        partyBar.className = 'v12-section';
        partyBar.innerHTML = '<div class="v12-section-title">Party</div><button class="dock-action yellow">🎮 START PARTY</button>';
        partyBar.querySelector('button').onclick = () => {
            const choice = prompt('Start which party? Type: 1v1, ffa12, or ffa24', 'ffa12');
            if (!choice) return;
            const mode = choice.toLowerCase().replace(/\s+/g, '');
            if (!['1v1','ffa12','ffa24'].includes(mode)) return showToast('Use 1v1, ffa12, or ffa24.', '⚠️');
            let smashUrl = '';
            if (mode === '1v1') {
                const raw = prompt('Paste the Smash Karts room link/code for this 1v1:') || '';
                smashUrl = extractSmashUrlClient(raw);
                if (!smashUrl) return showToast('That is not a valid Smash Karts room link/code.', '❌');
            }
            socket.emit('create_group_party', { groupId: group.id, mode, smashUrl });
        };
        container.appendChild(partyBar);

        (group.messages || []).forEach(message => {
            const own = message.senderUsername === me;
            const row = document.createElement('div');
            row.className = 'discord-message';
            const av = document.createElement('button');
            av.className = 'discord-avatar big'; av.textContent = String(message.senderUsername || '?').slice(0,2).toUpperCase();
            av.onclick = () => openPlayerProfile(message.senderUsername);
            const body = document.createElement('div'); body.className = 'min-w-0';
            const head = document.createElement('div');
            head.innerHTML = `<button class="discord-message-name" onclick="openPlayerProfile('${escapeHTML(message.senderUsername)}')">${escapeHTML(message.senderUsername)}</button><span class="discord-message-time">${message.timestamp ? new Date(message.timestamp).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : ''}${message.editedAt ? ' · edited' : ''}</span>`;
            const text = document.createElement('div'); text.className = 'discord-message-text'; renderMessageText(text, message.message, me);
            if (message.type === 'party' && message.party?.roomId) {
                const party = document.createElement('div');
                party.className = 'v12-section mt-2';
                party.innerHTML = `<div class="font-black text-yellow-300">🎮 ${String(message.party.mode || '').toUpperCase()} PARTY</div><div class="text-[10px] text-blue-200 mt-1">${message.party.maxPlayers || 2} player lobby</div>`;
                const join = document.createElement('button');
                join.className = 'v12-small-btn green mt-2';
                join.textContent = 'JOIN LOBBY';
                join.onclick = () => socket.emit('rejoin_room', { roomId: message.party.roomId });
                party.appendChild(join);
                body.append(head, text, party);
            } else {
                body.append(head, text);
            }
            const menu = buildMessageMenu({
                own,
                username: message.senderUsername,
                onEdit: () => {
                    const next = prompt('Edit message:', message.message);
                    if (next && next.trim()) socket.emit('edit_group_message', { groupId:group.id, messageId:message.id, message:next.trim() });
                },
                onDelete: () => {
                    if (confirm('Delete this message?')) socket.emit('delete_group_message', { groupId:group.id, messageId:message.id });
                },
                onReport: () => {
                    const reason = prompt('Why are you reporting this message?') || 'No reason given';
                    socket.emit('report_message', { type:'group', groupId:group.id, messageId:message.id, reason });
                }
            });
            row.append(av, body, menu); container.appendChild(row);
        });
        container.scrollTop = container.scrollHeight;
    }

    const baseSendDmV12 = sendTabDM;
    sendTabDM = function () {
        if (!activeGroupId) return baseSendDmV12();
        const input = document.getElementById('tabDMInput');
        const message = String(input?.value || '').trim();
        if (!message) return;
        socket.emit('send_group_message', { groupId: activeGroupId, message });
        input.value = '';
        input.focus();
    };

    socket.on('group_list', groups => { groupsCache = Array.isArray(groups) ? groups : []; updateFriendsTabList(); });
    socket.on('group_list_changed', () => socket.emit('get_groups'));
    socket.on('group_created', group => { document.getElementById('createGroupModal')?.classList.add('hidden'); showToast(`Group created: ${group.name}`, '👥'); socket.emit('get_groups'); openGroup(group.id); });
    socket.on('group_snapshot', group => { if (group?.id === activeGroupId) renderGroup(group); socket.emit('get_groups'); });
    socket.on('group_message', data => { if (data.groupId === activeGroupId) renderGroup(data.group); else { incrementUnreadBadge(); showToast(`New group message`, '👥'); } socket.emit('get_groups'); });
    socket.on('group_mention', data => showToast(`${data.from} mentioned you in ${data.groupName}`, '@'));
    socket.on('group_error', data => showToast(data?.message || 'Group action failed.', '❌'));

    // ------------------------------------------------------------------
    // TOURNAMENTS
    // ------------------------------------------------------------------
    function injectTournamentUI() {
        const sidebar = document.querySelector('#mainDashboard aside');
        if (sidebar && !document.getElementById('btnNavTournaments')) {
            const btn = document.createElement('button');
            btn.id = 'btnNavTournaments'; btn.className = 'sidebar-btn hidden w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg'; btn.title='Tournaments'; btn.textContent='TOURNEY'; btn.onclick=openTournamentPage;
            const music = document.getElementById('btnNavMusic'); sidebar.insertBefore(btn, music || null);
        }
        const setup = document.getElementById('setupTab');
        if (setup?.parentElement && !document.getElementById('tournamentTab')) {
            const tab = document.createElement('div'); tab.id='tournamentTab'; tab.className='tab-content hidden space-y-4';
            tab.innerHTML = `<div class="flex justify-between items-center border-b border-white/10 pb-4"><div><h2 class="font-bungee text-xl text-yellow-300">🏆 TOURNAMENTS</h2><p class="text-xs text-blue-200">Only available public tournaments and your private invites appear here.</p></div><button class="v12-small-btn" onclick="socket.emit('get_tournaments')">↻ REFRESH</button></div><div id="tournamentCreateArea"></div><div id="tournamentAvailable"></div>`;
            setup.parentElement.insertBefore(tab, setup);
        }
    }

    window.openTournamentPage = function () {
        document.querySelectorAll('.tab-content').forEach(el=>el.classList.add('hidden'));
        document.querySelectorAll('.sidebar-btn').forEach(btn=>btn.classList.remove('active'));
        document.getElementById('tournamentTab')?.classList.remove('hidden');
        document.getElementById('btnNavTournaments')?.classList.add('active');
        socket.emit('get_tournaments');
    };

    function renderTournamentPage() {
        const available = document.getElementById('tournamentAvailable');
        const create = document.getElementById('tournamentCreateArea');
        if (!available || !create) return;
        create.replaceChildren();
        if (canCreateTournament) {
            const panel = document.createElement('div'); panel.className='hub-card mb-4';
            panel.innerHTML = `<div class="v12-section-title">Create tournament</div><div class="grid grid-cols-1 md:grid-cols-2 gap-2"><input id="tName" class="smash-input px-3 py-2 rounded-xl text-xs" placeholder="Tournament name"><select id="tMode" class="smash-input px-3 py-2 rounded-xl text-xs"><option value="1v1">1v1</option><option value="ffa">FFA</option></select><input id="tCapacity" type="number" min="4" max="64" value="16" class="smash-input px-3 py-2 rounded-xl text-xs" placeholder="Players"><input id="tStart" type="datetime-local" class="smash-input px-3 py-2 rounded-xl text-xs"><select id="tPrivacy" class="smash-input px-3 py-2 rounded-xl text-xs"><option value="public">Public</option><option value="private">Private invite-only</option></select><input id="tInvites" class="smash-input px-3 py-2 rounded-xl text-xs" placeholder="Private invites: name1, name2"></div><textarea id="tRules" class="smash-input w-full px-3 py-2 rounded-xl text-xs mt-2" rows="3" placeholder="Rules"></textarea><button id="tCreateBtn" class="dock-action yellow mt-2">CREATE TOURNAMENT</button>`;
            create.appendChild(panel);
            panel.querySelector('#tCreateBtn').onclick=()=>{
                const mode=document.getElementById('tMode').value;
                let capacity=Number(document.getElementById('tCapacity').value||16);
                if(mode==='ffa') capacity=capacity>=24?24:12;
                const startRaw=document.getElementById('tStart').value;
                socket.emit('create_tournament',{name:document.getElementById('tName').value,mode,capacity,startAt:startRaw?new Date(startRaw).getTime():Date.now(),isPublic:document.getElementById('tPrivacy').value==='public',invited:document.getElementById('tInvites').value,rules:document.getElementById('tRules').value});
            };
        }
        available.replaceChildren();
        if (!tournamentsCache.length) {
            available.innerHTML='<div class="hub-card text-center text-xs text-blue-200">No tournaments are available to you right now.</div>';
            return;
        }
        tournamentsCache.forEach(t=>{
            const card=document.createElement('div'); card.className='v12-tournament-card';
            const registered=(t.participants||[]).includes(AuthSession.getUser()?.username||'');
            card.innerHTML=`<div class="flex justify-between gap-3"><div><div class="font-bungee text-sm text-white">${escapeHTML(t.name)}</div><div class="text-[10px] text-blue-200 mt-1">${String(t.mode).toUpperCase()} · ${(t.participants||[]).length}/${t.capacity} · ${t.isPublic?'Public':'Private'} · Host: ${escapeHTML(t.hostUsername)}</div><div class="text-[10px] text-blue-200">${new Date(t.startAt).toLocaleString()}</div></div><span class="v12-pill">${escapeHTML(t.status)}</span></div><div class="text-xs text-white/80 mt-2 whitespace-pre-wrap">${escapeHTML(t.rules||'No extra rules.')}</div><div class="flex gap-2 flex-wrap mt-3" data-actions></div><div data-bracket></div>`;
            const actions=card.querySelector('[data-actions]');
            if(t.status==='registration'&&!registered){const reg=document.createElement('button');reg.className='v12-small-btn green';reg.textContent='REGISTER';reg.onclick=()=>socket.emit('register_tournament',{tournamentId:t.id});actions.appendChild(reg);} else if(registered){actions.insertAdjacentHTML('beforeend','<span class="v12-pill">✓ REGISTERED</span>');}
            const mine=t.hostUsername===AuthSession.getUser()?.username||accountState?.roles?.owner;
            if(mine&&t.status==='registration'){const start=document.createElement('button');start.className='v12-small-btn yellow';start.textContent='START TOURNAMENT';start.onclick=()=>{if(confirm('Close registration and start?'))socket.emit('start_tournament',{tournamentId:t.id});};actions.appendChild(start);}
            if(mine&&!t.isPublic){const invite=document.createElement('button');invite.className='v12-small-btn purple';invite.textContent='INVITE PLAYER';invite.onclick=()=>{const username=prompt('Username to invite:');if(username)socket.emit('invite_tournament_player',{tournamentId:t.id,username});};actions.appendChild(invite);}
            const bracket=card.querySelector('[data-bracket]');
            if(t.bracket?.type==='1v1'){
                bracket.className='v12-bracket';
                (t.bracket.rounds||[]).forEach(round=>{const col=document.createElement('div');col.className='v12-round';col.innerHTML=`<div class="v12-section-title">${escapeHTML(round.name)}</div>`;(round.matches||[]).forEach(m=>{const match=document.createElement('div');match.className='v12-match';match.innerHTML=`<div>${escapeHTML(m.a||'BYE')}</div><div class="text-blue-300 text-[9px]">vs</div><div>${escapeHTML(m.b||'BYE')}</div>`;col.appendChild(match);});bracket.appendChild(col);});
            } else if(t.bracket?.type==='ffa'){
                bracket.className='v12-section'; bracket.innerHTML=`<div class="v12-section-title">FFA heats</div>${(t.bracket.heats||[]).map((heat,i)=>`<div class="text-xs mt-2"><b>Heat ${i+1}:</b> ${heat.map(escapeHTML).join(', ')||'Waiting'}</div>`).join('')}`;
            }
            available.appendChild(card);
        });
    }

    socket.on('tournament_list', data=>{tournamentsCache=Array.isArray(data?.tournaments)?data.tournaments:[];canCreateTournament=!!data?.canCreate;updateConditionalNavigation();renderTournamentPage();});
    socket.on('tournament_created', t=>{showToast(`Tournament created: ${t.name}`,'🏆');socket.emit('get_tournaments');});
    socket.on('tournament_invite', t=>{showToast(`Private tournament invite: ${t.name}`,'🏆');socket.emit('get_tournaments');});
    socket.on('tournament_error', data=>showToast(data?.message||'Tournament action failed.','❌'));

    // ------------------------------------------------------------------
    // STREAMER PAGE
    // ------------------------------------------------------------------
    function injectStreamerUI() {
        const sidebar=document.querySelector('#mainDashboard aside');
        if(sidebar&&!document.getElementById('btnNavStreamer')){const btn=document.createElement('button');btn.id='btnNavStreamer';btn.className='sidebar-btn hidden w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg';btn.textContent='STREAM';btn.title='Streamer tools';btn.onclick=openStreamerPage;const music=document.getElementById('btnNavMusic');sidebar.insertBefore(btn,music||null);}
        const setup=document.getElementById('setupTab');
        if(setup?.parentElement&&!document.getElementById('streamerTab')){const tab=document.createElement('div');tab.id='streamerTab';tab.className='tab-content hidden space-y-4';tab.innerHTML=`<h2 class="font-bungee text-xl text-pink-300">STREAMER TOOLS</h2><div class="hub-card"><div class="grid md:grid-cols-2 gap-3"><label class="v12-section"><div class="v12-section-title">Live badge</div><input id="streamerLiveToggle" type="checkbox"> <span class="text-xs">Show LIVE on your public profile</span></label><label class="v12-section"><div class="v12-section-title">Hide room code</div><input id="streamerHideCode" type="checkbox"> <span class="text-xs">Hide your room code on your own game bar while streaming</span></label><label class="v12-section"><div class="v12-section-title">Streamer-safe notifications</div><input id="streamerSafeNotifications" type="checkbox"> <span class="text-xs">Reduce private info in popups</span></label></div></div>`;setup.parentElement.insertBefore(tab,setup);tab.querySelector('#streamerLiveToggle').onchange=e=>socket.emit('set_streamer_live',{live:e.target.checked});['streamerHideCode','streamerSafeNotifications'].forEach(id=>tab.querySelector('#'+id).onchange=saveStreamerPrefs);}
    }
    function streamerPrefs(){return readLocal(STREAMER_PREF_KEY,{hideCode:false,safeNotifications:false});}
    function saveStreamerPrefs(){const prefs={hideCode:!!document.getElementById('streamerHideCode')?.checked,safeNotifications:!!document.getElementById('streamerSafeNotifications')?.checked};writeLocal(STREAMER_PREF_KEY,prefs);if(secureSession()?.token)socket.emit('update_saved_settings',{streamerHideCode:prefs.hideCode,streamerSafeNotifications:prefs.safeNotifications});const code=document.getElementById('copyRoomCodeBtn');if(code)code.style.visibility=prefs.hideCode?'hidden':'';}
    window.openStreamerPage=function(){document.querySelectorAll('.tab-content').forEach(el=>el.classList.add('hidden'));document.querySelectorAll('.sidebar-btn').forEach(btn=>btn.classList.remove('active'));document.getElementById('streamerTab')?.classList.remove('hidden');document.getElementById('btnNavStreamer')?.classList.add('active');const prefs=streamerPrefs();if(document.getElementById('streamerLiveToggle'))document.getElementById('streamerLiveToggle').checked=!!accountState?.streamerLive;if(document.getElementById('streamerHideCode'))document.getElementById('streamerHideCode').checked=!!prefs.hideCode;if(document.getElementById('streamerSafeNotifications'))document.getElementById('streamerSafeNotifications').checked=!!prefs.safeNotifications;};
    socket.on('streamer_state',data=>{if(accountState)accountState.streamerLive=!!data?.live;injectHeaderBadges();});

    // ------------------------------------------------------------------
    // RANKED / CASUAL
    // ------------------------------------------------------------------
    let queueType = localStorage.getItem(QUEUE_KEY) === 'ranked' ? 'ranked' : 'casual';
    function injectQueueSelector() {
        if (document.getElementById('v12QueueSelector')) return;
        const setup=document.getElementById('setupTab');
        const createButton=setup?.querySelector('button[onclick="createLobby()"]');
        if(setup&&createButton){const wrap=document.createElement('div');wrap.id='v12QueueSelector';wrap.innerHTML='<button class="v12-queue-btn" data-q="casual">CASUAL</button><button class="v12-queue-btn" data-q="ranked">RANKED</button>';setup.insertBefore(wrap,createButton);wrap.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{queueType=btn.dataset.q;localStorage.setItem(QUEUE_KEY,queueType);if(secureSession()?.token)socket.emit('update_saved_settings',{queueType});refreshQueueButtons();});}
        const ffa=document.getElementById('ffaTab');
        if(ffa&&!document.getElementById('v12FfaQueue')){const wrap=document.createElement('div');wrap.id='v12FfaQueue';wrap.className='hub-card';wrap.innerHTML='<span class="dock-label">Match type</span><div id="v12FfaQueueInner" class="flex gap-2"><button class="v12-queue-btn flex-1" data-q="casual">CASUAL</button><button class="v12-queue-btn flex-1" data-q="ranked">RANKED</button></div>';ffa.insertBefore(wrap,ffa.children[1]||null);wrap.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{queueType=btn.dataset.q;localStorage.setItem(QUEUE_KEY,queueType);if(secureSession()?.token)socket.emit('update_saved_settings',{queueType});refreshQueueButtons();});}
        refreshQueueButtons();
    }
    function refreshQueueButtons(){document.querySelectorAll('[data-q]').forEach(btn=>btn.classList.toggle('active',btn.dataset.q===queueType));}

    createLobby = function () {
        const user=AuthSession.getUser();
        let smashUrlInput=document.getElementById('smashUrl')?.value.trim()||'';
        smashUrlInput=extractSmashUrlClient(smashUrlInput);
        if(!smashUrlInput)return showToast('Error: A valid Smash Karts room link or code is required!','⚠️');
        socket.emit('create_room',{playerName:user?.username||'Player',smashUrl:smashUrlInput,winCondition:document.getElementById('winCondition')?.value||'First to 3',mode:'1v1',queueType});
    };
    playFFAFromPage=function(){socket.emit('play_ffa',{queueType});};
    createFFAFromPage=function(){socket.emit('create_ffa_lobby',{maxPlayers:Number(document.getElementById('ffaMaxPlayers')?.value||12),isPublic:document.getElementById('ffaPrivacy')?.value!=='private',queueType});};

    // ------------------------------------------------------------------
    // OWNER / DEV ADMIN PANEL
    // ------------------------------------------------------------------
    function injectAdminPanel() {
        if (document.getElementById('adminModal')) return;
        const modal=document.createElement('div');modal.id='adminModal';modal.className='hidden fixed inset-0 modal-overlay z-[100] flex items-center justify-center p-4 exclusive-modal';
        modal.innerHTML=`<div class="v12-modal-card w-full max-w-6xl p-5 max-h-[94vh] overflow-hidden"><div class="flex justify-between items-center gap-3 mb-3"><div><h2 class="font-bungee text-xl text-purple-300">🛡 OWNER / DEV CONTROL CENTER</h2><p class="text-[10px] text-blue-200">PRIME only. Server-enforced permissions.</p></div><button id="adminClose" class="v12-small-btn red">✕ CLOSE</button></div><div id="adminStats" class="flex gap-2 flex-wrap mb-3"></div><div class="v12-grid"><div class="v12-list"><input id="adminSearch" class="smash-input w-full px-3 py-2 rounded-xl text-xs mb-2" placeholder="Search players..."><div id="adminUserList"></div></div><div class="v12-detail"><div id="adminUserDetail" class="text-xs text-blue-200">Select an account.</div><div class="v12-section"><div class="v12-section-title">Reports</div><div id="adminReports" class="max-h-44 overflow-y-auto"></div></div><div class="v12-section"><div class="v12-section-title">Audit log</div><div id="adminAudit" class="max-h-40 overflow-y-auto"></div></div></div></div></div>`;
        document.body.appendChild(modal);modal.querySelector('#adminClose').onclick=()=>modal.classList.add('hidden');modal.querySelector('#adminSearch').oninput=()=>renderAdminUsers(window.__v12AdminData);
    }

    window.openAdminPanel = function () {
        if (!accountState?.roles?.owner) return;
        document.querySelectorAll('.exclusive-modal').forEach(el=>el.classList.add('hidden'));
        document.getElementById('adminModal')?.classList.remove('hidden');
        socket.emit('admin_get_dashboard');
    };

    function renderAdminUsers(data) {
        if(!data)return;window.__v12AdminData=data;
        const list=document.getElementById('adminUserList');if(!list)return;list.replaceChildren();
        const q=String(document.getElementById('adminSearch')?.value||'').toLowerCase();
        (data.users||[]).filter(u=>!q||u.username.toLowerCase().includes(q)||u.email.toLowerCase().includes(q)).forEach(user=>{const btn=document.createElement('button');btn.className=`v12-user-row${adminSelectedUsername===user.username?' active':''}`;btn.innerHTML=`<div><div class="font-black text-xs">${escapeHTML(user.username)} <span class="text-yellow-300">L${user.level}</span></div><div class="text-[9px] text-blue-200">${escapeHTML(user.email)} · ${user.online?'online':'offline'}</div><div class="flex gap-1 mt-1">${badgeHTML(user.roles)}</div></div><span>›</span>`;btn.onclick=()=>{adminSelectedUsername=user.username;renderAdminUsers(data);renderAdminDetail(user);};list.appendChild(btn);});
    }

    function renderAdminDetail(user) {
        const box=document.getElementById('adminUserDetail');if(!box)return;
        if(user.roles?.owner){box.innerHTML=`<div class="v12-section"><div class="font-bungee text-lg text-purple-300">${escapeHTML(user.username)} · OWNER / DEV</div><p class="text-xs text-blue-200 mt-2">The OWNER role cannot be edited, banned, muted, renamed, or transferred from this panel.</p></div>`;return;}
        box.innerHTML=`<div class="flex justify-between gap-3"><div><div class="font-bungee text-lg text-white">${escapeHTML(user.username)}</div><div class="text-[10px] text-blue-200">${escapeHTML(user.email)}</div></div><div class="flex gap-1">${badgeHTML(user.roles)}</div></div>
        <div class="v12-section"><div class="v12-section-title">Permissions</div><label class="mr-3"><input id="admMod" type="checkbox" ${user.roles?.moderator?'checked':''}> MOD</label><label class="mr-3"><input id="admStreamer" type="checkbox" ${user.roles?.streamer?'checked':''}> STREAMER</label><label><input id="admTourney" type="checkbox" ${user.roles?.tourneyHost?'checked':''}> TOURNEY HOST</label><button id="admSaveRoles" class="v12-small-btn purple ml-2">SAVE ROLES</button></div>
        <div class="v12-section"><div class="v12-section-title">Moderation</div><input id="admReason" class="smash-input w-full px-2 py-2 rounded-lg text-xs" placeholder="Reason / note"><div class="flex gap-1 flex-wrap mt-2"><button data-action="warn" class="v12-small-btn yellow">WARN</button><button data-action="mute" data-duration="600000" class="v12-small-btn">MUTE 10M</button><button data-action="mute" data-duration="3600000" class="v12-small-btn">MUTE 1H</button><button data-action="mute" data-duration="86400000" class="v12-small-btn">MUTE 24H</button><button data-action="unmute" class="v12-small-btn">UNMUTE</button><button data-action="kick" class="v12-small-btn red">KICK</button><button data-action="ban" data-duration="3600000" class="v12-small-btn red">BAN 1H</button><button data-action="ban" data-duration="86400000" class="v12-small-btn red">BAN 24H</button><button data-action="ban" data-duration="604800000" class="v12-small-btn red">BAN 7D</button><button data-action="ban" data-duration="permanent" class="v12-small-btn red">PERMA BAN</button><button data-action="unban" class="v12-small-btn green">UNBAN</button><button data-action="clear_warnings" class="v12-small-btn">CLEAR WARNINGS</button><button data-action="reset_avatar" class="v12-small-btn">RESET PFP</button></div><div class="text-[10px] text-blue-200 mt-2">Warnings: ${user.warnings||0} · Muted: ${user.mutedUntil?String(user.mutedUntil):'No'} · Banned: ${user.bannedUntil?String(user.bannedUntil):'No'}</div></div>
        <div class="v12-section"><div class="v12-section-title">Progress / skill</div><div class="grid grid-cols-3 gap-2"><input id="admLevel" type="number" min="1" max="200" value="${user.level}" class="smash-input px-2 py-2 rounded-lg text-xs"><input id="admR1" type="number" value="${user.rating1v1}" class="smash-input px-2 py-2 rounded-lg text-xs"><input id="admRF" type="number" value="${user.ratingFFA}" class="smash-input px-2 py-2 rounded-lg text-xs"></div><button id="admSaveProgress" class="v12-small-btn green mt-2">SAVE LEVEL + RATINGS</button></div>
        <div class="v12-section"><div class="v12-section-title">Account tools</div><button id="admRename" class="v12-small-btn">FORCE USERNAME</button> <button id="admProfile" class="v12-small-btn">OPEN PROFILE</button></div>`;
        box.querySelector('#admSaveRoles').onclick=()=>socket.emit('admin_set_roles',{username:user.username,roles:{moderator:box.querySelector('#admMod').checked,streamer:box.querySelector('#admStreamer').checked,tourneyHost:box.querySelector('#admTourney').checked}});
        box.querySelectorAll('[data-action]').forEach(btn=>btn.onclick=()=>{const reason=box.querySelector('#admReason').value||'';const action=btn.dataset.action;if((action==='ban'||action==='kick')&&!reason&&!confirm('No reason entered. Continue?'))return;socket.emit('admin_moderation_action',{username:user.username,action,duration:btn.dataset.duration,reason});});
        box.querySelector('#admSaveProgress').onclick=()=>socket.emit('admin_set_progress',{username:user.username,level:Number(box.querySelector('#admLevel').value),rating1v1:Number(box.querySelector('#admR1').value),ratingFFA:Number(box.querySelector('#admRF').value)});
        box.querySelector('#admRename').onclick=()=>{const next=prompt('Force new username for '+user.username+':');if(next)socket.emit('admin_force_username',{username:user.username,newUsername:next});};
        box.querySelector('#admProfile').onclick=()=>{document.getElementById('adminModal').classList.add('hidden');openPlayerProfile(user.username);};
    }

    function renderAdminDashboard(data) {
        const stats=document.getElementById('adminStats');if(stats)stats.innerHTML=Object.entries(data.stats||{}).map(([k,v])=>`<span class="v12-pill">${escapeHTML(k)}: ${v}</span>`).join('');
        renderAdminUsers(data);
        if(adminSelectedUsername){const user=(data.users||[]).find(u=>u.username===adminSelectedUsername);if(user)renderAdminDetail(user);}
        const reports=document.getElementById('adminReports');if(reports){reports.replaceChildren();(data.reports||[]).slice(0,50).forEach(report=>{const row=document.createElement('div');row.className='p-2 border-b border-white/10 text-[10px]';row.innerHTML=`<div><b>${escapeHTML(report.reporter)}</b> reported <b>${escapeHTML(report.reportedUser)}</b> · ${escapeHTML(report.location)} · <span class="v12-pill">${escapeHTML(report.status)}</span></div><div class="text-blue-200 mt-1">${escapeHTML(report.reason)}</div><div class="mt-1">${(report.context||[]).map(c=>`<div>${escapeHTML(c.senderUsername)}: ${escapeHTML(c.message)}</div>`).join('')}</div>`;if(report.status==='open'){const a=document.createElement('div');a.className='flex gap-1 mt-2';['resolved','dismissed'].forEach(status=>{const b=document.createElement('button');b.className='v12-small-btn';b.textContent=status.toUpperCase();b.onclick=()=>socket.emit('resolve_report',{reportId:report.id,status});a.appendChild(b);});row.appendChild(a);}reports.appendChild(row);});}
        const audit=document.getElementById('adminAudit');if(audit){audit.innerHTML=(data.audit||[]).slice(0,100).map(item=>`<div class="text-[9px] py-1 border-b border-white/10"><b>${escapeHTML(item.actor)}</b> · ${escapeHTML(item.action)} · ${escapeHTML(item.target)}<div class="text-blue-300">${new Date(item.timestamp).toLocaleString()} ${escapeHTML(item.details||'')}</div></div>`).join('');}
    }
    socket.on('admin_dashboard',renderAdminDashboard);socket.on('admin_refresh',()=>socket.emit('admin_get_dashboard'));socket.on('admin_error',data=>showToast(data?.message||'Admin action failed.','❌'));socket.on('moderation_action_complete',data=>{const labels={ban:'Banned',unban:'Unbanned',kick:'Kicked',mute:'Muted',unmute:'Unmuted',warn:'Warned',clear_warnings:'Warnings cleared for',reset_avatar:'PFP reset for'};showToast(`${labels[data?.action]||'Updated'} ${data?.username||'player'}.`,'🛡️');if(lastOpenedProfileUsername&&String(lastOpenedProfileUsername||'').toLowerCase()===String(data?.username||'').toLowerCase())setTimeout(()=>socket.emit('get_public_profile',{username:lastOpenedProfileUsername}),150);});socket.on('moderation_report_received',()=>{if(accountState?.roles?.owner)showToast('New moderation report.','🛡️');});

    // ------------------------------------------------------------------
    // INITIALIZE
    // ------------------------------------------------------------------
    injectStyles();
    injectGuide();
    injectProfileOverlay();
    injectGroupsUI();
    injectTournamentUI();
    injectStreamerUI();
    injectQueueSelector();
    injectAdminPanel();

    // Old browser-only sessions are no longer trusted as authenticated.
    const secure = secureSession();
    if (!secure?.token) {
        const rawOld = localStorage.getItem('user_session');
        if (rawOld) localStorage.removeItem('user_session');
        accountState = null;
        const guest = AuthSession.getUser();
        socket.emit('set_user_session', { username: guest?.username || 'Guest', isGuest: true });
    } else {
        accountState = secure;
        socket.emit('account_resume', { token: secure.token });
    }

    injectHeaderBadges();
    const ownHeaderAvatar = document.getElementById('headerAvatarButton');
    if (ownHeaderAvatar) { ownHeaderAvatar.onclick = openMyProfile; ownHeaderAvatar.title = 'Open my profile'; }
    const ownSettingsAvatar = document.getElementById('settingsProfileAvatar');
    if (ownSettingsAvatar) { ownSettingsAvatar.style.cursor = 'pointer'; ownSettingsAvatar.onclick = openMyProfile; ownSettingsAvatar.title = 'Open my profile'; }
    socket.emit('get_groups');
    socket.emit('get_tournaments');

    socket.on('connect', () => {
        const session = secureSession();
        if (session?.token) socket.emit('account_resume', { token: session.token });
    });
}
