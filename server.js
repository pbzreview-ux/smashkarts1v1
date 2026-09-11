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
// In-memory global stats tracking: username -> matchesPlayed
const playerStats = {}; 

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
    connectedPlayers[socket.id] = { id: socket.id, username: "Guest" };
    broadcastOnlineUsers();

    // Register user session with custom Username
    socket.on('set_user_session', (userData) => {
        const uname = userData.username || (userData.email ? userData.email.split('@')[0] : "Player");
        connectedPlayers[socket.id].username = uname;
        
        if (!playerStats[uname]) {
            playerStats[uname] = 0;
        }
        broadcastOnlineUsers();
        broadcastLeaderboard();
    });

    // Record completed match to update leaderboard
    socket.on('record_match_played', (username) => {
        if (username) {
            playerStats[username] = (playerStats[username] || 0) + 1;
            broadcastLeaderboard();
        }
    });

    // Match Requests (Challenge another online player)
    socket.on('send_match_challenge', ({ targetSocketId, fromUsername, mode, smashUrl }) => {
        io.to(targetSocketId).emit('receive_match_challenge', {
            challengerSocketId: socket.id,
            fromUsername,
            mode: mode || '1v1',
            smashUrl: smashUrl || 'https://smashkarts.io'
        });
    });

    socket.on('accept_match_challenge', ({ challengerSocketId, targetUsername }) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const room = {
            roomId,
            hostName: targetUsername,
            smashUrl: 'https://smashkarts.io',
            winCondition: 'First to 3',
            mode: '1v1',
            maxPlayers: 2,
            players: [
                { id: socket.id, name: targetUsername },
                { id: challengerSocketId, name: connectedPlayers[challengerSocketId]?.username || 'Challenger' }
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
            io.to(targetSocketId).emit('receive_direct_message', {
                senderSocketId: socket.id,
                senderUsername,
                message: cleanMsg
            });
        }
    });

    // Public Room Operations
    socket.on('create_room', (data) => {
        const cleanUrl = extractSmashUrl(data.smashUrl);
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const mode = data.mode || '1v1';
        
        const newRoom = {
            roomId,
            hostName: data.playerName,
            smashUrl: cleanUrl,
            winCondition: data.winCondition,
            mode,
            maxPlayers: mode === '2v2' ? 4 : 2,
            players: [{ id: socket.id, name: data.playerName }],
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
            const msgObj = { senderName: senderName || "Player", message: cleanMsg };
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
    const playerList = Object.values(connectedPlayers);
    io.emit('online_users_update', { count: playerList.length, users: playerList });
}

function broadcastLeaderboard() {
    // Sort top 5 players by matches played
    const topPlayers = Object.entries(playerStats)
        .map(([username, matches]) => ({ username, matches }))
        .sort((a, b) => b.matches - a.matches)
        .slice(0, 5);

    io.emit('leaderboard_update', topPlayers);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));