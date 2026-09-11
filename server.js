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
// Active created rooms map: roomId -> lobbyData
const activeRooms = {};

// Basic Chat Moderation / Banned Words List
const BANNED_WORDS = ['badword1', 'badword2', 'hate', 'spam', 'idiot', 'nooblet'];

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

    // Handle 1v1 room creation
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        activeRooms[roomId] = {
            roomId: roomId,
            hostName: data.playerName,
            smashUrl: data.smashUrl,
            winCondition: data.winCondition,
            gameMode: data.gameMode,
            hostSocketId: socket.id
        };
        socket.emit('room_created', { roomId, lobby: data });
    });

    // Handle Joining an Existing Match via Code
    socket.on('join_room_request', (roomId) => {
        const room = activeRooms[roomId.trim().toUpperCase()];
        if (room) {
            socket.emit('join_room_success', room);
        } else {
            socket.emit('join_room_error', 'Invalid or expired Match Code!');
        }
    });

    // Handle 1v1 Challenge Requests
    socket.on('send_1v1_request', ({ targetSocketId, smashUrl, winCondition }) => {
        const sender = connectedPlayers[socket.id];
        if (connectedPlayers[targetSocketId]) {
            io.to(targetSocketId).emit('receive_1v1_request', {
                senderId: socket.id,
                senderName: sender ? sender.username : "Untitled",
                smashUrl: smashUrl || "https://smashkarts.io",
                winCondition: winCondition || "First to 3"
            });
        }
    });

    // Handle 1v1 Challenge Responses
    socket.on('respond_1v1_request', ({ targetSocketId, accepted }) => {
        const responder = connectedPlayers[socket.id];
        if (connectedPlayers[targetSocketId]) {
            io.to(targetSocketId).emit('1v1_response_received', {
                responderName: responder ? responder.username : "Untitled",
                accepted: accepted
            });
        }
    });

    // Handle Moderated Direct Messaging (Max 3 storage handling on client side)
    socket.on('send_private_msg', ({ targetSocketId, message }) => {
        const sender = connectedPlayers[socket.id];
        if (connectedPlayers[targetSocketId] && message.trim().length > 0) {
            const cleanMessage = moderateText(message.trim());
            
            io.to(targetSocketId).emit('receive_private_msg', {
                senderId: socket.id,
                senderName: sender ? sender.username : "Untitled",
                message: cleanMessage
            });

            // Echo back clean message to sender
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