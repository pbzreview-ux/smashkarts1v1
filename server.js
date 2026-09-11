const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '/')));

// Active sockets map: socket.id -> { username, id }
const connectedPlayers = {};
// Active created rooms array
const activeRooms = [];

// Helper function to extract valid URL from copied text
function extractSmashUrl(rawInput) {
    if (!rawInput) return "https://smashkarts.io";
    const match = rawInput.match(/https?:\/\/[^\s]+/);
    return match ? match[0] : rawInput.trim();
}

// Basic Chat Moderation Filter
const BANNED_WORDS = ['badword1', 'badword2', 'hate', 'spam'];

function moderateText(text) {
    let cleanText = text;
    BANNED_WORDS.forEach(word => {
        const regex = new RegExp(word, 'gi');
        cleanText = cleanText.replace(regex, '***');
    });
    return cleanText;
}

io.on('connection', (socket) => {
    connectedPlayers[socket.id] = {
        id: socket.id,
        username: "Untitled"
    };

    broadcastOnlineUsers();

    socket.on('set_username', (name) => {
        const cleanName = name ? name.trim() : "";
        connectedPlayers[socket.id].username = cleanName.length > 0 ? cleanName : "Untitled";
        broadcastOnlineUsers();
    });

    // Create Room (1v1 or 2v2)
    socket.on('create_room', (data) => {
        const cleanUrl = extractSmashUrl(data.smashUrl);
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const mode = data.mode || '1v1';
        const maxPlayers = mode === '2v2' ? 4 : 2;
        
        const newRoom = {
            roomId: roomId,
            hostName: data.playerName,
            smashUrl: cleanUrl,
            winCondition: data.winCondition,
            mode: mode,
            maxPlayers: maxPlayers,
            players: [{ id: socket.id, name: data.playerName }],
            createdAt: Date.now()
        };

        activeRooms.push(newRoom);
        if (activeRooms.length > 30) activeRooms.shift();

        socket.join(roomId);
        socket.emit('room_created', newRoom);
        io.emit('public_rooms_update', activeRooms);
    });

    // Fetch Active Public Rooms
    socket.on('get_public_rooms', () => {
        socket.emit('public_rooms_update', activeRooms);
    });

    // Join Match Room Session
    socket.on('join_match_session', ({ roomId, playerName }) => {
        const room = activeRooms.find(r => r.roomId === roomId);
        if (room) {
            if (!room.players.some(p => p.id === socket.id) && room.players.length < room.maxPlayers) {
                room.players.push({ id: socket.id, name: playerName });
            }
            socket.join(roomId);
            io.to(roomId).emit('match_player_joined', {
                players: room.players,
                joinedPlayer: playerName
            });
            io.emit('public_rooms_update', activeRooms);
        }
    });

    // Match Room In-Game Chat
    socket.on('send_match_chat', ({ roomId, message, senderName }) => {
        if (message && message.trim().length > 0) {
            const cleanMsg = moderateText(message.trim());
            io.to(roomId).emit('receive_match_chat', {
                senderName: senderName || "Player",
                message: cleanMsg
            });
        }
    });

    // Friend System Events
    socket.on('send_friend_request', ({ targetSocketId, senderName }) => {
        if (connectedPlayers[targetSocketId]) {
            io.to(targetSocketId).emit('receive_friend_request', {
                senderId: socket.id,
                senderName: senderName || connectedPlayers[socket.id].username
            });
        }
    });

    socket.on('respond_friend_request', ({ targetSocketId, accepted, responderName }) => {
        if (connectedPlayers[targetSocketId]) {
            io.to(targetSocketId).emit('friend_request_response', {
                responderId: socket.id,
                responderName: responderName,
                accepted: accepted
            });
        }
    });

    // Handle Direct 1v1 / 2v2 Challenges
    socket.on('send_match_challenge', ({ targetSocketId, smashUrl, winCondition, mode }) => {
        const sender = connectedPlayers[socket.id];
        const cleanUrl = extractSmashUrl(smashUrl);

        if (connectedPlayers[targetSocketId]) {
            io.to(targetSocketId).emit('receive_match_challenge', {
                senderId: socket.id,
                senderName: sender ? sender.username : "Untitled",
                smashUrl: cleanUrl,
                mode: mode || "1v1",
                winCondition: winCondition || "First to 3"
            });
        }
    });

    socket.on('respond_match_challenge', ({ targetSocketId, accepted, smashUrl, mode }) => {
        const responder = connectedPlayers[socket.id];
        if (connectedPlayers[targetSocketId]) {
            io.to(targetSocketId).emit('match_challenge_response', {
                responderName: responder ? responder.username : "Untitled",
                accepted: accepted,
                smashUrl: smashUrl,
                mode: mode
            });
        }
    });

    // Direct Messaging
    socket.on('send_private_msg', ({ targetSocketId, message }) => {
        const sender = connectedPlayers[socket.id];
        if (connectedPlayers[targetSocketId] && message.trim().length > 0) {
            const cleanMessage = moderateText(message.trim());
            
            io.to(targetSocketId).emit('receive_private_msg', {
                senderId: socket.id,
                senderName: sender ? sender.username : "Untitled",
                message: cleanMessage
            });

            socket.emit('private_msg_sent_confirm', {
                targetSocketId,
                message: cleanMessage
            });
        }
    });

    socket.on('disconnect', () => {
        delete connectedPlayers[socket.id];
        broadcastOnlineUsers();
    });
});

function broadcastOnlineUsers() {
    const playerList = Object.values(connectedPlayers);
    io.emit('online_users_update', {
        count: playerList.length,
        users: playerList
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));