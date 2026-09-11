const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '/')));

const connectedPlayers = {};
const activeRooms = [];

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

    socket.on('set_user_session', (userData) => {
        connectedPlayers[socket.id].username = userData.email ? userData.email.split('@')[0] : "Player";
        connectedPlayers[socket.id].email = userData.email;
        broadcastOnlineUsers();
    });

    socket.on('create_room', (data) => {
        const cleanUrl = extractSmashUrl(data.smashUrl);
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const mode = data.mode || '1v1';
        const maxPlayers = mode === '2v2' ? 4 : 2;
        
        const newRoom = {
            roomId,
            hostName: data.playerName,
            smashUrl: cleanUrl,
            winCondition: data.winCondition,
            mode,
            maxPlayers,
            players: [{ id: socket.id, name: data.playerName }],
            messages: [],
            createdAt: Date.now()
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

    socket.on('join_match_session', ({ roomId, playerName }) => {
        const room = activeRooms.find(r => r.roomId === roomId);
        if (room) {
            if (!room.players.some(p => p.id === socket.id) && room.players.length < room.maxPlayers) {
                room.players.push({ id: socket.id, name: playerName });
            }
            socket.join(roomId);
            io.to(roomId).emit('match_player_joined', { room, joinedPlayer: playerName });
            io.emit('public_rooms_update', activeRooms);
        }
    });

    socket.on('send_match_chat', ({ roomId, message, senderName }) => {
        const room = activeRooms.find(r => r.roomId === roomId);
        if (message && message.trim().length > 0) {
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));