const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

let onlineUsers = new Map();
let publicLobbies = [];
let usersDb = new Map();
let dmMessages = [];

io.on('connection', (socket) => {
    socket.on('user_online', (username) => {
        onlineUsers.set(socket.id, username);
        broadcastOnlineUsers();
    });

    socket.on('auth_user', ({ type, username, email, password }) => {
        if (type === 'register') {
            if (usersDb.has(email)) {
                socket.emit('auth_error', 'Email already registered.');
            } else {
                const newUser = { username, email, password, gamesPlayed: 0 };
                usersDb.set(email, newUser);
                socket.emit('auth_success', { username, email, gamesPlayed: 0 });
            }
        } else {
            const user = usersDb.get(email);
            if (user && user.password === password) {
                socket.emit('auth_success', { username: user.username, email: user.email, gamesPlayed: user.gamesPlayed });
            } else {
                socket.emit('auth_error', 'Invalid email or password.');
            }
        }
    });

    socket.on('update_username', ({ email, newUsername }) => {
        const user = usersDb.get(email);
        if (user) {
            user.username = newUsername;
            onlineUsers.set(socket.id, newUsername);
            broadcastOnlineUsers();
            updateLeaderboard();
        }
    });

    socket.on('request_leaderboard', () => {
        updateLeaderboard();
    });

    socket.on('create_lobby', (lobbyData) => {
        publicLobbies.push(lobbyData);
        socket.emit('lobby_created', lobbyData);
    });

    socket.on('request_public_rooms', () => {
        socket.emit('public_rooms_list', publicLobbies);
    });

    socket.on('pregame_chat_message', (data) => {
        io.emit('pregame_chat_broadcast', data);
    });

    socket.on('match_chat_message', (data) => {
        io.emit('match_chat_broadcast', data);
    });

    socket.on('request_online_users', () => {
        broadcastOnlineUsers();
    });

    socket.on('send_dm', (data) => {
        dmMessages.push(data);
        for (let [id, name] of onlineUsers.entries()) {
            if (name === data.recipient) {
                io.to(id).emit('receive_dm', data);
                break;
            }
        }
    });

    socket.on('request_dm_history', ({ recipient }) => {
        const currentName = onlineUsers.get(socket.id);
        const history = dmMessages.filter(m => 
            (m.sender === currentName && m.recipient === recipient) ||
            (m.sender === recipient && m.recipient === currentName)
        );
        socket.emit('dm_history', history);
    });

    socket.on('record_match_played', (username) => {
        for (let [email, user] of usersDb.entries()) {
            if (user.username === username) {
                user.gamesPlayed = (user.gamesPlayed || 0) + 1;
                break;
            }
        }
        updateLeaderboard();
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        broadcastOnlineUsers();
    });
});

function broadcastOnlineUsers() {
    const uniqueUsers = Array.from(new Set(onlineUsers.values()));
    io.emit('online_users_list', uniqueUsers);
}

function updateLeaderboard() {
    const list = Array.from(usersDb.values()).map(u => ({
        username: u.username,
        gamesPlayed: u.gamesPlayed || 0
    })).sort((a, b) => b.gamesPlayed - a.gamesPlayed).slice(0, 5);
    io.emit('leaderboard_data', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});