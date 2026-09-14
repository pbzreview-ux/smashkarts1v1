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
        '\n;(' + installMegaArena.toString() + ')();'
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
const dataDirectory = path.resolve(process.env.SMASH_DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(dataDirectory, { recursive: true });
const dataFile = path.join(dataDirectory, 'history.json');

const saved = fs.existsSync(dataFile)
    ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    : { profiles: {}, stats: {}, directMessages: {}, matches: {} };

saved.profiles ||= {};
saved.stats ||= {};
saved.directMessages ||= {};
saved.matches ||= {};

const profiles = Object.assign(Object.create(null), saved.profiles);
const playerStats = Object.assign(Object.create(null), saved.stats);
const directMessageStore = Object.assign(Object.create(null), saved.directMessages);
const matchHistory = Object.assign(Object.create(null), saved.matches);

function saveHistory() {
    const temp = dataFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({
        profiles,
        stats: playerStats,
        directMessages: directMessageStore,
        matches: matchHistory
    }), { mode: 0o600 });
    fs.renameSync(temp, dataFile);
}

function profileFor(username) {
    if (!profiles[username]) {
        profiles[username] = {
            friends: [],
            requests: [],
            isOnline: true,
            avatar: '',
            createdAt: Date.now()
        };
    }
    profiles[username].friends ||= [];
    profiles[username].requests ||= [];
    if (typeof profiles[username].avatar !== 'string') profiles[username].avatar = '';
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
        friends: new Set(),
        friendRequests: new Set()
    };

    socket.on('set_user_session', userData => {
        const player = connectedPlayers[socket.id];
        if (!player) return;

        const isGuest = !!(userData && userData.isGuest);
        const username = sanitizeUsername(
            userData && userData.username ? userData.username : randomGuestName()
        );

        player.username = username;
        player.email = isGuest ? null : (userData.email || null);
        player.isGuest = isGuest;
        player.isAuthenticated = !isGuest;
        player.isOnline = true;

        if (isGuest) {
            player.avatar = '';
            player.friends = new Set();
            player.friendRequests = new Set();
            socket.emit('saved_friends', { friends: [], requests: [] });
            socket.emit('saved_profile', { avatar: '' });
        } else {
            const profile = profileFor(username);
            player.avatar = profile.avatar || '';
            player.friends = new Set(profile.friends || []);
            player.friendRequests = new Set(profile.requests || []);
            player.isOnline = profile.isOnline !== false;
            socket.emit('saved_friends', {
                friends: profile.friends || [],
                requests: profile.requests || []
            });
            socket.emit('friend_requests_update', Array.from(player.friendRequests));
            socket.emit('saved_profile', { avatar: player.avatar || '' });
            if (!playerStats[username]) playerStats[username] = 0;
            saveHistory();
        }

        // Keep the name fresh inside any live room after guest rename / login.
        for (const room of activeRoomsMap.values()) {
            const member = room.players.find(p => p.id === socket.id);
            if (!member) continue;
            member.name = username;
            member.isGuest = isGuest;
            member.avatar = player.avatar || '';
            if (room.hostSocketId === socket.id) room.hostName = username;
            io.to(room.roomId).emit('saved_room_update', room);
        }

        socket.emit('session_mode', {
            username,
            isGuest,
            savesStats: !isGuest
        });

        broadcastOnlineUsers();
        broadcastLeaderboard();
        broadcastPublicRooms();
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

        const targetName = sanitizeUsername(targetUsername);
        if (!usersAreFriends(sender.username, targetName)) {
            return socket.emit('dm_error', { message: 'You can only message users on your friends list.' });
        }

        const key = getDMKey(sender.username, targetName);
        directMessageStore[key] ||= [];
        const msg = {
            senderUsername: sender.username,
            message: moderateText(message.trim()),
            timestamp: Date.now()
        };
        directMessageStore[key].push(msg);
        if (directMessageStore[key].length > 500) directMessageStore[key].shift();
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
        saveHistory();
        broadcastLeaderboard();
        socket.emit('account_match_recorded', {
            saved: true,
            matches: playerStats[player.username]
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
                { id: challengerSocketId, name: challenger.username, isGuest: challenger.isGuest, avatar: challenger.avatar || '', ready: false, team: null, joinedAt: Date.now() },
                { id: socket.id, name: sanitizeUsername(targetUsername || player.username), isGuest: player.isGuest, avatar: player.avatar || '', ready: false, team: null, joinedAt: Date.now() }
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
    socket.on('play_ffa', () => {
        const player = connectedPlayers[socket.id];
        if (!player) return;
        const room = Array.from(activeRoomsMap.values()).find(
            r => r.mode === 'ffa' && r.isPublic !== false && r.players.length < r.maxPlayers
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
            friends: p.isGuest ? [] : Array.from(p.friends || [])
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
