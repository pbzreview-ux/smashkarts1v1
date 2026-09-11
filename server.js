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

    // Create 1v1 Room
    socket.on('create_room', (data) => {
        const cleanUrl = extractSmashUrl(data.smashUrl);
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        const newRoom = {
            roomId: roomId,
            hostName: data.playerName,
            smashUrl: cleanUrl,
            winCondition: data.winCondition,
            hostSocketId: socket.id,
            createdAt: Date.now()
        };

        activeRooms.push(newRoom);

        // Keep active rooms manageable
        if (activeRooms.length > 20) activeRooms.shift();

        socket.emit('room_created', newRoom);
        io.emit('public_rooms_update', activeRooms);
    });

    // Fetch Active Public Rooms
    socket.on('get_public_rooms', () => {
        socket.emit('public_rooms_update', activeRooms);
    });

    // Handle 1v1 Challenge Requests
    socket.on('send_1v1_request', ({ targetSocketId, smashUrl, winCondition }) => {
        const sender = connectedPlayers[socket.id];
        const cleanUrl = extractSmashUrl(smashUrl);

        if (connectedPlayers[targetSocketId]) {
            io.to(targetSocketId).emit('receive_1v1_request', {
                senderId: socket.id,
                senderName: sender ? sender.username : "Untitled",
                smashUrl: cleanUrl,
                winCondition: winCondition || "First to 3"
            });
        }
    });

    socket.on('respond_1v1_request', ({ targetSocketId, accepted }) => {
        const responder = connectedPlayers[socket.id];
        if (connectedPlayers[targetSocketId]) {
            io.to(targetSocketId).emit('1v1_response_received', {
                responderName: responder ? responder.username : "Untitled",
                accepted: accepted
            });
        }
    });

    // Chat handling
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