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
    // ------------------------------------------------------------------------
    // GUEST MODE: login is OPTIONAL.
    // ------------------------------------------------------------------------
    const ACCOUNT_KEY = 'user_session';
    const GUEST_KEY = 'smash_guest_profile_v3';
    const PREF_KEY = 'smash_mega_preferences_v3';
    const PROGRESS_KEY = 'smash_mega_progress_v3';
    const ROOM_HISTORY_KEY = 'smash_room_code_history_v3';
    const MUSIC_FAVORITES_KEY = 'smash_music_favorites_v3';
    const NOTES_KEY = 'smash_notes_v3';

    function safeJSON(key, fallback) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key));
            return parsed == null ? fallback : parsed;
        } catch {
            return fallback;
        }
    }

    function saveJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {}
    }

    function randomGuestNameClient() {
        return 'Guest-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    }

    function accountUser() {
        try {
            const raw = localStorage.getItem(ACCOUNT_KEY);
            if (!raw) return null;
            const user = JSON.parse(raw);
            if (!user || !user.username) return null;
            return { ...user, isGuest: false };
        } catch {
            return null;
        }
    }

    function guestUser() {
        let guest = safeJSON(GUEST_KEY, null);
        if (!guest || !guest.username) {
            guest = {
                username: randomGuestNameClient(),
                email: null,
                isGuest: true,
                createdAt: Date.now()
            };
            saveJSON(GUEST_KEY, guest);
        }
        return { ...guest, isGuest: true };
    }

    function currentArenaUser() {
        return accountUser() || guestUser();
    }

    function isAccountMode() {
        return !!accountUser();
    }

    const originalAuthLogin = AuthSession.login.bind(AuthSession);

    AuthSession.getUser = currentArenaUser;
    AuthSession.isLoggedIn = () => true;
    AuthSession.logout = function () {
        localStorage.removeItem(ACCOUNT_KEY);
        window.location.reload();
    };
    AuthSession.login = function (email, username) {
        originalAuthLogin(email, username);
        const current = accountUser();
        if (current) socket.emit('set_user_session', current);
        setTimeout(refreshAccountChrome, 0);
    };

    // Prevent guests from being auto-logged-out for inactivity.
    const originalCheckInactivity = AuthSession.checkInactivity.bind(AuthSession);
    AuthSession.checkInactivity = function () {
        if (!isAccountMode()) return;
        return originalCheckInactivity();
    };

    // ------------------------------------------------------------------------
    // PREFERENCES / PROGRESSION
    // ------------------------------------------------------------------------
    const defaults = {
        theme: 'midnight',
        accent: '#ffd318',
        compact: false,
        largeText: false,
        reducedMotion: false,
        performance: false,
        sound: true,
        chatSound: true,
        autoHideToolbar: false,
        showPlayerNames: true,
        quickChat: true,
        musicOpen: false,
        lastSpotify: '',
        lobbyFilter: 'all',
        lobbySearch: '',
        notifications: true
    };

    let prefs = { ...defaults, ...safeJSON(PREF_KEY, {}) };
    let progress = { xp: 0, sessionMatches: 0, accountMatches: 0, streak: 0, lastPlayDate: '', achievements: [], ...safeJSON(PROGRESS_KEY, {}) };
    let roomCodeHistory = safeJSON(ROOM_HISTORY_KEY, []);
    let musicFavorites = safeJSON(MUSIC_FAVORITES_KEY, []);
    let notesState = safeJSON(NOTES_KEY, { match: '', players: {} });
    let matchStartedAt = 0;
    let pageStartedAt = Date.now();
    let lastRoomId = localStorage.getItem('smash_last_room_id_v3') || '';
    let connectionStartedAt = Date.now();
    let readyState = false;

    function savePrefs() { saveJSON(PREF_KEY, prefs); }
    function saveProgress() { if (isAccountMode()) saveJSON(PROGRESS_KEY, progress); }

    function levelFromXP(xp) {
        return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1);
    }

    function addXP(amount, reason) {
        if (!isAccountMode()) return;
        const oldLevel = levelFromXP(progress.xp);
        progress.xp += Math.max(0, Number(amount) || 0);
        const newLevel = levelFromXP(progress.xp);
        saveProgress();
        updateProfileStats();
        if (newLevel > oldLevel) {
            showToast(`Level up! You reached Level ${newLevel}.`, '⭐');
            unlockAchievement('level_' + newLevel, `Reached Level ${newLevel}`);
        } else if (reason) {
            updateXPToast(reason, amount);
        }
    }

    function updateXPToast(reason, amount) {
        if (!prefs.notifications) return;
        const box = document.getElementById('megaMiniNotice');
        if (!box) return;
        box.textContent = `+${amount} XP · ${reason}`;
        box.classList.add('show');
        clearTimeout(box._timer);
        box._timer = setTimeout(() => box.classList.remove('show'), 1700);
    }

    function unlockAchievement(id, label) {
        if (!isAccountMode()) return;
        if (progress.achievements.includes(id)) return;
        progress.achievements.push(id);
        saveProgress();
        showToast(`Achievement unlocked: ${label}`, '🏅');
    }

    function updateDailyStreak() {
        if (!isAccountMode()) return;
        const today = new Date().toISOString().slice(0, 10);
        if (progress.lastPlayDate === today) return;
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        progress.streak = progress.lastPlayDate === yesterday ? (progress.streak || 0) + 1 : 1;
        progress.lastPlayDate = today;
        saveProgress();
        if (progress.streak >= 3) unlockAchievement('streak_3', '3-day streak');
        if (progress.streak >= 7) unlockAchievement('streak_7', '7-day streak');
    }

    // ------------------------------------------------------------------------
    // CSS
    // ------------------------------------------------------------------------
    const style = document.createElement('style');
    style.id = 'megaArenaStyle';
    style.textContent = `
        :root { --mega-accent:${prefs.accent}; }
        #megaAccountBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .mega-chip{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid #ffffff24;border-radius:999px;background:#0b1f55cc;color:#fff;font:800 11px Inter,sans-serif;white-space:nowrap}
        .mega-chip strong{color:var(--mega-accent)}
        .mega-button{border:1px solid #ffffff28;background:#214794;color:white;border-radius:12px;padding:9px 12px;font:900 11px Inter,sans-serif;cursor:pointer;transition:.16s transform,.16s filter}
        .mega-button:hover{filter:brightness(1.12);transform:translateY(-1px)}
        .mega-button.primary{background:var(--mega-accent);color:#12285f;border-color:#fff8}
        .mega-button.danger{background:#9f2941}
        .mega-button.good{background:#14865f}
        #megaGuestBanner{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:210;background:#0f2864ee;border:1px solid var(--mega-accent);border-radius:16px;padding:8px 12px;color:white;font:800 11px Inter,sans-serif;box-shadow:0 12px 30px #0008;display:flex;gap:10px;align-items:center}
        #megaGuestBanner.hidden{display:none}
        #megaMiniNotice{position:fixed;left:50%;bottom:20px;transform:translate(-50%,20px);opacity:0;pointer-events:none;z-index:260;background:#0e235cee;color:#fff;border:1px solid var(--mega-accent);padding:9px 13px;border-radius:999px;font:900 11px Inter,sans-serif;transition:.2s}
        #megaMiniNotice.show{opacity:1;transform:translate(-50%,0)}
        #megaConnectionBanner{position:fixed;inset:auto 12px 12px auto;z-index:230;padding:8px 10px;border-radius:12px;background:#132d6eeb;border:1px solid #ffffff30;color:#fff;font:800 10px Inter,sans-serif}
        #megaConnectionBanner.offline{background:#831f36;border-color:#ff91a5}
        #megaDrawer,#megaCommandPalette,#megaProfilePanel,#megaNotesPanel,#megaShortcutsPanel{position:fixed;z-index:240;background:#112a68f7;border:1px solid #ffffff30;color:#fff;box-shadow:0 20px 70px #000a;backdrop-filter:blur(18px)}
        #megaDrawer{right:16px;top:92px;width:min(390px,calc(100vw - 32px));max-height:calc(100dvh - 112px);overflow:auto;border-radius:20px;padding:14px}
        .mega-section{background:#071a48a8;border:1px solid #ffffff18;border-radius:16px;padding:12px;margin-top:10px}
        .mega-section h3{font:900 12px Inter,sans-serif;color:var(--mega-accent);margin:0 0 8px}
        .mega-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
        .mega-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .mega-input,.mega-select,.mega-textarea{width:100%;box-sizing:border-box;background:#061943;color:white;border:1px solid #ffffff28;border-radius:12px;padding:9px 10px;font:700 11px Inter,sans-serif;outline:none}
        .mega-input:focus,.mega-select:focus,.mega-textarea:focus{border-color:var(--mega-accent)}
        .mega-textarea{min-height:90px;resize:vertical}
        #megaCommandPalette{left:50%;top:14vh;transform:translateX(-50%);width:min(620px,calc(100vw - 32px));border-radius:22px;padding:14px}
        #megaCommandResults{max-height:55vh;overflow:auto;margin-top:8px}
        .mega-command{width:100%;text-align:left;border:0;border-radius:12px;background:transparent;color:#fff;padding:11px;cursor:pointer;font:800 12px Inter,sans-serif;display:flex;justify-content:space-between;gap:14px}
        .mega-command:hover,.mega-command.active{background:#ffffff16}
        #megaProfilePanel,#megaNotesPanel,#megaShortcutsPanel{left:50%;top:50%;transform:translate(-50%,-50%);width:min(620px,calc(100vw - 32px));max-height:82vh;overflow:auto;border-radius:22px;padding:16px}
        #gameLobbyMegaInfo{display:flex;align-items:center;gap:8px;min-width:0;max-width:min(46vw,620px);padding:7px 10px;border:1px solid #ffffff2d;border-radius:18px;background:#0e245c;color:white;font:800 11px Inter,sans-serif}
        #gameLobbyMegaCount{color:var(--mega-accent);white-space:nowrap}
        #gameLobbyMegaNames{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #megaReadyBadge{color:#72f6b7;white-space:nowrap}
        .mega-lobby-player{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:9px;border-radius:12px;background:#0d2765;border:1px solid #ffffff16;margin-bottom:6px}
        .mega-player-sub{font-size:9px;color:#9db5e8;margin-top:2px}
        .mega-ready{color:#72f6b7}.mega-notready{color:#ffca69}
        #megaLobbyTools{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}
        #megaReactionTray{position:fixed;right:20px;bottom:20px;z-index:220;display:flex;gap:6px}
        .mega-reaction{font-size:20px;animation:megaFloat 1.7s ease forwards;pointer-events:none;background:#0e245ed9;border:1px solid #ffffff2a;border-radius:999px;padding:6px 9px}
        @keyframes megaFloat{0%{transform:translateY(0) scale(.8);opacity:0}15%{opacity:1;transform:translateY(-6px) scale(1)}100%{transform:translateY(-85px) scale(1.1);opacity:0}}
        body.mega-large-text{font-size:112%}
        body.mega-compact .arena-button{padding:7px 9px!important;font-size:11px!important}
        body.mega-compact #arenaToolbar{padding:7px 12px!important;min-height:58px!important}
        body.mega-performance *{backdrop-filter:none!important;box-shadow:none!important;text-shadow:none!important}
        body.mega-reduced-motion *,body.mega-reduced-motion *:before,body.mega-reduced-motion *:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
        body.mega-theme-neon{background:radial-gradient(circle at top,#25105f,#07142e 48%,#030814)!important}
        body.mega-theme-sunset{background:radial-gradient(circle at top,#6c254c,#1c2452 45%,#08142e)!important}
        body.mega-theme-carbon{background:radial-gradient(circle at top,#27313d,#0f1720 50%,#05080d)!important}
        #megaMusicFrame{width:100%;height:152px;border:0;border-radius:12px;background:#061943}
        #megaSessionWidget{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        #megaQuickBar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
        #megaQuickBar button{font-size:13px}
        #megaOfflineToast{position:fixed;inset:0;display:none;place-items:center;z-index:300;background:#020817d9;color:#fff;text-align:center;padding:20px}
        #megaOfflineToast.show{display:grid}
        @media(max-width:760px){#gameLobbyMegaInfo{max-width:100%;width:100%}.arena-brand{width:100%}.mega-grid{grid-template-columns:1fr}#megaGuestBanner{top:auto;bottom:12px;width:calc(100vw - 24px);justify-content:center}}
    `;
    document.head.appendChild(style);

    // ------------------------------------------------------------------------
    // CORE DOM HELPERS
    // ------------------------------------------------------------------------
    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key === 'html') node.innerHTML = value;
            else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value);
        }
        for (const child of [].concat(children || [])) {
            if (child == null) continue;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return node;
    }

    function closeNode(id) {
        document.getElementById(id)?.remove();
    }

    function openLoginModal() {
        const modal = document.getElementById('authModal');
        if (modal) modal.classList.remove('hidden');
    }

    function sendCurrentSession() {
        const user = currentArenaUser();
        socket.emit('set_user_session', user);
    }

    function guestRename() {
        const current = guestUser();
        const raw = prompt('Guest name:', current.username);
        if (raw == null) return;
        const name = raw.trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20);
        if (!name) return showToast('Enter a name first.', '⚠️');
        const updated = { ...current, username: name, isGuest: true };
        saveJSON(GUEST_KEY, updated);
        sendCurrentSession();
        refreshAccountChrome();
        showToast(`Guest name changed to ${name}.`, '👤');
    }

    // Original edit-name flow would accidentally create a saved login for guests.
    const originalSaveNewUsername = window.saveNewUsername;
    window.saveNewUsername = function () {
        if (!isAccountMode()) {
            const input = document.getElementById('newUsernameInput');
            if (input && input.value.trim()) {
                const name = input.value.trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20);
                saveJSON(GUEST_KEY, { ...guestUser(), username: name, isGuest: true });
                closeEditUsernameModal();
                sendCurrentSession();
                refreshAccountChrome();
                showToast('Guest name updated. Log in if you want it tied to saved stats.', '👤');
                return;
            }
        }
        return originalSaveNewUsername && originalSaveNewUsername();
    };

    // ------------------------------------------------------------------------
    // ACCOUNT / GUEST CHROME
    // ------------------------------------------------------------------------
    function refreshAccountChrome() {
        const user = currentArenaUser();
        const tag = document.getElementById('userDisplayTag');
        if (tag) tag.textContent = user.username;

        let bar = document.getElementById('megaAccountBar');
        const header = document.querySelector('#mainDashboard header');
        if (!bar && header) {
            const oldLogout = header.querySelector('button[onclick*="AuthSession.logout"]');
            bar = el('div', { id: 'megaAccountBar' });
            if (oldLogout) oldLogout.replaceWith(bar);
            else header.appendChild(bar);
        }
        if (!bar) return;
        bar.replaceChildren();

        const modeChip = el('span', {
            class: 'mega-chip',
            html: isAccountMode()
                ? `💾 <strong>ACCOUNT</strong> · stats saved`
                : `⚡ <strong>GUEST</strong> · play instantly`
        });
        bar.appendChild(modeChip);

        const profileBtn = el('button', { class: 'mega-button', text: '👤 PROFILE' });
        profileBtn.onclick = openProfilePanel;
        bar.appendChild(profileBtn);

        const historyBtn = el('button', { class: 'mega-button', text: '📜 HISTORY' });
        historyBtn.onclick = () => {
            if (!isAccountMode()) {
                showToast('Log in to save and view match history.', '💾');
                return openLoginModal();
            }
            openHistoryPanel();
        };
        bar.appendChild(historyBtn);

        if (isAccountMode()) {
            const logout = el('button', { class: 'mega-button danger', text: 'LOG OUT' });
            logout.onclick = () => AuthSession.logout();
            bar.appendChild(logout);
        } else {
            const login = el('button', { class: 'mega-button primary', text: 'LOG IN TO SAVE STATS' });
            login.onclick = openLoginModal;
            bar.appendChild(login);
            const rename = el('button', { class: 'mega-button', text: '✏️ GUEST NAME' });
            rename.onclick = guestRename;
            bar.appendChild(rename);
        }

        let banner = document.getElementById('megaGuestBanner');
        if (!banner) {
            banner = el('div', { id: 'megaGuestBanner' });
            document.body.appendChild(banner);
        }
        banner.classList.toggle('hidden', isAccountMode());
        if (!isAccountMode()) {
            banner.replaceChildren(
                el('span', { text: 'Playing as guest — gameplay works normally; login only if you want saved stats, friends, and history.' }),
                (() => {
                    const btn = el('button', { class: 'mega-button primary', text: 'LOG IN' });
                    btn.onclick = openLoginModal;
                    return btn;
                })()
            );
        }
    }

    // ------------------------------------------------------------------------
    // PROFILE / PROGRESSION
    // ------------------------------------------------------------------------
    function updateProfileStats() {
        const level = levelFromXP(progress.xp);
        document.getElementById('megaLevelValue')?.replaceChildren(document.createTextNode(String(level)));
        document.getElementById('megaXPValue')?.replaceChildren(document.createTextNode(String(progress.xp)));
        document.getElementById('megaStreakValue')?.replaceChildren(document.createTextNode(String(progress.streak || 0)));
        document.getElementById('megaAchievementValue')?.replaceChildren(document.createTextNode(String(progress.achievements.length)));
    }

    function openProfilePanel() {
        closeNode('megaProfilePanel');
        const user = currentArenaUser();
        const panel = el('div', { id: 'megaProfilePanel' });
        const top = el('div', { class: 'mega-row' });
        top.append(
            el('div', { html: `<div style="font-size:30px">🏎️</div><div style="font-weight:900;font-size:18px">${escapeHTML(user.username)}</div><div style="font-size:10px;color:#9db5e8">${isAccountMode() ? 'Saved account profile' : 'Guest profile · stats reset/not saved to leaderboard'}</div>` }),
            (() => { const b = el('button', { class: 'mega-button', text: '✕ CLOSE' }); b.onclick = () => panel.remove(); return b; })()
        );
        top.style.justifyContent = 'space-between';
        panel.appendChild(top);

        const stats = el('div', { class: 'mega-grid mega-section' });
        const cards = [
            ['LEVEL', levelFromXP(progress.xp), 'megaLevelValue'],
            ['XP', progress.xp, 'megaXPValue'],
            ['STREAK', progress.streak || 0, 'megaStreakValue'],
            ['ACHIEVEMENTS', progress.achievements.length, 'megaAchievementValue'],
            ['SESSION MATCHES', progress.sessionMatches || 0, 'megaSessionMatches'],
            ['STATUS', isAccountMode() ? 'SAVED' : 'GUEST', 'megaStatusValue']
        ];
        cards.forEach(([label, value, id]) => {
            stats.appendChild(el('div', { class: 'mega-chip', html: `<span>${label}</span><strong id="${id}">${value}</strong>` }));
        });
        panel.appendChild(stats);

        const challenge = el('div', { class: 'mega-section' });
        challenge.appendChild(el('h3', { text: '🎯 DAILY / RANDOM CHALLENGE' }));
        const challenges = [
            'Win without using the shield power-up.',
            'Get 3 eliminations before your first death.',
            'Play one full round using a kart you rarely use.',
            'Finish a round without stopping for more than 2 seconds.',
            'Challenge a friend or join a public lobby.',
            'Use lobby chat to say GG after the match.',
            'Play one 2v2 and one FFA match.',
            'Try to survive for 90 seconds without an elimination.'
        ];
        const challengeText = el('div', { class: 'mega-chip', text: challenges[(new Date().getDate() + levelFromXP(progress.xp)) % challenges.length] });
        challengeText.style.whiteSpace = 'normal';
        challenge.appendChild(challengeText);
        const random = el('button', { class: 'mega-button', text: '🎲 RANDOMIZE' });
        random.onclick = () => challengeText.textContent = challenges[Math.floor(Math.random() * challenges.length)];
        challenge.appendChild(random);
        panel.appendChild(challenge);

        if (!isAccountMode()) {
            const login = el('div', { class: 'mega-section' });
            login.appendChild(el('h3', { text: '💾 WANT THIS TO SAVE?' }));
            login.appendChild(el('div', { text: 'Login is optional. It only unlocks persistent stats, history, friends, DMs, XP, streaks, and achievements.' }));
            const btn = el('button', { class: 'mega-button primary', text: 'LOG IN / CREATE ACCOUNT' });
            btn.onclick = openLoginModal;
            login.appendChild(btn);
            panel.appendChild(login);
        }

        document.body.appendChild(panel);
    }

    // ------------------------------------------------------------------------
    // HISTORY PANEL
    // ------------------------------------------------------------------------
    function openHistoryPanel() {
        socket.emit('get_saved_match_history');
        closeNode('megaHistoryPanel');
        const panel = el('div', { id: 'megaHistoryPanel' });
        panel.style.cssText = 'position:fixed;z-index:245;left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px,calc(100vw - 32px));max-height:82vh;overflow:auto;border-radius:22px;padding:16px;background:#112a68f7;border:1px solid #ffffff30;color:white;box-shadow:0 20px 70px #000a;backdrop-filter:blur(18px)';
        const top = el('div', { class: 'mega-row' });
        top.style.justifyContent = 'space-between';
        top.append(el('h2', { text: '📜 SAVED MATCH HISTORY' }), (() => { const b = el('button', { class: 'mega-button', text: '✕ CLOSE' }); b.onclick = () => panel.remove(); return b; })());
        panel.append(top, el('div', { id: 'megaHistoryList', text: 'Loading…' }));
        document.body.appendChild(panel);
    }

    socket.on('saved_match_history', rooms => {
        const list = document.getElementById('megaHistoryList');
        if (!list) return;
        list.replaceChildren();
        if (!rooms.length) return list.appendChild(el('div', { class: 'mega-section', text: 'No saved matches yet.' }));
        rooms.forEach(room => {
            const item = el('details', { class: 'mega-section' });
            item.appendChild(el('summary', { text: `${new Date(room.createdAt || Date.now()).toLocaleString()} · ${(room.mode || '').toUpperCase()} · ${(room.participants || []).join(', ')}` }));
            const chat = el('div', { style: 'margin-top:8px;font-size:11px' });
            (room.messages || []).slice(-30).forEach(msg => chat.appendChild(el('div', { text: `${msg.senderName}: ${msg.message}` })));
            if (!(room.messages || []).length) chat.textContent = 'No chat messages.';
            item.appendChild(chat);
            list.appendChild(item);
        });
    });

    // ------------------------------------------------------------------------
    // THEMES / ACCESSIBILITY / SETTINGS DRAWER
    // ------------------------------------------------------------------------
    function applyPrefs() {
        document.documentElement.style.setProperty('--mega-accent', prefs.accent || '#ffd318');
        document.body.classList.toggle('mega-compact', !!prefs.compact);
        document.body.classList.toggle('mega-large-text', !!prefs.largeText);
        document.body.classList.toggle('mega-reduced-motion', !!prefs.reducedMotion);
        document.body.classList.toggle('mega-performance', !!prefs.performance);
        document.body.classList.remove('mega-theme-neon', 'mega-theme-sunset', 'mega-theme-carbon');
        if (prefs.theme && prefs.theme !== 'midnight') document.body.classList.add('mega-theme-' + prefs.theme);
        savePrefs();
    }

    function makeToggle(label, key) {
        const wrap = el('label', { class: 'mega-row' });
        wrap.style.justifyContent = 'space-between';
        wrap.appendChild(el('span', { text: label }));
        const input = el('input', { type: 'checkbox' });
        input.checked = !!prefs[key];
        input.onchange = () => { prefs[key] = input.checked; applyPrefs(); };
        wrap.appendChild(input);
        return wrap;
    }

    function openMegaDrawer() {
        closeNode('megaDrawer');
        const drawer = el('div', { id: 'megaDrawer' });
        const top = el('div', { class: 'mega-row' });
        top.style.justifyContent = 'space-between';
        top.append(el('h2', { text: '⚡ ARENA PLUS' }), (() => { const b = el('button', { class: 'mega-button', text: '✕' }); b.onclick = () => drawer.remove(); return b; })());
        drawer.appendChild(top);

        const appearance = el('div', { class: 'mega-section' });
        appearance.appendChild(el('h3', { text: '🎨 APPEARANCE & PERFORMANCE' }));
        const theme = el('select', { class: 'mega-select' });
        [['midnight','Midnight'],['neon','Neon'],['sunset','Sunset'],['carbon','Carbon']].forEach(([v,l]) => theme.appendChild(el('option', { value:v, text:l })));
        theme.value = prefs.theme;
        theme.onchange = () => { prefs.theme = theme.value; applyPrefs(); };
        appearance.append(theme, makeToggle('Compact toolbar', 'compact'), makeToggle('Large text', 'largeText'), makeToggle('Reduced motion', 'reducedMotion'), makeToggle('Performance mode', 'performance'), makeToggle('Show player names in game bar', 'showPlayerNames'), makeToggle('Sound / feedback', 'sound'));
        const accent = el('input', { type: 'color', value: prefs.accent });
        accent.oninput = () => { prefs.accent = accent.value; applyPrefs(); };
        appearance.appendChild(el('div', { class: 'mega-row' }, [el('span', { text: 'Accent color' }), accent]));
        drawer.appendChild(appearance);

        const utility = el('div', { class: 'mega-section' });
        utility.appendChild(el('h3', { text: '🛠️ QUICK TOOLS' }));
        const toolGrid = el('div', { class: 'mega-grid' });
        [
            ['👤 Profile', openProfilePanel],
            ['📝 Notes', openNotesPanel],
            ['⌨️ Shortcuts', openShortcutsPanel],
            ['🔎 Command Palette', openCommandPalette],
            ['🎲 Dice', () => showToast(`You rolled ${1 + Math.floor(Math.random()*6)}.`, '🎲')],
            ['🪙 Coin Flip', () => showToast(Math.random() < .5 ? 'Heads!' : 'Tails!', '🪙')],
            ['📋 Copy Invite', copyCurrentInvite],
            ['↩️ Rejoin Last Lobby', rejoinLastRoom]
        ].forEach(([label, fn]) => { const b = el('button', { class: 'mega-button', text: label }); b.onclick = fn; toolGrid.appendChild(b); });
        utility.appendChild(toolGrid);
        drawer.appendChild(utility);

        document.body.appendChild(drawer);
    }

    // ------------------------------------------------------------------------
    // MUSIC / SPOTIFY
    // ------------------------------------------------------------------------
    function spotifyEmbedUrl(raw) {
        if (!raw) return null;
        try {
            const url = new URL(raw.trim());
            if (url.hostname !== 'open.spotify.com') return null;
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length < 2) return null;
            const type = parts[0];
            const id = parts[1];
            if (!['track','playlist','album','artist','episode','show'].includes(type)) return null;
            if (!/^[A-Za-z0-9]+$/.test(id)) return null;
            return `https://open.spotify.com/embed/${type}/${id}?utm_source=generator`;
        } catch {
            return null;
        }
    }

    function openMusicDrawer() {
        closeNode('megaMusicPanel');
        const panel = el('div', { id: 'megaMusicPanel' });
        panel.style.cssText = 'position:fixed;right:16px;top:92px;z-index:246;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 110px);overflow:auto;border-radius:20px;padding:14px;background:#112a68f7;border:1px solid #ffffff30;color:#fff;box-shadow:0 20px 70px #000a;backdrop-filter:blur(18px)';
        const top = el('div', { class: 'mega-row' });
        top.style.justifyContent = 'space-between';
        top.append(el('h2', { text: '🎵 SPOTIFY MUSIC' }), (() => { const b = el('button', { class: 'mega-button', text: '✕' }); b.onclick = () => panel.remove(); return b; })());
        panel.appendChild(top);

        const input = el('input', { class: 'mega-input', placeholder: 'Paste Spotify track / playlist / album link…' });
        input.value = prefs.lastSpotify || '';
        const load = el('button', { class: 'mega-button primary', text: '▶ LOAD MUSIC' });
        const favorite = el('button', { class: 'mega-button', text: '⭐ FAVORITE' });
        const row = el('div', { class: 'mega-row' }, [input, load, favorite]);
        input.style.flex = '1';
        panel.appendChild(row);

        const frame = el('iframe', { id: 'megaMusicFrame', allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture', loading: 'lazy' });
        panel.appendChild(frame);

        function loadSpotify(raw, quiet = false) {
            const embed = spotifyEmbedUrl(raw);
            if (!embed) {
                if (!quiet) showToast('Paste an open.spotify.com track, playlist, album, artist, show, or episode link.', '🎵');
                return false;
            }
            frame.src = embed;
            prefs.lastSpotify = raw.trim();
            savePrefs();
            if (!quiet) showToast('Spotify loaded.', '🎵');
            return true;
        }

        load.onclick = () => loadSpotify(input.value);
        input.onkeydown = e => { if (e.key === 'Enter') loadSpotify(input.value); };
        favorite.onclick = () => {
            const raw = input.value.trim();
            if (!spotifyEmbedUrl(raw)) return showToast('Load a valid Spotify link first.', '⚠️');
            if (!musicFavorites.includes(raw)) musicFavorites.unshift(raw);
            musicFavorites = musicFavorites.slice(0, 20);
            saveJSON(MUSIC_FAVORITES_KEY, musicFavorites);
            renderFavorites();
        };

        const favBox = el('div', { class: 'mega-section' });
        favBox.appendChild(el('h3', { text: '⭐ FAVORITE SPOTIFY LINKS' }));
        const favList = el('div');
        favBox.appendChild(favList);
        panel.appendChild(favBox);

        function renderFavorites() {
            favList.replaceChildren();
            if (!musicFavorites.length) return favList.appendChild(el('div', { text: 'No favorites yet.' }));
            musicFavorites.forEach((url, index) => {
                const r = el('div', { class: 'mega-row' });
                const b = el('button', { class: 'mega-button', text: `🎵 Favorite ${index + 1}` });
                b.onclick = () => { input.value = url; loadSpotify(url); };
                const x = el('button', { class: 'mega-button danger', text: '✕' });
                x.onclick = () => { musicFavorites.splice(index,1); saveJSON(MUSIC_FAVORITES_KEY,musicFavorites); renderFavorites(); };
                r.append(b,x); favList.appendChild(r);
            });
        }
        renderFavorites();
        if (prefs.lastSpotify) loadSpotify(prefs.lastSpotify, true);
        document.body.appendChild(panel);
    }

    // ------------------------------------------------------------------------
    // NOTES
    // ------------------------------------------------------------------------
    function openNotesPanel() {
        closeNode('megaNotesPanel');
        const panel = el('div', { id: 'megaNotesPanel' });
        const top = el('div', { class: 'mega-row' });
        top.style.justifyContent = 'space-between';
        top.append(el('h2', { text: '📝 MATCH NOTES' }), (() => { const b = el('button', { class: 'mega-button', text: '✕' }); b.onclick = () => panel.remove(); return b; })());
        panel.appendChild(top);
        const text = el('textarea', { class: 'mega-textarea', placeholder: 'Write strategy, rematch notes, player observations…' });
        text.value = notesState.match || '';
        text.oninput = () => { notesState.match = text.value; saveJSON(NOTES_KEY, notesState); };
        panel.appendChild(text);
        const clear = el('button', { class: 'mega-button danger', text: 'CLEAR NOTES' });
        clear.onclick = () => { text.value = ''; notesState.match = ''; saveJSON(NOTES_KEY, notesState); };
        panel.appendChild(clear);
        document.body.appendChild(panel);
    }

    // ------------------------------------------------------------------------
    // SHORTCUTS
    // ------------------------------------------------------------------------
    function openShortcutsPanel() {
        closeNode('megaShortcutsPanel');
        const panel = el('div', { id: 'megaShortcutsPanel' });
        const top = el('div', { class: 'mega-row' });
        top.style.justifyContent = 'space-between';
        top.append(el('h2', { text: '⌨️ KEYBOARD SHORTCUTS' }), (() => { const b = el('button', { class: 'mega-button', text: '✕' }); b.onclick = () => panel.remove(); return b; })());
        panel.appendChild(top);
        const shortcuts = [
            ['Ctrl + K', 'Command palette'], ['M', 'Spotify music'], ['L', 'Current lobby'], ['C', 'Lobby chat'],
            ['P', 'Paste Smash Karts code'], ['R', 'Ready / unready'], ['F', 'Fullscreen'], ['N', 'Notes'],
            ['1', '1v1 page'], ['2', '2v2 page'], ['3', 'FFA page'], ['Esc', 'Close Arena Plus panels']
        ];
        shortcuts.forEach(([key, action]) => panel.appendChild(el('div', { class: 'mega-section', html: `<strong style="color:var(--mega-accent)">${key}</strong> · ${action}` })));
        document.body.appendChild(panel);
    }

    // ------------------------------------------------------------------------
    // COMMAND PALETTE
    // ------------------------------------------------------------------------
    function commands() {
        return [
            ['Open 1v1', () => switchMatchMode('1v1')],
            ['Open 2v2', () => switchMatchMode('2v2')],
            ['Open FFA', showFFATab],
            ['Open public lobbies', () => openFindGameModal()],
            ['Open lobby', openCurrentLobby],
            ['Paste room code', promptPasteCode],
            ['Toggle ready', toggleReady],
            ['Spotify music', openMusicDrawer],
            ['Profile', openProfilePanel],
            ['Match notes', openNotesPanel],
            ['History', () => isAccountMode() ? openHistoryPanel() : openLoginModal()],
            ['Settings', () => openSettingsModal()],
            ['Online players', () => openOnlineModal()],
            ['Copy invite', copyCurrentInvite],
            ['Rejoin last lobby', rejoinLastRoom],
            ['Fullscreen', toggleFullscreen],
            ['Arena Plus', openMegaDrawer],
            ['Keyboard shortcuts', openShortcutsPanel]
        ];
    }

    function openCommandPalette() {
        closeNode('megaCommandPalette');
        const panel = el('div', { id: 'megaCommandPalette' });
        const input = el('input', { class: 'mega-input', placeholder: 'Type a command…' });
        const results = el('div', { id: 'megaCommandResults' });
        panel.append(input, results);
        function render() {
            const q = input.value.trim().toLowerCase();
            results.replaceChildren();
            commands().filter(([label]) => !q || label.toLowerCase().includes(q)).forEach(([label, fn], i) => {
                const b = el('button', { class: 'mega-command' + (i === 0 ? ' active' : ''), text: label });
                b.onclick = () => { panel.remove(); fn(); };
                results.appendChild(b);
            });
        }
        input.oninput = render;
        input.onkeydown = e => {
            if (e.key === 'Escape') panel.remove();
            if (e.key === 'Enter') results.querySelector('button')?.click();
        };
        render();
        document.body.appendChild(panel);
        setTimeout(() => input.focus(), 0);
    }

    // ------------------------------------------------------------------------
    // FFA REAL TAB
    // ------------------------------------------------------------------------
    function installFFATab() {
        if (document.getElementById('btnNavFFA')) return;
        const one = document.getElementById('btnNav1v1');
        const setup = document.getElementById('setupTab');
        if (!one || !setup || !setup.parentElement) return;

        const nav = el('button', {
            id: 'btnNavFFA',
            class: 'sidebar-btn w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg',
            title: 'FFA Matchmaking',
            text: '🔥'
        });
        one.parentElement.insertBefore(nav, one);

        const tab = el('div', { id: 'ffaTab', class: 'tab-content hidden space-y-6' });
        tab.innerHTML = `
            <div class="flex justify-between items-center border-b border-white/10 pb-4 gap-4">
                <div><h2 class="font-bungee text-2xl text-white">🔥 FFA MATCHMAKING</h2><p class="text-xs text-blue-200">Guest-friendly free-for-all lobbies</p></div>
                <button id="ffaBrowseBtn" class="mega-button good">🔍 PUBLIC LOBBIES</button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button id="ffaPlayBtn" class="btn-smash py-5 rounded-2xl font-bungee text-xl text-white">🔥 PLAY FFA</button>
                <button id="ffaCreateBtn" class="bg-emerald-500 hover:bg-emerald-400 py-5 rounded-2xl font-bungee text-xl text-white">➕ CREATE LOBBY</button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label class="block text-xs font-bold text-blue-200 mb-2">MAX PLAYERS</label><select id="ffaMaxPlayers" class="smash-input w-full px-4 py-3 rounded-2xl text-sm font-bold"><option>6</option><option selected>12</option><option>16</option><option>20</option></select></div>
                <div><label class="block text-xs font-bold text-blue-200 mb-2">VISIBILITY</label><select id="ffaVisibility" class="smash-input w-full px-4 py-3 rounded-2xl text-sm font-bold"><option value="public">Public</option><option value="private">Private</option></select></div>
            </div>
            <div class="mega-section">Guest players can play immediately. Login is only needed for persistent stats, history, friends, DMs, XP and achievements.</div>
        `;
        setup.parentElement.insertBefore(tab, setup);

        nav.onclick = showFFATab;
        tab.querySelector('#ffaBrowseBtn').onclick = () => openFindGameModal();
        tab.querySelector('#ffaPlayBtn').onclick = () => socket.emit('play_ffa');
        tab.querySelector('#ffaCreateBtn').onclick = () => socket.emit('create_ffa_lobby', {
            maxPlayers: Number(tab.querySelector('#ffaMaxPlayers').value),
            isPublic: tab.querySelector('#ffaVisibility').value === 'public'
        });
    }

    function showFFATab() {
        document.querySelectorAll('.tab-content').forEach(node => node.classList.add('hidden'));
        document.querySelectorAll('.sidebar-btn').forEach(node => node.classList.remove('active'));
        document.getElementById('ffaTab')?.classList.remove('hidden');
        document.getElementById('btnNavFFA')?.classList.add('active');
    }

    socket.on('ffa_no_lobby', data => showToast(data?.message || 'No FFA lobby is open yet.', 'ℹ️'));

    // ------------------------------------------------------------------------
    // GAME TOOLBAR: players + paste + lobby + music + ready + plus
    // ------------------------------------------------------------------------
    function extractRoomCode(url) {
        const match = String(url || '').match(/[?&]room=([A-Za-z0-9]+)/i);
        return match ? match[1] : '';
    }

    function clientValidRoomCode(raw) {
        if (!raw) return null;
        const text = String(raw).trim().replace(/["']+/g, '');
        const valid = code => /^[A-Za-z0-9]{6,12}$/.test(code || '') && /[A-Za-z]/.test(code) && /\d/.test(code);
        if (valid(text)) return text;
        const labeled = text.match(/^Room:\s*([A-Za-z0-9]+)$/i);
        if (labeled && valid(labeled[1])) return labeled[1];
        try {
            const url = new URL(text);
            const host = url.hostname.toLowerCase();
            const code = url.searchParams.get('room');
            return (host === 'smashkarts.io' || host === 'www.smashkarts.io') && valid(code) ? code : null;
        } catch { return null; }
    }

    function promptPasteCode() {
        if (!activeRoomData) return showToast('You are not currently in a lobby.', '⚠️');
        const raw = prompt('Paste a Smash Karts room code or official room link:');
        if (raw == null) return;
        const code = clientValidRoomCode(raw);
        if (!code) return showToast('That is not a valid-looking Smash Karts room code. Nothing changed.', '❌');
        roomCodeHistory = [code, ...roomCodeHistory.filter(x => x !== code)].slice(0, 15);
        saveJSON(ROOM_HISTORY_KEY, roomCodeHistory);
        socket.emit('update_lobby_game_code', { roomId: activeRoomData.roomId, code });
    }

    function openCurrentLobby() {
        if (!activeRoomData) return showToast('You are not currently in a lobby.', '⚠️');
        openPreGameLobby(activeRoomData);
        enrichLobbyUI(activeRoomData);
    }

    function toggleReady() {
        if (!activeRoomData) return showToast('Join a lobby first.', '⚠️');
        readyState = !readyState;
        socket.emit('set_ready_status', { roomId: activeRoomData.roomId, ready: readyState });
    }

    function copyCurrentInvite() {
        if (!activeRoomData) return showToast('Join a lobby first.', '⚠️');
        const code = extractRoomCode(activeRoomData.smashUrl);
        const text = code
            ? `Join my ${String(activeRoomData.mode).toUpperCase()} lobby. Smash Karts code: ${code}`
            : `Join my ${String(activeRoomData.mode).toUpperCase()} website lobby.`;
        navigator.clipboard?.writeText(text).then(() => showToast('Lobby invite copied.', '📋')).catch(() => showToast(text, '📋'));
    }

    function rejoinLastRoom() {
        if (!lastRoomId) return showToast('No recent lobby to rejoin.', '↩️');
        socket.emit('rejoin_room', { roomId: lastRoomId });
    }

    async function toggleFullscreen() {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await document.documentElement.requestFullscreen();
        } catch { showToast('Fullscreen is unavailable.', 'ℹ️'); }
    }

    function ensureGameToolbar() {
        const brand = document.querySelector('.arena-brand') || document.querySelector('.game-brand');
        const actions = document.querySelector('.arena-actions') || document.querySelector('.game-actions');
        const chatButton = document.getElementById('arenaChatButton') || document.getElementById('gameChatToggle');
        if (!brand || !actions || !chatButton) return false;

        let info = document.getElementById('gameLobbyMegaInfo');
        if (!info) {
            info = el('div', { id: 'gameLobbyMegaInfo' });
            info.append(
                el('span', { id: 'gameLobbyMegaCount', text: '👥 0 IN LOBBY' }),
                el('span', { id: 'gameLobbyMegaNames', text: 'No players' }),
                el('span', { id: 'megaReadyBadge', text: '0 READY' })
            );
            brand.appendChild(info);
        }

        function toolbarButton(id, text, fn) {
            let b = document.getElementById(id);
            if (!b) {
                b = el('button', { id, class: chatButton.className || 'arena-button', text });
                b.onclick = fn;
            }
            return b;
        }

        const paste = toolbarButton('megaPasteCodeBtn', '📋 PASTE CODE', promptPasteCode);
        const lobby = toolbarButton('megaLobbyBtn', '👥 LOBBY', openCurrentLobby);
        const ready = toolbarButton('megaReadyBtn', '✅ READY', toggleReady);
        const music = toolbarButton('megaMusicBtn', '🎵 MUSIC', openMusicDrawer);
        const plus = toolbarButton('megaPlusBtn', '⚡ PLUS', openMegaDrawer);

        [paste, lobby, ready, music, plus].forEach(button => actions.insertBefore(button, chatButton));

        const menuToggle = document.getElementById('arenaMenuToggle') || document.getElementById('gameToolbarToggle');
        if (menuToggle) menuToggle.style.right = '32px';
        return true;
    }

    function refreshGameLobby(room) {
        if (!room) return;
        ensureGameToolbar();
        const players = Array.isArray(room.players) ? room.players : [];
        document.getElementById('gameLobbyMegaCount')?.replaceChildren(document.createTextNode(`👥 ${players.length} IN LOBBY`));
        const names = document.getElementById('gameLobbyMegaNames');
        if (names) {
            names.textContent = prefs.showPlayerNames ? (players.map(p => p.name).join(', ') || 'No players') : '';
            names.title = players.map(p => p.name).join(', ');
        }
        document.getElementById('megaReadyBadge')?.replaceChildren(document.createTextNode(`${players.filter(p => p.ready).length} READY`));

        const myMember = players.find(p => p.id === socket.id);
        readyState = !!myMember?.ready;
        const readyBtn = document.getElementById('megaReadyBtn');
        if (readyBtn) readyBtn.textContent = readyState ? '🟢 READY' : '✅ READY';

        const badge = document.getElementById('gameModeBadge');
        if (badge && room.mode) badge.textContent = String(room.mode).toUpperCase();

        const code = extractRoomCode(room.smashUrl);
        if (code) currentRoomCode = code;
        const display = document.getElementById('gameRoomCodeDisplay');
        if (display) display.textContent = code || (room.mode === 'ffa' ? 'NOT SET' : '------');
    }

    // ------------------------------------------------------------------------
    // RICH LOBBY PANEL
    // ------------------------------------------------------------------------
    const originalUpdatePreGameLobbyUI = window.updatePreGameLobbyUI;
    window.updatePreGameLobbyUI = function (room) {
        const list = document.getElementById('preGamePlayerList');
        if (!list || !room) return originalUpdatePreGameLobbyUI?.(room);
        list.replaceChildren();
        const isHost = room.hostSocketId === socket.id;

        (room.players || []).forEach((p, index) => {
            const item = el('div', { class: 'mega-lobby-player' });
            const left = el('div');
            const crown = p.id === room.hostSocketId ? ' 👑' : '';
            left.append(
                el('div', { html: `<strong>👤 ${escapeHTML(p.name)}</strong>${crown} ${p.isGuest ? '<span style="color:#9db5e8">· Guest</span>' : '<span style="color:#72f6b7">· Saved account</span>'}` }),
                el('div', { class: 'mega-player-sub', text: `${p.ready ? 'READY' : 'NOT READY'}${room.mode === '2v2' && p.team ? ` · Team ${p.team.toUpperCase()}` : ''} · Slot ${index + 1}` })
            );
            const right = el('div', { class: 'mega-row' });
            if (p.id === socket.id && room.mode === '2v2') {
                const blue = el('button', { class: 'mega-button', text: '🔵' });
                blue.onclick = () => socket.emit('set_lobby_team', { roomId: room.roomId, team: 'blue' });
                const red = el('button', { class: 'mega-button', text: '🔴' });
                red.onclick = () => socket.emit('set_lobby_team', { roomId: room.roomId, team: 'red' });
                right.append(blue, red);
            }
            if (isHost && p.id !== socket.id) {
                const kick = el('button', { class: 'mega-button danger', text: 'KICK' });
                kick.onclick = () => socket.emit('kick_lobby_player', { roomId: room.roomId, targetSocketId: p.id });
                right.appendChild(kick);
            }
            item.append(left, right);
            list.appendChild(item);
        });

        enrichLobbyUI(room);
    };

    function enrichLobbyUI(room) {
        const list = document.getElementById('preGamePlayerList');
        if (!list || !room) return;
        let tools = document.getElementById('megaLobbyTools');
        if (!tools) {
            tools = el('div', { id: 'megaLobbyTools' });
            list.parentElement?.appendChild(tools);
        }
        tools.replaceChildren();

        const ready = el('button', { class: 'mega-button good', text: readyState ? '🟢 READY' : '✅ READY UP' });
        ready.onclick = toggleReady;
        const copy = el('button', { class: 'mega-button', text: '📋 INVITE' });
        copy.onclick = copyCurrentInvite;
        const react = el('button', { class: 'mega-button', text: '🔥 REACT' });
        react.onclick = () => socket.emit('lobby_reaction', { roomId: room.roomId, reaction: ['🔥','😂','🏁','💀','GG'][Math.floor(Math.random()*5)] });
        const paste = el('button', { class: 'mega-button', text: '🔗 PASTE CODE' });
        paste.onclick = promptPasteCode;
        tools.append(ready, copy, react, paste);

        if (room.hostSocketId === socket.id) {
            const privacy = el('button', { class: 'mega-button', text: room.isPublic === false ? '🔒 PRIVATE' : '🌐 PUBLIC' });
            privacy.onclick = () => socket.emit('toggle_room_privacy', { roomId: room.roomId, isPublic: room.isPublic === false });
            const announce = el('button', { class: 'mega-button', text: '📣 ANNOUNCE' });
            announce.onclick = () => {
                const msg = prompt('Host announcement:');
                if (msg?.trim()) socket.emit('lobby_announcement', { roomId: room.roomId, message: msg.trim() });
            };
            tools.append(privacy, announce);
        }
    }

    // ------------------------------------------------------------------------
    // ROOM CHAT ENHANCEMENTS: quick chat + system messages + reactions
    // ------------------------------------------------------------------------
    function addQuickChat() {
        if (document.getElementById('megaQuickBar')) return;
        const input = document.getElementById('preGameChatInput');
        if (!input || !input.parentElement) return;
        const bar = el('div', { id: 'megaQuickBar' });
        ['GG','GLHF','REMATCH?','NICE!','😂','🔥'].forEach(text => {
            const b = el('button', { class: 'mega-button', text });
            b.onclick = () => {
                if (!activeRoomData) return;
                socket.emit('send_match_chat', { roomId: activeRoomData.roomId, message: text });
            };
            bar.appendChild(b);
        });
        input.parentElement.parentElement?.appendChild(bar);
    }

    socket.on('lobby_system_message', data => {
        if (!activeRoomData || data.roomId !== activeRoomData.roomId) return;
        const boxes = [document.getElementById('preGameChatMessages'), document.getElementById('matchChatMessages')];
        boxes.forEach(box => {
            if (!box) return;
            const row = el('div', { text: `⚡ ${data.message}` });
            row.style.cssText = 'font-size:10px;color:#9db5e8;padding:4px 6px';
            box.appendChild(row);
            box.scrollTop = box.scrollHeight;
        });
    });

    socket.on('lobby_reaction', data => {
        if (!activeRoomData || data.roomId !== activeRoomData.roomId) return;
        let tray = document.getElementById('megaReactionTray');
        if (!tray) {
            tray = el('div', { id: 'megaReactionTray' });
            document.body.appendChild(tray);
        }
        const bubble = el('div', { class: 'mega-reaction', text: `${data.reaction} ${data.from}` });
        tray.appendChild(bubble);
        setTimeout(() => bubble.remove(), 1800);
    });

    socket.on('kicked_from_lobby', data => {
        if (activeRoomData?.roomId === data.roomId) {
            showToast(`You were removed from the lobby by ${data.by}.`, '🚫');
            activeRoomData = null;
            closePreGameLobbyModal();
            leaveEmbeddedGame?.();
        }
    });

    // ------------------------------------------------------------------------
    // PUBLIC LOBBY SEARCH/FILTER UI
    // ------------------------------------------------------------------------
    function enhancePublicLobbyModal() {
        const list = document.getElementById('publicRoomsList');
        if (!list || document.getElementById('megaLobbyFilterBar')) return;
        const bar = el('div', { id: 'megaLobbyFilterBar', class: 'mega-section' });
        const search = el('input', { class: 'mega-input', placeholder: 'Search host or mode…' });
        search.value = prefs.lobbySearch;
        const filter = el('select', { class: 'mega-select' });
        [['all','All modes'],['1v1','1v1'],['2v2','2v2'],['ffa','FFA']].forEach(([v,l]) => filter.appendChild(el('option',{value:v,text:l})));
        filter.value = prefs.lobbyFilter;
        search.oninput = () => { prefs.lobbySearch = search.value; savePrefs(); renderEnhancedPublicRooms(); };
        filter.onchange = () => { prefs.lobbyFilter = filter.value; savePrefs(); renderEnhancedPublicRooms(); };
        bar.append(search, filter);
        list.parentElement?.insertBefore(bar, list);
    }

    function renderEnhancedPublicRooms() {
        const list = document.getElementById('publicRoomsList');
        if (!list) return;
        const query = (prefs.lobbySearch || '').toLowerCase();
        const rooms = (publicRoomsCache || []).filter(room => {
            const modeOK = prefs.lobbyFilter === 'all' || room.mode === prefs.lobbyFilter;
            const textOK = !query || `${room.hostName} ${room.mode} ${room.winCondition}`.toLowerCase().includes(query);
            return modeOK && textOK;
        });
        list.replaceChildren();
        if (!rooms.length) return list.appendChild(el('p', { class:'text-center text-xs text-blue-200', text:'No matching lobbies.' }));
        rooms.forEach(room => {
            const row = el('div', { class:'bg-blue-950/80 p-3 rounded-2xl border border-white/10' });
            row.innerHTML = `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><div><div style="font-weight:900;font-size:12px">${escapeHTML(room.hostName)} · ${String(room.mode).toUpperCase()}</div><div style="font-size:10px;color:#9db5e8">${room.players.length}/${room.maxPlayers} players · ${room.readyCount || 0} ready · ${escapeHTML(room.winCondition || '')}</div></div><button class="mega-button good">JOIN</button></div>`;
            row.querySelector('button').onclick = () => socket.emit('join_public_room', { roomId: room.roomId });
            list.appendChild(row);
        });
    }

    socket.on('public_rooms_update', rooms => {
        publicRoomsCache = rooms;
        enhancePublicLobbyModal();
        renderEnhancedPublicRooms();
    });

    // ------------------------------------------------------------------------
    // SESSION / CONNECTION UI
    // ------------------------------------------------------------------------
    const miniNotice = el('div', { id: 'megaMiniNotice' });
    document.body.appendChild(miniNotice);

    const connection = el('div', { id: 'megaConnectionBanner', text: '🟢 Connected' });
    document.body.appendChild(connection);

    const offline = el('div', { id: 'megaOfflineToast', html: '<div><div style="font-size:44px">📡</div><h2 style="font-size:24px;font-weight:900">Connection lost</h2><p>Your lobby is trying to reconnect. Do not refresh unless it stays offline.</p></div>' });
    document.body.appendChild(offline);

    socket.on('connect', () => {
        connectionStartedAt = Date.now();
        connection.textContent = '🟢 Connected';
        connection.classList.remove('offline');
        offline.classList.remove('show');
        sendCurrentSession();
    });
    socket.on('disconnect', () => {
        connection.textContent = '🔴 Reconnecting…';
        connection.classList.add('offline');
        offline.classList.add('show');
    });
    window.addEventListener('offline', () => offline.classList.add('show'));
    window.addEventListener('online', () => offline.classList.remove('show'));

    // ------------------------------------------------------------------------
    // IN-GAME / LOBBY EVENTS
    // ------------------------------------------------------------------------
    function acceptRoom(room) {
        if (!room) return;
        activeRoomData = room;
        lastRoomId = room.roomId;
        localStorage.setItem('smash_last_room_id_v3', room.roomId);
        refreshGameLobby(room);
        if (typeof updatePreGameLobbyUI === 'function') updatePreGameLobbyUI(room);
        addQuickChat();
        matchStartedAt = Date.now();
    }

    socket.on('room_created', acceptRoom);
    socket.on('ffa_lobby_ready', room => {
        acceptRoom(room);
        openPreGameLobby(room);
    });
    socket.on('challenge_game_start', acceptRoom);
    socket.on('saved_room_update', room => {
        if (!activeRoomData || activeRoomData.roomId !== room.roomId) return;
        activeRoomData = room;
        refreshGameLobby(room);
        if (!document.getElementById('preGameLobbyModal')?.classList.contains('hidden')) updatePreGameLobbyUI(room);
    });
    socket.on('lobby_game_code_updated', data => {
        if (!activeRoomData || activeRoomData.roomId !== data.roomId) return;
        activeRoomData.smashUrl = data.smashUrl;
        refreshGameLobby(activeRoomData);
        showToast(`Lobby code updated by ${data.updatedBy}.`, '📋');
    });
    socket.on('ready_state_changed', data => {
        if (!activeRoomData || activeRoomData.roomId !== data.roomId) return;
        document.getElementById('megaReadyBadge')?.replaceChildren(document.createTextNode(`${data.readyCount} READY`));
        if (data.allReady) showToast('Everybody is ready!', '🏁');
    });
    socket.on('lobby_deleted', ({ roomId }) => {
        if (activeRoomData?.roomId === roomId) activeRoomData = null;
    });
    socket.on('account_required', data => {
        showToast(data?.message || 'Log in to use that saved feature.', '💾');
    });

    // ------------------------------------------------------------------------
    // WRAP GAME START WITHOUT BREAKING EXISTING GAME FLOW
    // ------------------------------------------------------------------------
    const originalEnterGame = window.enterGameFromLobby;
    window.enterGameFromLobby = function (...args) {
        const user = currentArenaUser();
        if (!activeRoomData) return originalEnterGame?.apply(this, args);

        // Existing script records a match unconditionally. Suppress only for guests
        // by temporarily replacing socket.emit for that one event.
        const realEmit = socket.emit.bind(socket);
        if (!isAccountMode()) {
            socket.emit = function (event, ...rest) {
                if (event === 'record_match_played') return socket;
                return realEmit(event, ...rest);
            };
        }

        let result;
        try {
            result = originalEnterGame?.apply(this, args);
        } finally {
            socket.emit = realEmit;
        }

        progress.sessionMatches = (progress.sessionMatches || 0) + 1;
        if (isAccountMode()) {
            updateDailyStreak();
            addXP(75, 'Played a match');
            progress.accountMatches = (progress.accountMatches || 0) + 1;
            saveProgress();
            if (progress.accountMatches === 1) unlockAchievement('first_match', 'First saved match');
            if (progress.accountMatches >= 10) unlockAchievement('ten_matches', '10 saved matches');
        }
        matchStartedAt = Date.now();
        ensureGameToolbar();
        refreshGameLobby(activeRoomData);
        return result;
    };

    // ------------------------------------------------------------------------
    // TOOLBAR / PAGE TIMER
    // ------------------------------------------------------------------------
    function ensureSessionWidget() {
        const headerLeft = document.querySelector('#mainDashboard header > div');
        if (!headerLeft || document.getElementById('megaSessionWidget')) return;
        const widget = el('div', { id: 'megaSessionWidget', class: 'mega-chip' });
        widget.innerHTML = '⏱️ <span id="megaSessionTime">00:00</span> · <span id="megaModeLabel">Guest</span>';
        headerLeft.appendChild(widget);
    }

    function formatDuration(ms) {
        const sec = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }

    setInterval(() => {
        document.getElementById('megaSessionTime')?.replaceChildren(document.createTextNode(formatDuration(Date.now() - pageStartedAt)));
        document.getElementById('megaModeLabel')?.replaceChildren(document.createTextNode(isAccountMode() ? `Lv.${levelFromXP(progress.xp)} Saved` : 'Guest'));
        const game = document.getElementById('gameScreen');
        if (game && !game.classList.contains('hidden')) ensureGameToolbar();
    }, 1000);

    // ------------------------------------------------------------------------
    // ADD PLUS + MUSIC TO DASHBOARD SIDEBAR
    // ------------------------------------------------------------------------
    function installSidebarExtras() {
        const aside = document.querySelector('#mainDashboard aside');
        if (!aside || document.getElementById('btnNavMegaPlus')) return;
        const music = el('button', { id:'btnNavMusic', class:'sidebar-btn w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg', title:'Spotify Music', text:'🎵' });
        music.onclick = openMusicDrawer;
        const plus = el('button', { id:'btnNavMegaPlus', class:'sidebar-btn w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg', title:'Arena Plus', text:'⚡' });
        plus.onclick = openMegaDrawer;
        aside.append(music, plus);
    }

    // ------------------------------------------------------------------------
    // KEYBOARD SHORTCUTS
    // ------------------------------------------------------------------------
    document.addEventListener('keydown', e => {
        const target = e.target;
        const typing = target && ['INPUT','TEXTAREA','SELECT'].includes(target.tagName);
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            return openCommandPalette();
        }
        if (typing) return;
        const key = e.key.toLowerCase();
        if (key === 'm') openMusicDrawer();
        if (key === 'l') openCurrentLobby();
        if (key === 'c') toggleOverlayChat?.();
        if (key === 'p') promptPasteCode();
        if (key === 'r') toggleReady();
        if (key === 'f') toggleFullscreen();
        if (key === 'n') openNotesPanel();
        if (key === '1') switchMatchMode('1v1');
        if (key === '2') switchMatchMode('2v2');
        if (key === '3') showFFATab();
        if (key === 'escape') ['megaDrawer','megaCommandPalette','megaProfilePanel','megaNotesPanel','megaShortcutsPanel','megaMusicPanel','megaHistoryPanel'].forEach(closeNode);
    });

    // ------------------------------------------------------------------------
    // INIT
    // ------------------------------------------------------------------------
    applyPrefs();
    installFFATab();
    installSidebarExtras();
    ensureGameToolbar();
    ensureSessionWidget();
    refreshAccountChrome();
    enhancePublicLobbyModal();
    addQuickChat();

    // Original DOMContentLoaded handler will now see AuthSession.isLoggedIn() === true,
    // which prevents the forced login wall and lets guest mode open the site normally.
    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('authModal')?.classList.add('hidden');
        installFFATab();
        installSidebarExtras();
        ensureGameToolbar();
        ensureSessionWidget();
        refreshAccountChrome();
        sendCurrentSession();
    });

    // If DOM is already ready, send guest/account session immediately.
    if (document.readyState !== 'loading') {
        document.getElementById('authModal')?.classList.add('hidden');
        sendCurrentSession();
    }
}
