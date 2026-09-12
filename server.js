const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, '/')));

const connectedPlayers = {}; 
const activeRoomsMap = new Map(); 
const playerStats = {}; 
const directMessageStore = {}; 

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeUsername(name) {
    if (!name || typeof name !== 'string') return 'Player';
    const trimmed = name.trim();
    if (!trimmed || trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null') {
        return 'Player';
    }
    return escapeHTML(trimmed.slice(0, 20));
}

function extractSmashUrl(rawInput) {
    if (!rawInput) return "https://smashkarts.io";
    const trimmed = String(rawInput).trim();
    
    // Match full http/https URLs (e.g. https://smashkarts.io/link/?room=usw341745)
    const match = trimmed.match(/https?:\/\/[^\s]+/);
    if (match) {
        return match[0];
    }
    
    if (trimmed.toLowerCase().includes('smashkarts.io')) {
        return 'https://' + trimmed.replace(/^https?:\/\//, '');
    }
    
    // If user enters just a raw room code (e.g. usw341745), format it into the official room link structure
    if (trimmed.length > 0 && !trimmed.includes(' ')) {
        return `https://smashkarts.io/link/?room=${encodeURIComponent(trimmed)}`;
    }
    
    return "https://smashkarts.io";
}

function moderateText(text) {
    if (!text) return '';
    const BANNED_WORDS = ['badword1', 'badword2', 'hate', 'spam'];
    let cleanText = escapeHTML(text);
    BANNED_WORDS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        cleanText = cleanText.replace(regex, '***');
    });
    return cleanText;
}

function getDMKey(u1, u2) {
    return [u1, u2].sort().join('__DM__');
}

function findSocketByUsername(username) {
    return Object.values(connectedPlayers).find(
        p => p.username.toLowerCase() === username.toLowerCase()
    );
}

function broadcastPublicRooms() {
    const roomsList = Array.from(activeRoomsMap.values());
    io.emit('public_rooms_update', roomsList);
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

    socket.on('set_user_session', (userData) => {
        if (!userData || !userData.username) return;
        const uname = sanitizeUsername(userData.username);
        
        const player = connectedPlayers[socket.id];
        if (player) {
            player.username = uname;
            player.email = userData.email || null;
            player.isAuthenticated = true;
            socket.emit('friend_requests_update', Array.from(player.friendRequests));
        }
        
        if (!playerStats[uname]) {
            playerStats[uname] = 0;
        }
        
        broadcastOnlineUsers();
        broadcastLeaderboard();
    });

    socket.on('toggle_online_status', (isOnline) => {
        if (connectedPlayers[socket.id]) {
            connectedPlayers[socket.id].isOnline = !!isOnline;
            broadcastOnlineUsers();
        }
    });

    socket.on('send_friend_request', ({ targetSocketId }) => {
        const sender = connectedPlayers[socket.id];
        const target = connectedPlayers[targetSocketId];

        if (sender && target && sender.isAuthenticated && target.isAuthenticated) {
            target.friendRequests.add(sender.username);
            io.to(targetSocketId).emit('receive_friend_request', {
                fromSocketId: socket.id,
                fromUsername: sender.username
            });
            io.to(targetSocketId).emit('friend_requests_update', Array.from(target.friendRequests));
        }
    });

    socket.on('decline_friend_request', ({ challengerUsername }) => {
        const user = connectedPlayers[socket.id];
        if (!user || !user.isAuthenticated) return;

        user.friendRequests.delete(challengerUsername);
        socket.emit('friend_requests_update', Array.from(user.friendRequests));
    });

    socket.on('accept_friend_request', ({ challengerUsername }) => {
        const user = connectedPlayers[socket.id];
        if (!user || !user.isAuthenticated) return;

        user.friends.add(challengerUsername);
        user.friendRequests.delete(challengerUsername);

        const challenger = findSocketByUsername(challengerUsername);
        if (challenger) {
            challenger.friends.add(user.username);
            io.to(challenger.id).emit('friend_request_accepted', { username: user.username });
        }

        socket.emit('friend_requests_update', Array.from(user.friendRequests));
        socket.emit('friend_request_accepted', { username: challengerUsername });
        broadcastOnlineUsers();
    });

    socket.on('send_direct_message', ({ targetUsername, message }) => {
        const sender = connectedPlayers[socket.id];
        if (!sender || !sender.isAuthenticated || !message || !message.trim()) return;

        const cleanTarget = sanitizeUsername(targetUsername);
        const targetPlayer = findSocketByUsername(cleanTarget);

        if (!sender.friends.has(cleanTarget)) {
            return socket.emit('dm_error', { message: 'You can only message users on your friends list.' });
        }

        const cleanMsg = moderateText(message.trim());
        const dmKey = getDMKey(sender.username, cleanTarget);

        if (!directMessageStore[dmKey]) directMessageStore[dmKey] = [];
        
        const msgObj = { senderUsername: sender.username, message: cleanMsg, timestamp: Date.now() };
        directMessageStore[dmKey].push(msgObj);
        
        if (directMessageStore[dmKey].length > 10) {
            directMessageStore[dmKey] = directMessageStore[dmKey].slice(-10);
        }

        if (targetPlayer) {
            io.to(targetPlayer.id).emit('receive_direct_message', {
                senderSocketId: socket.id,
                senderUsername: sender.username,
                message: cleanMsg,
                history: directMessageStore[dmKey]
            });
        }

        socket.emit('dm_sent_success', {
            targetUsername: cleanTarget,
            history: directMessageStore[dmKey]
        });
    });

    socket.on('get_dm_history', ({ targetUsername }) => {
        const sender = connectedPlayers[socket.id];
        if (!sender) return;
        const cleanTarget = sanitizeUsername(targetUsername);
        const dmKey = getDMKey(sender.username, cleanTarget);
        socket.emit('load_dm_history', {
            targetUsername: cleanTarget,
            history: directMessageStore[dmKey] || []
        });
    });

    socket.on('record_match_played', (rawUsername) => {
        const uname = sanitizeUsername(rawUsername);
        if (uname && uname !== 'Player' && uname !== 'Guest') {
            playerStats[uname] = (playerStats[uname] || 0) + 1;
            broadcastLeaderboard();
        }
    });

    socket.on('send_match_challenge', ({ targetSocketId, targetUsername, fromUsername, mode, smashUrl }) => {
        const sender = connectedPlayers[socket.id];
        const target = targetSocketId ? connectedPlayers[targetSocketId] : findSocketByUsername(targetUsername);

        if (!sender || !target) return;
        if (!sender.friends.has(target.username)) return;

        const senderName = sanitizeUsername(fromUsername);
        io.to(target.id).emit('receive_match_challenge', {
            challengerSocketId: socket.id,
            fromUsername: senderName,
            mode: mode || '1v1',
            smashUrl: extractSmashUrl(smashUrl)
        });
    });

    socket.on('accept_match_challenge', ({ challengerSocketId, targetUsername, smashUrl }) => {
        const acceptName = sanitizeUsername(targetUsername);
        const challenger = connectedPlayers[challengerSocketId];
        const challengerName = challenger ? challenger.username : 'Challenger';
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        const room = {
            roomId,
            hostName: challengerName,
            smashUrl: extractSmashUrl(smashUrl),
            winCondition: 'First to 3',
            mode: '1v1',
            maxPlayers: 2,
            players: [
                { id: socket.id, name: acceptName },
                { id: challengerSocketId, name: challengerName }
            ],
            exitedPlayers: [],
            messages: []
        };

        activeRoomsMap.set(roomId, room);

        socket.join(roomId);
        const challengerSocket = io.sockets.sockets.get(challengerSocketId);
        if (challengerSocket) challengerSocket.join(roomId);

        io.to(roomId).emit('challenge_game_start', room);
        broadcastPublicRooms();
    });

    socket.on('create_room', (data) => {
        const cleanUrl = extractSmashUrl(data.smashUrl);
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const mode = data.mode === '2v2' ? '2v2' : '1v1';
        const hostName = sanitizeUsername(data.playerName);
        
        const newRoom = {
            roomId,
            hostName,
            smashUrl: cleanUrl,
            winCondition: escapeHTML(data.winCondition || 'First to 3'),
            mode,
            maxPlayers: mode === '2v2' ? 4 : 2,
            players: [{ id: socket.id, name: hostName }],
            exitedPlayers: [],
            messages: []
        };

        activeRoomsMap.set(roomId, newRoom);

        socket.join(roomId);
        socket.emit('room_created', newRoom);
        broadcastPublicRooms();
    });

    socket.on('get_public_rooms', () => {
        broadcastPublicRooms();
    });

    socket.on('leave_match', ({ roomId }) => {
        const room = activeRoomsMap.get(roomId);
        if (!room) return;

        if (!room.exitedPlayers.includes(socket.id)) {
            room.exitedPlayers.push(socket.id);
        }

        if (room.exitedPlayers.length >= room.players.length) {
            activeRoomsMap.delete(roomId);
            broadcastPublicRooms();
        }
    });

    socket.on('send_match_chat', ({ roomId, message, senderName }) => {
        const room = activeRoomsMap.get(roomId);
        if (message && message.trim()) {
            const cleanMsg = moderateText(message.trim());
            const cleanSender = sanitizeUsername(senderName);
            const msgObj = { senderName: cleanSender, message: cleanMsg };
            
            if (room) {
                room.messages.push(msgObj);
                if (room.messages.length > 10) room.messages = room.messages.slice(-10);
            }
            io.to(roomId).emit('receive_match_chat', msgObj);
        }
    });

    socket.on('disconnect', () => {
        delete connectedPlayers[socket.id];
        
        for (const [roomId, room] of activeRoomsMap.entries()) {
            const isParticipant = room.players.some(p => p.id === socket.id);
            if (isParticipant) {
                if (!room.exitedPlayers.includes(socket.id)) {
                    room.exitedPlayers.push(socket.id);
                }
                if (room.exitedPlayers.length >= room.players.length) {
                    activeRoomsMap.delete(roomId);
                }
            }
        }

        broadcastOnlineUsers();
        broadcastPublicRooms();
    });
});

function broadcastOnlineUsers() {
    const playerList = Object.values(connectedPlayers)
        .filter(p => p.isAuthenticated && p.isOnline)
        .map(p => ({
            id: p.id,
            username: p.username,
            friends: Array.from(p.friends)
        }));

    io.emit('online_users_update', { count: playerList.length, users: playerList });
}

function broadcastLeaderboard() {
    const topPlayers = Object.entries(playerStats)
        .map(([username, matches]) => ({ username, matches }))
        .filter(p => p.username !== 'Player' && p.username !== 'Guest')
        .sort((a, b) => b.matches - a.matches)
        .slice(0, 5);

    io.emit('leaderboard_update', topPlayers);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Smashkarts1v1s Arena running on port ${PORT}`));