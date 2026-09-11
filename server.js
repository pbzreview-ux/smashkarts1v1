const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '/')));

// Socket Data Storage: socketId -> { id, username, email, isAuthenticated, isOnline, friends: Set, friendRequests: Set }
const connectedPlayers = {}; 
const activeRooms = [];
const playerStats = {}; 
// DM Storage: 'user1_user2' -> [ { sender, message, timestamp } ] (Max 10 messages)
const directMessageStore = {}; 

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

function getDMKey(u1, u2) {
    return [u1, u2].sort().join('__DM__');
}

io.on('connection', (socket) => {
    connectedPlayers[socket.id] = { 
        id: socket.id, 
        username: "Guest", 
        email: null,
        isAuthenticated: false, 
        isOnline: true,
        friends: new Set(),
        friendRequests: new Set()
    };

    // User Session Set (Requires Account)
    socket.on('set_user_session', (userData) => {
        if (!userData || !userData.username) return;
        const uname = sanitizeUsername(userData.username);
        
        const player = connectedPlayers[socket.id];
        if (player) {
            player.username = uname;
            player.email = userData.email || null;
            player.isAuthenticated = true; // Mark as logged-in user
        }
        
        if (!playerStats[uname]) {
            playerStats[uname] = 0;
        }
        
        broadcastOnlineUsers();
        broadcastLeaderboard();
    });

    // Toggle Online Visibility Setting
    socket.on('toggle_online_status', (isOnline) => {
        if (connectedPlayers[socket.id]) {
            connectedPlayers[socket.id].isOnline = !!isOnline;
            broadcastOnlineUsers();
        }
    });

    // Friend Requests
    socket.on('send_friend_request', ({ targetSocketId }) => {
        const sender = connectedPlayers[socket.id];
        const target = connectedPlayers[targetSocketId];

        if (sender && target && sender.isAuthenticated && target.isAuthenticated) {
            target.friendRequests.add(sender.username);
            io.to(targetSocketId).emit('receive_friend_request', {
                fromSocketId: socket.id,
                fromUsername: sender.username
            });
        }
    });

    socket.on('accept_friend_request', ({ challengerSocketId, challengerUsername }) => {
        const user = connectedPlayers[socket.id];
        if (!user) return;

        user.friends.add(challengerUsername);
        user.friendRequests.delete(challengerUsername);

        // Update challenger if online
        const challenger = connectedPlayers[challengerSocketId];
        if (challenger) {
            challenger.friends.add(user.username);
            io.to(challengerSocketId).emit('friend_request_accepted', { username: user.username });
        }

        socket.emit('friend_request_accepted', { username: challengerUsername });
    });

    // Direct Messages (Friends Only, Max 10 History)
    socket.on('send_direct_message', ({ targetSocketId, targetUsername, message }) => {
        const sender = connectedPlayers[socket.id];
        if (!sender || !sender.isAuthenticated || !message || !message.trim()) return;

        const cleanMsg = moderateText(message.trim());
        const dmKey = getDMKey(sender.username, targetUsername);

        if (!directMessageStore[dmKey]) directMessageStore[dmKey] = [];
        
        const msgObj = { senderUsername: sender.username, message: cleanMsg, timestamp: Date.now() };
        directMessageStore[dmKey].push(msgObj);
        
        // Cap history to 10 messages
        if (directMessageStore[dmKey].length > 10) {
            directMessageStore[dmKey] = directMessageStore[dmKey].slice(-10);
        }

        // Send to receiver if online
        if (targetSocketId) {
            io.to(targetSocketId).emit('receive_direct_message', {
                senderSocketId: socket.id,
                senderUsername: sender.username,
                message: cleanMsg,
                history: directMessageStore[dmKey]
            });
        }

        // Send back to sender for sync
        socket.emit('dm_sent_success', {
            targetUsername,
            history: directMessageStore[dmKey]
        });
    });

    socket.on('get_dm_history', ({ targetUsername }) => {
        const sender = connectedPlayers[socket.id];
        if (!sender) return;
        const dmKey = getDMKey(sender.username, targetUsername);
        socket.emit('load_dm_history', {
            targetUsername,
            history: directMessageStore[dmKey] || []
        });
    });

    // Record completed match for Leaderboard
    socket.on('record_match_played', (rawUsername) => {
        const uname = sanitizeUsername(rawUsername);
        if (uname && uname !== 'Player' && uname !== 'Guest') {
            playerStats[uname] = (playerStats[uname] || 0) + 1;
            broadcastLeaderboard();
        }
    });

    // Match Requests
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

    // Room operations
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
            
            if (room) {
                room.messages.push(msgObj);
                if (room.messages.length > 10) room.messages = room.messages.slice(-10); // Cap at 10
            }
            io.to(roomId).emit('receive_match_chat', msgObj);
        }
    });

    socket.on('disconnect', () => {
        delete connectedPlayers[socket.id];
        broadcastOnlineUsers();
    });
});

function broadcastOnlineUsers() {
    // ONLY include players who HAVE AN ACCOUNT (isAuthenticated) AND ARE SET TO ONLINE (isOnline)
    const playerList = Object.values(connectedPlayers)
        .filter(p => p.isAuthenticated && p.isOnline)
        .map(p => ({
            id: p.id,
            username: sanitizeUsername(p.username),
            friends: Array.from(p.friends)
        }));

    io.emit('online_users_update', { count: playerList.length, users: playerList });
}

function broadcastLeaderboard() {
    const topPlayers = Object.entries(playerStats)
        .map(([username, matches]) => ({ username: sanitizeUsername(username), matches }))
        .filter(p => p.username !== 'Player' && p.username !== 'Guest')
        .sort((a, b) => b.matches - a.matches)
        .slice(0, 5);

    io.emit('leaderboard_update', topPlayers);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));