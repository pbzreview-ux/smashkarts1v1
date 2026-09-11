const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '/')));

const connectedPlayers = {}; // socketId -> { id, username }
const activeRooms = [];
// In-memory stats tracking: username -> matchesPlayed
const playerStats = {}; 

function sanitizeUsername(name) {
    if (!name || name === 'undefined' || name.trim() === '') return 'Player';
    return name.trim();
}

function extractSmashUrl(rawInput) {
    if (!rawInput) return "https://smashkarts.io";
    const match = rawInput.match(/https?:\/\/[^\s]+/);
    return match ? match[0] : rawInput.trim();
}

function moderateText(text) {
    const BANNED_WORDS = ['badword1', 'badword2', 'hate', 'spam'];
    let cleanText = text;
    BANNED_WORDS.forEach(word => {
        const regex = new RegExp(word, 'gi');
        cleanText = cleanText.replace(regex, '***');
    });
    return cleanText;
}

io.on('connection', (socket) => {
    connectedPlayers[socket.id] = { id: socket.id, username: "Player" };
    broadcastOnlineUsers();

    // Register user session with custom Username
    socket.on('set_user_session', (userData) => {
        const uname = sanitizeUsername(userData?.username);
        connectedPlayers[socket.id].username = uname;
        
        if (!playerStats[uname]) {
            playerStats[uname] = 0;
        }
        broadcastOnlineUsers();
        broadcastLeaderboard();
    });

    // Record completed match to update leaderboard
    socket.on('record_match_played', (rawUsername) => {
        const uname = sanitizeUsername(rawUsername);
        if (uname && uname !== 'Player') {
            playerStats[uname] = (playerStats[uname] || 0) + 1;
            broadcastLeaderboard();
        }
    });

    // Match Requests (Challenge another online player)
    socket.on('send_match_challenge', ({ targetSocketId, fromUsername, mode, smashUrl }) => {
        const senderName = sanitizeUsername(fromUsername);
        io.to(targetSocketId).emit('receive_match_challenge', {
            challengerSocketId: socket.id,
            fromUsername: senderName,
            mode: mode || '1v1',
            smashUrl: smashUrl || 'https://smashkarts.io'
        });
    });

    socket.on('accept_match_challenge', ({ challengerSocketId, targetUsername }) => {
        const acceptName = sanitizeUsername(targetUsername);
        const challengerName = sanitizeUsername(connectedPlayers[challengerSocketId]?.username);
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        const room = {
            roomId,
            hostName: acceptName,
            smashUrl: 'https://smashkarts.io',
            winCondition: 'First to 3',
            mode: '1v1',
            maxPlayers: 2,
            players: [
                { id: socket.id, name: acceptName },
                { id: challengerSocketId, name: challengerName }
            ],
            messages: []
        };
        activeRooms.push(room);

        socket.join(roomId);
        const challengerSocket = io.sockets.sockets.get(challengerSocketId);
        if (challengerSocket) challengerSocket.join(roomId);

        io.to(roomId).emit('challenge_game_start', room);
    });

    // Direct Messaging between Online Users
    socket.on('send_direct_message', ({ targetSocketId, message, senderUsername }) => {
        if (message && message.trim()) {
            const cleanMsg = moderateText(message.trim());
            const senderName = sanitizeUsername(senderUsername);
            io.to(targetSocketId).emit('receive_direct_message', {
                senderSocketId: socket.id,
                senderUsername: senderName,
                message: cleanMsg
            });
        }
    });

    // Public Room Operations
    socket.on('create_room', (data) => {
        const cleanUrl = extractSmashUrl(data.smashUrl);
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const mode = data.mode || '1v1';
        const hostName = sanitizeUsername(data.playerName);
        
        const newRoom = {
            roomId,
            hostName,
            smashUrl: cleanUrl,
            winCondition: data.winCondition,
            mode,
            maxPlayers: mode === '2v2' ? 4 : 2,
            players: [{ id: socket.id, name: hostName }],
            messages: []
        };

        activeRooms.push(newRoom);
        if (activeRooms.length > 30) activeRooms.shift();

        socket.join(roomId);
        socket.emit('room_created', newRoom);
        io.emit('public_rooms_update', activeRooms);
    });

    socket.on('get_public_rooms', () => {
        socket.emit('public_rooms_update', activeRooms);
    });

    socket.on('send_match_chat', ({ roomId, message, senderName }) => {
        const room = activeRooms.find(r => r.roomId === roomId);
        if (message && message.trim()) {
            const cleanMsg = moderateText(message.trim());
            const cleanSender = sanitizeUsername(senderName);
            const msgObj = { senderName: cleanSender, message: cleanMsg };
            if (room) room.messages.push(msgObj);
            io.to(roomId).emit('receive_match_chat', msgObj);
        }
    });

    socket.on('disconnect', () => {
        delete connectedPlayers[socket.id];
        broadcastOnlineUsers();
    });
});

function broadcastOnlineUsers() {
    const playerList = Object.values(connectedPlayers).map(p => ({
        id: p.id,
        username: sanitizeUsername(p.username)
    }));
    io.emit('online_users_update', { count: playerList.length, users: playerList });
}

function broadcastLeaderboard() {
    const topPlayers = Object.entries(playerStats)
        .map(([username, matches]) => ({ username: sanitizeUsername(username), matches }))
        .filter(p => p.username !== 'Player')
        .sort((a, b) => b.matches - a.matches)
        .slice(0, 5);

    io.emit('leaderboard_update', topPlayers);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));