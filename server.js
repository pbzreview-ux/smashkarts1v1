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
// SERVE YOUR EXISTING SCRIPT.JS + THIS UPGRADE PACK
// =========================================================
app.get('/script.js', (req, res) => {
    const filename = ['script.js', 'script(1).js'].find(name =>
        fs.existsSync(path.join(__dirname, name))
    );

    if (!filename) {
        return res.status(404).send('Missing script.js or script(1).js');
    }

    res.type('application/javascript').send(
        fs.readFileSync(path.join(__dirname, filename), 'utf8') +
        '\nwindow.__SPOTIFY_CLIENT_ID__ = ' + JSON.stringify(process.env.SPOTIFY_CLIENT_ID || '') + ';' +
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
            createdAt: Date.now()
        };
    }
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
    const text = String(rawInput).trim().replace(/["']+/g, '');

    function validCode(code) {
        return typeof code === 'string' &&
            /^[A-Za-z0-9]{6,12}$/.test(code) &&
            /[A-Za-z]/.test(code) &&
            /\d/.test(code);
    }

    if (validCode(text)) {
        return 'https://smashkarts.io/link/?room=' + encodeURIComponent(text);
    }

    const labeled = text.match(/^Room:\s*([A-Za-z0-9]+)$/i);
    if (labeled && validCode(labeled[1])) {
        return 'https://smashkarts.io/link/?room=' + encodeURIComponent(labeled[1]);
    }

    try {
        const url = new URL(text);
        const host = url.hostname.toLowerCase();
        if (host !== 'smashkarts.io' && host !== 'www.smashkarts.io') return null;
        const code = url.searchParams.get('room');
        if (!validCode(code)) return null;
        return 'https://smashkarts.io/link/?room=' + encodeURIComponent(code);
    } catch {
        return null;
    }
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
            ready: false,
            team: room.mode === '2v2' ? null : null,
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
            player.friends = new Set();
            player.friendRequests = new Set();
            socket.emit('saved_friends', { friends: [], requests: [] });
        } else {
            const profile = profileFor(username);
            player.friends = new Set(profile.friends || []);
            player.friendRequests = new Set(profile.requests || []);
            player.isOnline = profile.isOnline !== false;
            socket.emit('saved_friends', {
                friends: profile.friends || [],
                requests: profile.requests || []
            });
            socket.emit('friend_requests_update', Array.from(player.friendRequests));
            if (!playerStats[username]) playerStats[username] = 0;
            saveHistory();
        }

        // Keep the name fresh inside any live room after guest rename / login.
        for (const room of activeRoomsMap.values()) {
            const member = room.players.find(p => p.id === socket.id);
            if (!member) continue;
            member.name = username;
            member.isGuest = isGuest;
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
        if (sender.username === target.username || sender.friends.has(target.username)) return;

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

        const otherProfile = profileFor(challengerUsername);
        if (!otherProfile.friends.includes(user.username)) otherProfile.friends.push(user.username);
        otherProfile.requests = (otherProfile.requests || []).filter(name => name !== user.username);

        savePlayer(user);
        saveHistory();
        syncFriends(user.username);
        syncFriends(challengerUsername);

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
        if (!sender.friends.has(targetName)) {
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
        if (!sender.friends.has(targetName)) return;
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
        if (!sender.friends.has(target.username)) return;

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
                { id: challengerSocketId, name: challenger.username, isGuest: challenger.isGuest, ready: false, team: null, joinedAt: Date.now() },
                { id: socket.id, name: sanitizeUsername(targetUsername || player.username), isGuest: player.isGuest, ready: false, team: null, joinedAt: Date.now() }
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

    // ---------------- NORMAL 1V1 / 2V2 ----------------
    socket.on('create_room', data => {
        const player = connectedPlayers[socket.id];
        if (!player) return;
        const cleanUrl = extractSmashUrl(data && data.smashUrl);
        if (!cleanUrl) {
            return socket.emit('room_error', { message: 'A valid Smash Karts room link or code is required.' });
        }

        leaveAllRoomsExcept(socket);
        const mode = data.mode === '2v2' ? '2v2' : '1v1';
        const roomId = crypto.randomUUID();
        const room = {
            roomId,
            hostName: player.username,
            hostSocketId: socket.id,
            smashUrl: cleanUrl,
            winCondition: escapeHTML(data.winCondition || 'First to 3'),
            mode,
            maxPlayers: mode === '2v2' ? 4 : 2,
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

    socket.on('set_lobby_team', ({ roomId, team }) => {
        const room = activeRoomsMap.get(roomId);
        if (!room || room.mode !== '2v2') return;
        const member = room.players.find(p => p.id === socket.id);
        if (!member) return;
        if (![null, 'blue', 'red'].includes(team)) return;
        member.team = team;
        io.to(roomId).emit('saved_room_update', room);
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
        for (const name of friends) {
            if (typeof name !== 'string') continue;
            const targetName = sanitizeUsername(name);
            if (targetName === player.username || player.friends.has(targetName)) continue;
            const target = profileFor(targetName);
            if (!target.requests.includes(player.username)) target.requests.push(player.username);
            syncFriends(targetName);
        }
        saveHistory();
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

    }

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

    // Keep original 1v1 / 2v2 switching, but clear FFA/Music active states.
    const originalSwitchMatchMode = switchMatchMode;
    switchMatchMode = function (mode) {
        originalSwitchMatchMode(mode);
        document.getElementById('btnNavFFA')?.classList.remove('active');
        document.getElementById('btnNavMusic')?.classList.remove('active');
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
            avatar.textContent = dmInitials(name);
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
        if (avatar) avatar.textContent = dmInitials(username);

        const challenge = document.getElementById('dmChallengeButton');
        if (challenge) challenge.classList.toggle('hidden', !dmIsOnline(username));

        const messages = document.getElementById('tabDMMessages');
        if (messages) messages.innerHTML = '<div class="h-full grid place-items-center text-xs text-blue-200">Loading messages…</div>';

        updateFriendsTabList();
        socket.emit('get_dm_history', { targetUsername: username });
    };

    window.challengeActiveDMFriend = function () {
        if (!activeDMTargetUser) return;
        if (!dmIsOnline(activeDMTargetUser)) {
            showToast(`${activeDMTargetUser} is offline.`, 'ℹ️');
            return;
        }
        initiateFriend1v1(activeDMTargetUser);
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
            avatar.textContent = dmInitials(message.senderUsername);

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
            tools: '⚡ TOOLS'
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

        const left = document.createElement('div');
        left.className = 'min-w-0';
        const name = document.createElement('div');
        name.className = 'font-bold text-xs text-white truncate';
        name.textContent = `${player.id === room.hostSocketId ? '👑 ' : '👤 '}${player.name}${player.isGuest ? ' · Guest' : ''}`;
        const meta = document.createElement('div');
        meta.className = 'text-[9px] text-blue-200';
        meta.textContent = `${player.ready ? '✅ Ready' : '⏳ Not ready'}${player.team ? ` · ${player.team === 'blue' ? '🔵 Blue' : '🔴 Red'}` : ''}`;
        left.append(name, meta);
        wrap.appendChild(left);

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
        if (teamControls) teamControls.classList.toggle('hidden', room.mode !== '2v2');

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

    function validRoomCode(raw) {
        if (!raw) return null;
        const text = String(raw).trim().replace(/["']/g, '');
        const valid = code => /^[A-Za-z0-9]{6,12}$/.test(code || '') && /[A-Za-z]/.test(code) && /\d/.test(code);
        if (valid(text)) return text;
        const label = text.match(/^Room:\s*([A-Za-z0-9]+)$/i);
        if (label && valid(label[1])) return label[1];
        try {
            const url = new URL(text);
            if (!['open.spotify.com'].includes(url.hostname.toLowerCase()) && ['smashkarts.io', 'www.smashkarts.io'].includes(url.hostname.toLowerCase())) {
                const code = url.searchParams.get('room');
                if (valid(code)) return code;
            }
            const code = url.searchParams.get('room');
            if (['smashkarts.io', 'www.smashkarts.io'].includes(url.hostname.toLowerCase()) && valid(code)) return code;
        } catch {}
        return null;
    }

    window.pasteCodeIntoCurrentLobby = function () {
        if (!activeRoomData) return showToast('You are not currently in a lobby.', '⚠️');
        const raw = window.prompt('Paste a Smash Karts room code or official room link:');
        if (raw == null) return;
        const code = validRoomCode(raw);
        if (!code) return showToast('That does not look like a valid Smash Karts room code. Nothing changed.', '❌');
        socket.emit('update_lobby_game_code', { roomId: activeRoomData.roomId, code });
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
    // SPOTIFY WEB PLAYER
    // Real Spotify Web API + Web Playback SDK. No playlist-import iframe.
    // ---------------------------------------------------------------------
    const SPOTIFY_TOKEN_KEY = 'sk_spotify_token_v2';
    const SPOTIFY_VERIFIER_KEY = 'sk_spotify_pkce_verifier_v2';
    const SPOTIFY_STATE_KEY = 'sk_spotify_oauth_state_v2';
    let spotifyPlayer = null;
    let spotifyDeviceId = null;
    let spotifySdkLoading = false;
    let spotifyCurrent = { track: null, paused: true };
    let spotifyLastResults = [];

    function spotifyClientId() {
        return String(window.__SPOTIFY_CLIENT_ID__ || '').trim();
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

        const clientId = spotifyClientId();
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

    function spotifyStatusText() {
        if (!spotifyClientId()) return 'Spotify unavailable · site owner setup needed';
        if (!spotifyIsConnected()) return 'Ready to connect your Spotify account';
        if (!spotifyDeviceId) return 'Connected · starting player…';
        return 'Connected to Spotify';
    }

    function spotifyTrackInfo() {
        const track = spotifyCurrent.track;
        return {
            title: track?.name || 'Nothing playing',
            artist: track?.artists?.map(a => a.name).join(', ') || (spotifyIsConnected() ? 'Search Spotify below' : 'Connect Spotify to start'),
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

    function renderSpotifyEverywhere() {
        const info = spotifyTrackInfo();
        const status = spotifyStatusText();
        const connected = spotifyIsConnected();
        const playIcon = spotifyCurrent.paused ? '▶' : '⏸';

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
            miniTrack.textContent = spotifyIsConnected()
                ? `🎵 ${info.title}`
                : '🎵 Connect Spotify';
            miniTrack.title = spotifyIsConnected() ? `${info.title} — ${info.artist}` : 'Open Music';
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
            button.textContent = connected ? 'CONNECTED' : 'CONNECT SPOTIFY';
        });
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
        const clientId = spotifyClientId();
        if (!clientId) {
            showToast('Spotify is not configured on this website yet. The site owner needs to set SPOTIFY_CLIENT_ID once on Render.', '🎵');
            return;
        }

        if (spotifyIsConnected()) {
            await ensureSpotifyPlayer();
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
        const clientId = spotifyClientId();

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
            showToast('Spotify connected.', '🎵');
            await ensureSpotifyPlayer();
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
        if (!spotifyIsConnected()) return null;
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

        for (const eventName of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
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
        spotifyWriteTokens(null);
        renderSpotifyEverywhere();
        showToast('Spotify disconnected.', '🎵');
    };

    async function ensureSpotifyReady() {
        if (!spotifyIsConnected()) {
            spotifyConnect();
            return false;
        }
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

    window.spotifyTogglePlayback = async function () {
        if (!(await ensureSpotifyReady())) return;
        try {
            if (spotifyCurrent.paused) await spotifyPlayer.resume();
            else await spotifyPlayer.pause();
        } catch (error) {
            showToast(error.message || 'Could not change playback.', '❌');
        }
    };

    window.spotifyNextTrack = async function () {
        if (!(await ensureSpotifyReady())) return;
        try {
            await spotifyApi(`/me/player/next?device_id=${encodeURIComponent(spotifyDeviceId)}`, { method: 'POST' });
        } catch (error) {
            showToast(error.message || 'Could not skip song.', '❌');
        }
    };

    window.spotifyPreviousTrack = async function () {
        if (!(await ensureSpotifyReady())) return;
        try {
            await spotifyApi(`/me/player/previous?device_id=${encodeURIComponent(spotifyDeviceId)}`, { method: 'POST' });
        } catch (error) {
            showToast(error.message || 'Could not go to the previous song.', '❌');
        }
    };

    window.spotifyPlayUri = async function (uri) {
        if (!(await ensureSpotifyReady())) return;
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
            row.onclick = () => spotifyPlayUri(track.uri);

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
            const data = await spotifyApi(`/search?q=${encodeURIComponent(query)}&type=track&limit=10`);
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
        if (!spotifyIsConnected()) {
            spotifyConnect();
            return;
        }
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
        if (!spotifyIsConnected()) {
            spotifyConnect();
            return;
        }
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
            renderSpotifyResults('spotifyRecentResults', tracks);
        } catch (error) {
            if (container) container.textContent = error.message || 'Could not load recently played music.';
        }
    };

    window.openSpotifyWebsite = function () {
        window.open('https://open.spotify.com/', '_blank', 'noopener,noreferrer');
    };

    handleSpotifyOAuthCallback().then(async () => {
        if (spotifyIsConnected()) {
            try { await ensureSpotifyPlayer(); } catch {}
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
        showToast(`Lobby room code updated by ${data.updatedBy}.`, '📋');
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
        if (event.key === '2') switchMatchMode('2v2');
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
