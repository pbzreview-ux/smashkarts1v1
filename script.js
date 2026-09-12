const socket = io();

let currentMatchMode = '1v1';
let activeRoomData = null;
let currentActiveDMUser = null;
let unreadMessagesCount = 0;

const SMASH_KARTS_BASE_URL = "https://smashkarts.io";

const AuthSession = {
    getUser() {
        const userStr = localStorage.getItem('smash_user');
        return userStr ? JSON.parse(userStr) : null;
    },
    setUser(user) {
        localStorage.setItem('smash_user', JSON.stringify(user));
        this.updateUI();
    },
    logout() {
        localStorage.removeItem('smash_user');
        window.location.reload();
    },
    updateUI() {
        const user = this.getUser();
        if (user) {
            document.getElementById('authModal').classList.add('hidden');
            document.getElementById('userDisplayTag').innerText = user.username;
            socket.emit('user_online', user.username);
        } else {
            document.getElementById('authModal').classList.remove('hidden');
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const user = AuthSession.getUser();
    AuthSession.updateUI();
    if (user) {
        socket.emit('request_leaderboard');
    }
    showTab('setupTab');
});

function showToast(message, icon = "⚡") {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = "bg-blue-900 border-2 border-yellow-400 text-white px-4 py-3 rounded-2xl shadow-2xl flex items-center gap-3 animate-bounce text-xs font-bold";
    toast.innerHTML = `<span class="text-lg">${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 4000);
}

function toggleAuthTab(tab) {
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const loginBtn = document.getElementById('tabLoginBtn');
    const regBtn = document.getElementById('tabRegisterBtn');

    if (tab === 'login') {
        loginForm.classList.remove('hidden');
        registerForm.classList.add('hidden');
        loginBtn.className = "font-bungee text-lg text-yellow-300 border-b-2 border-yellow-300 pb-1";
        regBtn.className = "font-bungee text-lg text-white/50 pb-1 hover:text-white";
    } else {
        loginForm.classList.add('hidden');
        registerForm.classList.remove('hidden');
        regBtn.className = "font-bungee text-lg text-yellow-300 border-b-2 border-yellow-300 pb-1";
        loginBtn.className = "font-bungee text-lg text-white/50 pb-1 hover:text-white";
    }
}

function handleAuthSubmit(event, type) {
    event.preventDefault();
    let username, email, password;

    if (type === 'login') {
        username = document.getElementById('loginUsername').value.trim();
        email = document.getElementById('loginEmail').value.trim();
        password = document.getElementById('loginPassword').value.trim();
    } else {
        username = document.getElementById('regUsername').value.trim();
        email = document.getElementById('regEmail').value.trim();
        password = document.getElementById('regPassword').value.trim();
    }

    if (!username || !email || !password) {
        showToast("Please fill out all fields!", "❌");
        return;
    }

    socket.emit('auth_user', { type, username, email, password });
}

socket.on('auth_success', (user) => {
    AuthSession.setUser(user);
    showToast(`Welcome back, ${user.username}!`, "🎉");
    socket.emit('request_leaderboard');
});

socket.on('auth_error', (msg) => {
    showToast(msg, "❌");
});

function openSettingsModal() {
    document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettingsModal() {
    document.getElementById('settingsModal').classList.add('hidden');
}

function extractRoomCodeClient(url) {
    if (!url) return 'us674723';
    const match = url.match(/room=([A-Za-z0-9]+)/i);
    if (match) return match[1];
    return url.split('/').pop() || 'us674723';
}

function toggleGameHeaderDropdown() {
    const dropdown = document.getElementById('gameHeaderDropdown');
    if (dropdown) dropdown.classList.toggle('hidden');
}

function toggleOnlineStatus(isChecked) {
    showToast(isChecked ? "You are now online" : "You are now offline", "🟢");
}

function promptEditUsername() {
    document.getElementById('editUsernameModal').classList.remove('hidden');
}

function closeEditUsernameModal() {
    document.getElementById('editUsernameModal').classList.add('hidden');
}

function saveNewUsername() {
    const newName = document.getElementById('newUsernameInput').value.trim();
    if (!newName) {
        showToast("Please enter a valid username", "❌");
        return;
    }
    const user = AuthSession.getUser();
    if (user) {
        user.username = newName;
        AuthSession.setUser(user);
        socket.emit('update_username', { email: user.email, newUsername: newName });
        closeEditUsernameModal();
        showToast("Username updated successfully!", "✅");
    }
}

function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
    document.getElementById(tabId).classList.remove('hidden');
}

function switchMatchMode(mode) {
    currentMatchMode = mode;
    document.getElementById('arenaTitle').innerText = `${mode} MATCHMAKING`;
    document.getElementById('btnNav1v1').classList.toggle('active', mode === '1v1');
    document.getElementById('btnNav2v2').classList.toggle('active', mode === '2v2');
    showTab('setupTab');
}

function showMessagesTab() {
    showTab('messagesTab');
    socket.emit('request_online_users');
}

function createLobby() {
    const url = document.getElementById('smashUrl').value.trim() || SMASH_KARTS_BASE_URL;
    const winCond = document.getElementById('winCondition').value;
    const user = AuthSession.getUser();

    activeRoomData = {
        mode: currentMatchMode,
        smashUrl: url,
        winCondition: winCond,
        host: user ? user.username : 'Player',
        players: [user ? user.username : 'Player']
    };

    socket.emit('create_lobby', activeRoomData);
}

socket.on('lobby_created', (lobbyData) => {
    activeRoomData = lobbyData;
    openPreGameLobbyModal();
    updatePreGameLobbyUI();
});

function openPreGameLobbyModal() {
    document.getElementById('preGameLobbyModal').classList.remove('hidden');
}

function closePreGameLobbyModal() {
    document.getElementById('preGameLobbyModal').classList.add('hidden');
}

function updatePreGameLobbyUI() {
    if (!activeRoomData) return;
    const playerList = document.getElementById('preGamePlayerList');
    playerList.innerHTML = activeRoomData.players.map(p => `<div class="bg-blue-900 p-2 rounded-xl text-white font-bold">🏎️ ${p}</div>`).join('');
}

function sendPreGameChatMessage() {
    const input = document.getElementById('preGameChatInput');
    const msg = input.value.trim();
    if (!msg) return;
    const user = AuthSession.getUser();
    socket.emit('pregame_chat_message', { sender: user ? user.username : 'Player', message: msg });
    input.value = '';
}

socket.on('pregame_chat_broadcast', (data) => {
    const container = document.getElementById('preGameChatMessages');
    container.innerHTML += `<div><strong class="text-yellow-300">${data.sender}:</strong> ${data.message}</div>`;
    container.scrollTop = container.scrollHeight;
});

function enterGameFromLobby() {
    if (!activeRoomData) {
        showToast("Error: No room data found!", "❌");
        return;
    }
    
    closePreGameLobbyModal();

    const user = AuthSession.getUser();
    if (user) {
        socket.emit('record_match_played', user.username);
    }

    let targetUrl = activeRoomData.smashUrl || SMASH_KARTS_BASE_URL;
    
    // Automatically format room codes (like us345347) into valid absolute URLs to avoid 404/white error screens
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        if (targetUrl.length < 15 && !targetUrl.includes('.')) {
            targetUrl = `https://smashkarts.io/join/${targetUrl}`;
        } else {
            targetUrl = `https://${targetUrl}`;
        }
    }

    // Open regular Smash Karts safely in a popup window
    window.open(targetUrl, 'SmashKartsMatch', 'width=1100,height=750,resizable=yes,scrollbars=yes');
    
    const gameScreen = document.getElementById('gameScreen');
    const smashFrame = document.getElementById('smashFrame');
    if (smashFrame) smashFrame.src = ''; // Clear iframe to completely prevent black screens / iframe restrictions
    
    gameScreen.classList.remove('hidden');
    document.getElementById('gameModeBadge').innerText = activeRoomData.mode;
}

function leaveEmbeddedGame() {
    document.getElementById('gameScreen').classList.add('hidden');
    const smashFrame = document.getElementById('smashFrame');
    if (smashFrame) smashFrame.src = '';
    showToast("Exited match arena", "🏁");
}

function toggleOverlayChat() {
    const overlay = document.getElementById('chatOverlay');
    const label = document.getElementById('toggleChatBtnLabel');
    overlay.classList.toggle('hidden-overlay');
    label.innerText = overlay.classList.contains('hidden-overlay') ? 'Show Chat' : 'Hide Chat';
}

function sendMatchChatMessage() {
    const input = document.getElementById('matchChatInput');
    const msg = input.value.trim();
    if (!msg) return;
    const user = AuthSession.getUser();
    socket.emit('match_chat_message', { sender: user ? user.username : 'Player', message: msg });
    input.value = '';
}

socket.on('match_chat_broadcast', (data) => {
    const container = document.getElementById('matchChatMessages');
    container.innerHTML += `<div><strong class="text-yellow-300">${data.sender}:</strong> ${data.message}</div>`;
    container.scrollTop = container.scrollHeight;
});

function openMakeCodeModal() {
    document.getElementById('makeCodeModal').classList.remove('hidden');
    const iframe = document.getElementById('makeCodeIframe');
    if (iframe) iframe.src = ''; // Clear iframe to avoid black screen policy blocks
}

function launchSmashKartsForCode() {
    // Opens regular Smash Karts in a new window so the user can easily grab their room code
    window.open(SMASH_KARTS_BASE_URL, 'SmashKartsGetCode', 'width=1100,height=750,resizable=yes,scrollbars=yes');
}

function closeMakeCodeModal() {
    document.getElementById('makeCodeModal').classList.add('hidden');
    const iframe = document.getElementById('makeCodeIframe');
    if (iframe) iframe.src = '';
}

function copyAndPlay() {
    const code = document.getElementById('copyCodeInput').value.trim();
    if (!code) {
        showToast("Please enter or paste a valid room code/link first!", "❌");
        return;
    }
    document.getElementById('smashUrl').value = code;
    closeMakeCodeModal();
    showToast("Room code loaded successfully!", "✅");
}

function openFindGameModal() {
    document.getElementById('findGameModal').classList.remove('hidden');
    socket.emit('request_public_rooms');
}

function closeFindGameModal() {
    document.getElementById('findGameModal').classList.add('hidden');
}

socket.on('public_rooms_list', (rooms) => {
    const list = document.getElementById('publicRoomsList');
    if (!rooms || rooms.length === 0) {
        list.innerHTML = `<div class="text-xs text-blue-200 text-center py-4">No active public lobbies right now. Create one!</div>`;
        return;
    }
    list.innerHTML = rooms.map(r => `
        <div class="bg-blue-950 p-3 rounded-2xl border border-white/10 flex justify-between items-center">
            <div>
                <span class="block font-bold text-yellow-300 text-xs">${r.mode} Match (${r.winCondition})</span>
                <span class="text-[10px] text-blue-200">Host: ${r.host}</span>
            </div>
            <button onclick='joinPublicRoom(${JSON.stringify(r)})' class="btn-smash px-3 py-1.5 rounded-xl font-bungee text-[10px] text-white">JOIN</button>
        </div>
    `).join('');
});

function joinPublicRoom(room) {
    activeRoomData = room;
    closeFindGameModal();
    openPreGameLobbyModal();
    updatePreGameLobbyUI();
}

function openOnlineModal() {
    document.getElementById('onlineUsersModal').classList.remove('hidden');
    socket.emit('request_online_users');
}

function closeOnlineModal() {
    document.getElementById('onlineUsersModal').classList.add('hidden');
}

socket.on('online_users_list', (users) => {
    document.getElementById('onlineCountBadge').innerText = `${users.length} Online`;
    
    const modalList = document.getElementById('onlineUsersList');
    modalList.innerHTML = users.map(u => `
        <div class="bg-blue-950 p-2.5 rounded-xl flex justify-between items-center text-xs text-white">
            <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span class="font-bold">${u}</span>
            </div>
            <button onclick="openDMWithUser('${u}')" class="bg-yellow-400 hover:bg-yellow-300 text-blue-950 font-black px-3 py-1 rounded-lg text-[10px] uppercase">Message</button>
        </div>
    `).join('');

    const friendsList = document.getElementById('friendsTabList');
    friendsList.innerHTML = users.map(u => `
        <div onclick="openDMWithUser('${u}')" class="bg-blue-950/80 hover:bg-blue-950 p-2.5 rounded-xl cursor-pointer flex items-center justify-between text-xs text-white border border-white/5">
            <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span class="font-bold">${u}</span>
            </div>
            <span class="text-[10px] text-yellow-300">Chat ➔</span>
        </div>
    `).join('');
});

function openDMWithUser(username) {
    currentActiveDMUser = username;
    closeOnlineModal();
    showMessagesTab();
    document.getElementById('activeDMChatHeader').innerText = `CHAT WITH ${username.toUpperCase()}`;
    socket.emit('request_dm_history', { recipient: username });
}

function sendTabDM() {
    const input = document.getElementById('tabDMInput');
    const text = input.value.trim();
    if (!text || !currentActiveDMUser) return;
    const user = AuthSession.getUser();
    socket.emit('send_dm', { sender: user ? user.username : 'Player', recipient: currentActiveDMUser, message: text });
    
    const container = document.getElementById('tabDMMessages');
    container.innerHTML += `<div><strong class="text-yellow-300">You:</strong> ${text}</div>`;
    container.scrollTop = container.scrollHeight;
    input.value = '';
}

socket.on('receive_dm', (data) => {
    if (currentActiveDMUser === data.sender) {
        const container = document.getElementById('tabDMMessages');
        container.innerHTML += `<div><strong class="text-emerald-300">${data.sender}:</strong> ${data.message}</div>`;
        container.scrollTop = container.scrollHeight;
    } else {
        unreadMessagesCount++;
        const badge = document.getElementById('messagesBadge');
        badge.innerText = unreadMessagesCount;
        badge.classList.remove('hidden');
        showToast(`New message from ${data.sender}`, "💬");
    }
});

socket.on('dm_history', (messages) => {
    const container = document.getElementById('tabDMMessages');
    const user = AuthSession.getUser();
    const currentName = user ? user.username : 'Player';
    container.innerHTML = messages.map(m => `
        <div><strong class="${m.sender === currentName ? 'text-yellow-300' : 'text-emerald-300'}">${m.sender}:</strong> ${m.message}</div>
    `).join('');
    container.scrollTop = container.scrollHeight;
});

socket.on('leaderboard_data', (leaders) => {
    const list = document.getElementById('leaderboardList');
    if (!leaders || leaders.length === 0) {
        list.innerHTML = `<div class="text-xs text-blue-200 text-center py-4">No leaderboard records yet. Play a match!</div>`;
        return;
    }
    list.innerHTML = leaders.map((l, index) => `
        <div class="bg-blue-950 p-3 rounded-2xl border border-white/10 flex justify-between items-center text-xs">
            <div class="flex items-center gap-3">
                <span class="font-bungee text-yellow-300 text-sm">#${index + 1}</span>
                <span class="font-bold text-white">${l.username}</span>
            </div>
            <span class="font-bungee text-emerald-300">${l.gamesPlayed || 0} Games Played</span>
        </div>
    `).join('');
});