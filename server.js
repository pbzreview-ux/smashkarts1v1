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

        const maxPlayers = Math.max(2, Math.min(20, Number(options && options.maxPlayers) || 12));
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

    // Settings are a normal Arena Hub page now, not a floating window.
    openSettingsModal = function () {
        openHubPage('settings');
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

        const hubName = document.getElementById('hubProfileName');
        if (hubName) hubName.textContent = user.username;

        const hubMode = document.getElementById('hubProfileMode');
        if (hubMode) hubMode.textContent = isGuest
            ? 'Guest Mode · gameplay works, permanent account stats are off'
            : `Saved account · ${account.email}`;

        const hubLogin = document.getElementById('hubLoginButton');
        const hubAccount = document.getElementById('hubAccountAction');
        [hubLogin, hubAccount].forEach(button => {
            if (!button) return;
            button.textContent = isGuest ? 'LOG IN TO SAVE STATS' : 'LOG OUT TO GUEST MODE';
            button.onclick = isGuest ? openOptionalLogin : () => AuthSession.logout();
        });

        const guestMessage = document.getElementById('guestMessagesNotice');
        if (guestMessage) guestMessage.classList.toggle('hidden', !isGuest);

        const progress = document.getElementById('hubProgressText');
        if (progress) {
            if (isGuest) {
                progress.textContent = 'Guest progress stays local. Log in to keep match history and leaderboard stats permanently.';
            } else {
                const localBoard = readJSON('saved_leaderboard', []);
                const row = localBoard.find(p => p.username === account.username);
                const matches = row ? Number(row.matches || 0) : 0;
                const level = Math.max(1, Math.floor(matches / 5) + 1);
                progress.textContent = `Level ${level} · ${matches} games recorded on this browser`;
            }
        }
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

    window.openHubPage = function (panel = 'profile') {
        const game = document.getElementById('gameScreen');
        if (game && !game.classList.contains('hidden')) {
            // While playing, stay in the game and use the single dock instead.
            if (panel === 'music') openGameDock('music');
            else openGameDock('tools');
            return;
        }
        activateDashboardTab('hubTab', 'btnNavHub');
        openHubPanel(panel);
    };

    window.openHubPanel = function (name) {
        const valid = ['profile', 'music', 'history', 'notes', 'settings', 'shortcuts'];
        if (!valid.includes(name)) name = 'profile';

        document.querySelectorAll('.hub-panel').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.hub-sub-button').forEach(el => el.classList.remove('active'));
        document.getElementById(`hub${name.charAt(0).toUpperCase() + name.slice(1)}Panel`)?.classList.remove('hidden');
        document.querySelector(`[data-hub="${name}"]`)?.classList.add('active');

        if (name === 'history') requestSavedHistory();
        if (name === 'notes') loadArenaNotes();
        if (name === 'settings') syncHubSettings();
        updateAccountUI();
    };

    // Keep original 1v1 / 2v2 switching, but clear FFA/Hub active states.
    const originalSwitchMatchMode = switchMatchMode;
    switchMatchMode = function (mode) {
        originalSwitchMatchMode(mode);
        document.getElementById('btnNavFFA')?.classList.remove('active');
        document.getElementById('btnNavHub')?.classList.remove('active');
    };

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
                openHubPage('music');
            } else {
                closeExclusiveModals();
                openHubPage('settings');
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
        document.getElementById('gameMusicButton')?.classList.toggle('active', tab === 'music');
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
            if (['gameLobbyButton', 'gameMusicButton', 'arenaChatButton', 'arenaOptionsButton'].includes(button.id)) {
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
    // SPOTIFY
    // ---------------------------------------------------------------------
    window.openSpotifyWebsite = function () {
        window.open('https://open.spotify.com/', '_blank', 'noopener,noreferrer');
    };

    window.reloadSpotifyPlayer = function () {
        ['spotifyEmbedFrame', 'hubSpotifyEmbedFrame'].forEach(id => {
            const frame = document.getElementById(id);
            if (!frame) return;
            const src = frame.src;
            frame.src = 'about:blank';
            setTimeout(() => { frame.src = src; }, 40);
        });
    };

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

    function syncHubSettings() {
        const pref = readJSON(PREF_KEY, {});
        const select = document.getElementById('hubGameplayMode');
        if (select) select.value = pref.gameplay || currentGameplayMode || 'popup';
    }

    window.applyHubGameplayMode = function () {
        const mode = document.getElementById('hubGameplayMode')?.value === 'embed' ? 'embed' : 'popup';
        currentGameplayMode = mode;
        updateGameplayMode(mode);
        const pref = readJSON(PREF_KEY, {});
        pref.gameplay = mode;
        writeJSON(PREF_KEY, pref);
        const originalSelect = document.getElementById('gameplayModeSelect');
        if (originalSelect) originalSelect.value = mode;
        showToast(`Gameplay mode: ${mode === 'embed' ? 'Type in Code' : 'Popup Window'}`, '⚙️');
    };

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
    loadArenaNotes();
    syncHubSettings();
    setConnectionState(socket.connected ? 'connected' : 'connecting');

    // Ensure the guest/account session reaches the server even if the old
    // DOMContentLoaded handler already ran unusually early.
    updateUserUI();
}
