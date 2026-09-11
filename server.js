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

io.on('connection', (socket) => {
    // Default dynamic user info upon joining
    connectedPlayers[socket.id] = {
        id: socket.id,
        username: "Untitled"
    };

    // Send full update of online users to everyone
    broadcastOnlineUsers();

    // Handle username updates from client
    socket.on('set_username', (name) => {
        const cleanName = name ? name.trim() : "";
        connectedPlayers[socket.id].username = cleanName.length > 0 ? cleanName : "Untitled";
        broadcastOnlineUsers();
    });

    // Handle 1v1 room creation
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        socket.emit('room_created', { roomId, lobby: data });
    });

    // Handle Direct Messaging between players
    socket.on('send_private_msg', ({ targetSocketId, message }) => {
        const sender = connectedPlayers[socket.id];
        if (connectedPlayers[targetSocketId] && message.trim().length > 0) {
            io.to(targetSocketId).emit('receive_private_msg', {
                senderId: socket.id,
                senderName: sender ? sender.username : "Untitled",
                message: message.trim()
            });
        }
    });

    // Handle disconnection
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