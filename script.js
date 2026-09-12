const socket = io();
let currentMode = '1v1';
let currentGameplayMode = 'popup'; // Default mode
let activeRoomData = null;
let chatInactivityTimer = null;
let activeDMTargetUser = null;
let unreadMessageCount = 0;
let pendingChallengeData = null;
let friendChallengeTargetUser = null;
let onlineUsersCache = [];
let publicRoomsCache = [];
let pendingFriendRequests = [];

function updateGameplayMode(mode) {
    currentGameplayMode = mode;
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showToast(message, icon = '🔔') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerHTML = `<span>${icon}</span> <span>${escapeHTML(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3505);
}

function incrementUnreadBadge() {
    unreadMessageCount++;
    const badge = document.getElementById('messagesBadge');
    if (!badge) return;
    badge.innerText = unreadMessageCount;
    badge.classList.remove('hidden');
}

function clearUnreadBadge() {
    unreadMessageCount = 0;
    const badge = document.getElementById('messagesBadge');
    if (!badge) return;
    badge.innerText = '0';
    badge.classList.add('hidden');
}

function openSettingsModal() {
    document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettingsModal() {
    document.getElementById('settingsModal').classList.add('hidden');
}

function toggleOnlineStatus(isOnline) {
    socket.emit('toggle_online_status', isOnline);
    showToast(isOnline ? "You are now VISIBLE online." : "You are now HIDDEN (Invisible).", isOnline ? "🟢" : "👻");
}

const AuthSession = {
    INACTIVITY_LIMIT_MS: 30 * 60 * 1000,
    WARNING_WINDOW_MS: 60 * 1000,
    THROTTLE_MS: 5000,
    lastActivity: Date.now(),
    isWarningShown: false,

    getRegisteredUsers() {
        try {
            return JSON.parse(localStorage.getItem("registered_users")) || [];
        } catch(e) {
            return [];
        }
    },

    saveRegisteredUser(userObj) {
        const users = this.getRegisteredUsers();
        users.push(userObj);
        localStorage.setItem("registered_users", JSON.stringify(users));
    },

    findUser(email, password) {
        const users = this.getRegisteredUsers();
        return users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
    },

    userExists(email) {
        const users = this.getRegisteredUsers();
        return users.some(u => u.email.toLowerCase() === email.toLowerCase());
    },

    login(email, username) {
        const cleanUser = (username && username.trim() !== '') ? username.trim() : "Player";
        const session = { email, username: cleanUser, token: "token_" + Date.now() };
        localStorage.setItem("user_session", JSON.stringify(session));
        document.getElementById("authModal").classList.add("hidden");
        this.startTracker();
        updateUserUI();
        showToast(`Welcome back, ${cleanUser}!`, "🎮");
    },

    getUser() {
        const sessionStr = localStorage.getItem("user_session");
        if (!sessionStr) return null;
        try {
            return JSON.parse(sessionStr);
        } catch(e) {
            return null;
        }
    },

    isLoggedIn() {
        return this.getUser() !== null;
    },

    logout() {
        localStorage.removeItem("user_session");
        window.location.reload();
    },

    startTracker() {
        // Disabled inactivity tracking so you never get automatically logged out
        this.lastActivity = Date.now();
    },

    handleActivity() {
        if (this.isWarningShown) return;
        const now = Date.now();
        if (now - this.lastActivity > this.THROTTLE_MS) {
            this.lastActivity = now;
        }
    },

    resetInactivity() {
        this.lastActivity = Date.now();
        this.hideWarning();
    },

    checkInactivity() {
        if (!this.isLoggedIn()) return;
        const timeIdle = Date.now() - this.lastActivity;
        const timeRemaining = this.INACTIVITY_LIMIT_MS - timeIdle;

        if (timeRemaining <= 0) {
            this.logout();
        } else if (timeRemaining <= this.WARNING_WINDOW_MS) {
            this.showWarning(Math.ceil(timeRemaining / 1000));
        } else {
            if (this.isWarningShown) this.hideWarning();
        }
    },

    showWarning(secondsLeft) {
        this.isWarningShown = true;
        document.getElementById("inactivityModal").classList.remove("hidden");
        document.getElementById("countdownTimer").textContent = secondsLeft;
    },

    hideWarning() {
        this.isWarningShown = false;
        document.getElementById("inactivityModal").classList.add("hidden");
    }
};

function toggleAuthTab(type) {
    const loginForm = document.getElementById("loginForm");
    const regForm = document.getElementById("registerForm");
    const tabLogin = document.getElementById("tabLoginBtn");
    const tabReg = document.getElementById("tabRegisterBtn");

    if (type === 'login') {
        loginForm.classList.remove("hidden");
        regForm.classList.add("hidden");
        tabLogin.className = "font-bungee text-lg text-yellow-300 border-b-2 border-yellow-300 pb-1";
        tabReg.className = "font-bungee text-lg text-white/50 pb-1 hover:text-white";
    } else {
        loginForm.classList.add("hidden");
        regForm.classList.remove("hidden");
        tabReg.className = "font-bungee text-lg text-yellow-300 border-b-2 border-yellow-300 pb-1";
        tabLogin.className = "font-bungee text-lg text-white/50 pb-1 hover:text-white";
    }
}

function handleAuthSubmit(e, type) {
    e.preventDefault();
    if (type === 'register') {
        const username = document.getElementById('regUsername').value.trim();
        const email = document.getElementById('regEmail').value.trim();
        const password = document.getElementById('regPassword').value.trim();

        if (AuthSession.userExists(email)) {
            showToast("An account with this email already exists! Please log in.", "⚠️");
            toggleAuthTab('login');
            return;
        }

        AuthSession.saveRegisteredUser({ username, email, password });
        showToast("Account successfully created! Please log in.", "🎉");
        toggleAuthTab('login');
        document.getElementById('regUsername').value = '';
        document.getElementById('regEmail').value = '';
        document.getElementById('regPassword').value = '';
    } else {
        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value.trim();

        const foundUser = AuthSession.findUser(email, password);
        if (!foundUser) {
            showToast("Account not found! Please sign up first.", "❌");
            return;
        }

        AuthSession.login(foundUser.email, foundUser.username);
    }
}

function promptEditUsername() {
    const user = AuthSession.getUser();
    document.getElementById("newUsernameInput").value = user ? user.username : "";
    document.getElementById("editUsernameModal").classList.remove("hidden");
}

function closeEditUsernameModal() {
    document.getElementById("editUsernameModal").classList.add("hidden");
}

function saveNewUsername() {
    const newUname = document.getElementById("newUsernameInput").value;
    const user = AuthSession.getUser();
    if (newUname && newUname.trim() !== '') {
        AuthSession.login(user ? user.email : 'player@example.com', newUname.trim());
        closeEditUsernameModal();
    }
}

function updateUserUI() {
    const user = AuthSession.getUser();
    if (user) {
        document.getElementById("userDisplayTag").innerText = user.username;
        socket.emit("set_user_session", user);
    }
}

function openOnlineModal() {
    if (!AuthSession.isLoggedIn()) {
        showToast("Please log in to view online players!", "⚠️");
        return;
    }
    document.getElementById('onlineUsersModal').classList.remove('hidden');
}

function closeOnlineModal() {
    document.getElementById('onlineUsersModal').classList.add('hidden');
}

socket.on('online_users_update', ({ count, users }) => {
    onlineUsersCache = users;
    document.getElementById('onlineCountBadge').innerText = `${count} Online`;
    renderOnlineUsersList(users);
    updateFriendsTabList();
});

function renderOnlineUsersList(users) {
    const container = document.getElementById('onlineUsersList');
    if (!container) return;
    container.innerHTML = '';

    const currentUser = AuthSession.getUser();
    const myUsername = currentUser ? currentUser.username : '';

    users.forEach(u => {
        if (u.id === socket.id || u.username === myUsername) return;

        const isFriend = u.friends && u.friends.includes(myUsername);
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center bg-blue-950/80 p-3 rounded-2xl border border-white/10';
        
        row.innerHTML = `
            <span class="font-bold text-xs text-white">👤 ${escapeHTML(u.username)}</span>
            <div class="flex gap-2">
                ${isFriend 
                    ? `<button onclick="openTabDMWith('${escapeHTML(u.username)}')" class="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold px-2.5 py-1.5 rounded-lg">💬 Message</button>`
                    : `<button onclick="sendFriendRequest('${u.id}', '${escapeHTML(u.username)}')" class="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-2.5 py-1.5 rounded-lg">➕ Add Friend</button>`
                }
            </div>
        `;
        container.appendChild(row);
    });
}

function sendFriendRequest(targetSocketId, username) {
    socket.emit('send_friend_request', { targetSocketId });
    showToast(`Friend request sent to ${username}!`, "➕");
}

socket.on('receive_friend_request', (data) => {
    incrementUnreadBadge();
    showToast(`New Friend Request from ${data.fromUsername}! Check Messages tab.`, "👋");
});

socket.on('friend_requests_update', (requests) => {
    pendingFriendRequests = requests;
    if (requests && requests.length > 0) {
        incrementUnreadBadge();
    }
    updateFriendsTabList();
});

function acceptFriendRequestByName(username) {
    socket.emit('accept_friend_request', { challengerUsername: username });
    showToast(`Accepted friend request from ${username}!`, "🤝");
}

function declineFriendRequestByName(username) {
    socket.emit('decline_friend_request', { challengerUsername: username });
    showToast(`Declined friend request from ${username}.`, "✕");
}

socket.on('friend_request_accepted', (data) => {
    showToast(`You and ${data.username} are now friends!`, "🤝");
    updateFriendsTabList();
});

function initiateFriend1v1(friendUsername) {
    friendChallengeTargetUser = friendUsername;
    document.getElementById('friendChallengeHeader').innerText = `⚔️ CREATE 1v1 ROOM LINK FOR ${friendUsername.toUpperCase()}`;
    document.getElementById('friendChallengeIframe').src = "https://smashkarts.io";
    document.getElementById('friendChallengeCodeInput').value = '';
    document.getElementById('friendChallengeModal').classList.remove('hidden');
}

function closeFriendChallengeModal() {
    document.getElementById('friendChallengeIframe').src = "";
    document.getElementById('friendChallengeModal').classList.add('hidden');
    friendChallengeTargetUser = null;
}

function sendFriendChallengeWithCode() {
    let codeInput = document.getElementById('friendChallengeCodeInput').value.trim();
    codeInput = extractSmashUrlClient(codeInput);

    if (!codeInput) {
        showToast("Error: You must paste a valid Smash Karts room link or code!", "⚠️");
        return;
    }

    const user = AuthSession.getUser();
    const targetUserObj = onlineUsersCache.find(u => u.username === friendChallengeTargetUser);

    if (!targetUserObj) {
        showToast(`${friendChallengeTargetUser} is not currently online!`, "⚠️");
        closeFriendChallengeModal();
        return;
    }

    socket.emit('send_match_challenge', {
        targetSocketId: targetUserObj.id,
        targetUsername: friendChallengeTargetUser,
        fromUsername: user ? user.username : 'Player',
        mode: '1v1',
        smashUrl: codeInput
    });

    showToast(`1v1 match challenge sent to ${friendChallengeTargetUser}!`, "⚔️");
    closeFriendChallengeModal();
}

socket.on('receive_match_challenge', (data) => {
    pendingChallengeData = data;
    document.getElementById('challengeText').innerText = `${data.fromUsername} challenged you to a 1v1 match!`;
    document.getElementById('challengeModal').classList.remove('hidden');
});

function acceptChallenge() {
    if (pendingChallengeData) {
        const user = AuthSession.getUser();
        socket.emit('accept_match_challenge', {
            challengerSocketId: pendingChallengeData.challengerSocketId,
            targetUsername: user ? user.username : 'Player',
            smashUrl: pendingChallengeData.smashUrl
        });
    }
    document.getElementById('challengeModal').classList.add('hidden');
}

function declineChallenge() {
    pendingChallengeData = null;
    document.getElementById('challengeModal').classList.add('hidden');
    showToast("Challenge declined.", "✕");
}

socket.on('challenge_game_start', (room) => {
    activeRoomData = room;
    enterGameFromLobby();
});

function showMessagesTab() {
    showTab('messagesTab');
    clearUnreadBadge();
    updateFriendsTabList();
}

function updateFriendsTabList() {
    const container = document.getElementById('friendsTabList');
    if (!container) return;
    container.innerHTML = '';
    
    const currentUser = AuthSession.getUser();
    if (!currentUser) return;

    const myUserObj = onlineUsersCache.find(u => u.username === currentUser.username);
    const friendNames = myUserObj ? myUserObj.friends : [];

    if (pendingFriendRequests && pendingFriendRequests.length > 0) {
        const pendingHeader = document.createElement('div');
        pendingHeader.className = 'font-bungee text-[10px] text-yellow-300 mb-1 mt-1';
        pendingHeader.innerText = 'PENDING REQUESTS';
        container.appendChild(pendingHeader);

        pendingFriendRequests.forEach(reqName => {
            const reqRow = document.createElement('div');
            reqRow.className = 'bg-yellow-500/20 border border-yellow-400/50 p-2 rounded-xl flex items-center justify-between mb-2';
            reqRow.innerHTML = `
                <span class="font-bold text-xs text-white">👤 ${escapeHTML(reqName)}</span>
                <div class="flex gap-1">
                    <button onclick="acceptFriendRequestByName('${escapeHTML(reqName)}')" class="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-2.5 py-1 rounded-lg">✔ Accept</button>
                    <button onclick="declineFriendRequestByName('${escapeHTML(reqName)}')" class="bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold px-2.5 py-1 rounded-lg">✕</button>
                </div>
            `;
            container.appendChild(reqRow);
        });
    }

    const friendsHeader = document.createElement('div');
    friendsHeader.className = 'font-bungee text-[10px] text-yellow-300 mb-1 mt-2';
    friendsHeader.innerText = 'YOUR FRIENDS';
    container.appendChild(friendsHeader);

    if (friendNames.length === 0) {
        const emptyMsg = document.createElement('p');
        emptyMsg.className = 'text-xs text-blue-200 mt-1';
        emptyMsg.innerText = 'No friends added yet. Open "Online Players" to add friends!';
        container.appendChild(emptyMsg);
        return;
    }

    friendNames.forEach(name => {
        const targetOnlineObj = onlineUsersCache.find(u => u.username === name);
        const isOnline = !!targetOnlineObj;

        const wrapper = document.createElement('div');
        wrapper.className = `p-2 rounded-xl flex flex-col gap-1 transition-all mb-1.5 ${activeDMTargetUser === name ? 'bg-yellow-400/30 border border-yellow-400' : 'bg-blue-950/60 hover:bg-blue-800/60'}`;
        
        wrapper.innerHTML = `
            <div class="flex items-center justify-between">
                <span class="font-bold text-xs text-white">👤 ${escapeHTML(name)}</span>
                <span class="w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-gray-500'}" title="${isOnline ? 'Online' : 'Offline'}"></span>
            </div>
            <div class="flex gap-1 mt-1">
                <button onclick="openTabDMWith('${escapeHTML(name)}')" class="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold px-2 py-1 rounded-lg flex-1">💬 DM</button>
                ${isOnline 
                    ? `<button onclick="initiateFriend1v1('${escapeHTML(name)}')" class="bg-yellow-400 hover:bg-yellow-300 text-blue-950 text-[10px] font-black px-2 py-1 rounded-lg uppercase flex-1">⚔️ 1v1</button>`
                    : `<button disabled class="bg-gray-600 text-gray-400 text-[10px] font-bold px-2 py-1 rounded-lg flex-1 cursor-not-allowed">Offline</button>`
                }
            </div>
        `;
        container.appendChild(wrapper);
    });
}

function openTabDMWith(username) {
    activeDMTargetUser = username;
    showMessagesTab();
    clearUnreadBadge();
    document.getElementById('activeDMChatHeader').innerText = `💬 MESSAGE WITH ${username.toUpperCase()}`;
    socket.emit('get_dm_history', { targetUsername: username });
}

function sendTabDM() {
    const input = document.getElementById('tabDMInput');
    const user = AuthSession.getUser();
    if (input.value.trim() && activeDMTargetUser) {
        socket.emit('send_direct_message', {
            targetUsername: activeDMTargetUser,
            message: input.value.trim(),
            senderUsername: user ? user.username : 'Player'
        });
        input.value = '';
    }
}

socket.on('dm_error', (data) => {
    showToast(data.message, "⚠️");
});

socket.on('receive_direct_message', (data) => {
    incrementUnreadBadge();
    showToast(`New message from ${data.senderUsername}`, "💬");
    if (activeDMTargetUser === data.senderUsername) {
        renderDMMessages(data.history);
    }
});

socket.on('dm_sent_success', (data) => {
    renderDMMessages(data.history);
});

socket.on('load_dm_history', (data) => {
    renderDMMessages(data.history);
});

function renderDMMessages(history) {
    const container = document.getElementById('tabDMMessages');
    if (!container) return;
    container.innerHTML = '';
    const user = AuthSession.getUser();
    const myUname = user ? user.username : 'Player';

    const capped = history.slice(-10);
    capped.forEach(msg => {
        const isMe = msg.senderUsername === myUname;
        const div = document.createElement('div');
        div.className = isMe ? 'text-right' : 'text-left';
        div.innerHTML = `<span class="${isMe ? 'bg-yellow-400 text-blue-950' : 'bg-blue-800 text-white'} font-bold px-2.5 py-1 rounded-xl inline-block text-[11px] mb-1">${isMe ? 'Me' : escapeHTML(msg.senderUsername)}: ${escapeHTML(msg.message)}</span>`;
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

socket.on('leaderboard_update', (topPlayers) => {
    const list = document.getElementById('leaderboardList');
    if (!list) return;
    list.innerHTML = topPlayers.length === 0 ? `<p class="text-xs text-blue-200">No matches recorded yet.</p>` : '';
    topPlayers.forEach((p, idx) => {
        const item = document.createElement('div');
        item.className = 'flex justify-between items-center bg-blue-900/60 border border-white/10 p-3 rounded-2xl';
        item.innerHTML = `
            <div class="flex items-center gap-3">
                <span class="font-bungee text-sm ${idx===0 ? 'text-yellow-300' : 'text-white'}">#${idx + 1}</span>
                <span class="font-bold text-xs text-white">👤 ${escapeHTML(p.username)}</span>
            </div>
            <span class="font-black text-xs text-yellow-300">${p.matches} Games Played</span>
        `;
        list.appendChild(item);
    });
});

function triggerChatActivityTimer() {
    const overlay = document.getElementById('chatOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden-overlay');
    clearTimeout(chatInactivityTimer);
    chatInactivityTimer = setTimeout(() => {
        overlay.classList.add('hidden-overlay');
        document.getElementById('toggleChatBtnLabel').innerText = 'Show Chat';
    }, 5005);
}

function toggleOverlayChat() {
    const overlay = document.getElementById('chatOverlay');
    const label = document.getElementById('toggleChatBtnLabel');
    if (overlay.classList.contains('hidden-overlay')) {
        overlay.classList.remove('hidden-overlay');
        label.innerText = 'Hide Chat';
        triggerChatActivityTimer();
    } else {
        overlay.classList.add('hidden-overlay');
        label.innerText = 'Show Chat';
        clearTimeout(chatInactivityTimer);
    }
}

document.getElementById('matchChatInput')?.addEventListener('input', triggerChatActivityTimer);

// Toggle the in-game options menu
function toggleGameHeaderDropdown() {
    const dropdown = document.getElementById('gameHeaderDropdown');
    if (dropdown) {
        dropdown.classList.toggle('hidden');
    }
}

function openMakeCodeModal() {
    document.getElementById('makeCodeIframe').src = "https://smashkarts.io";
    document.getElementById('makeCodeModal').classList.remove('hidden');
}

function closeMakeCodeModal() {
    document.getElementById('makeCodeIframe').src = "";
    document.getElementById('makeCodeModal').classList.add('hidden');
}

function extractSmashUrlClient(rawInput) {
    if (!rawInput) return "";
    let text = String(rawInput).trim();
    
    if (text.includes('ttps://')) {
        text = text.replace('ttps://', 'https://');
    }

    const linkMatch = text.match(/https?:\/\/(www\.)?smashkarts\.io\/link\/\?[^\s]+/i);
    if (linkMatch) {
        return linkMatch[0];
    }
    
    const roomMatch = text.match(/Room:\s*([A-Za-z0-9]+)/i);
    if (roomMatch) {
        return `https://smashkarts.io/link/?room=${encodeURIComponent(roomMatch[1])}`;
    }

    if (text.length > 0 && !text.includes(' ') && !text.includes('\n') && !text.includes('/')) {
        return `https://smashkarts.io/link/?room=${encodeURIComponent(text)}`;
    }

    return "";
}

function copyAndPlay() {
    const codeInput = document.getElementById('copyCodeInput').value.trim();
    const cleanLink = extractSmashUrlClient(codeInput);
    
    if (!cleanLink) {
        showToast("Error: You must paste the Smash Karts room link or code first!", "⚠️");
        return;
    }
    
    document.getElementById('smashUrl').value = cleanLink;
    closeMakeCodeModal();
    createLobby();
}

function switchMatchMode(mode) {
    currentMode = mode;
    showTab('setupTab');
    document.getElementById('btnNav1v1').classList.toggle('active', mode === '1v1');
    document.getElementById('btnNav2v2').classList.toggle('active', mode === '2v2');
    document.getElementById('arenaTitle').innerText = `${mode.toUpperCase()} MATCHMAKING`;
    document.getElementById('arenaSubtitle').innerText = `Start or join a ${mode} match`;
}

function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.sidebar-btn').forEach(btn => btn.classList.remove('active'));
    
    if (tabId === 'leaderboardTab') document.getElementById('btnNavLeaderboard').classList.add('active');
    if (tabId === 'messagesTab') document.getElementById('btnNavMessages').classList.add('active');
    if (tabId === 'setupTab') {
        document.getElementById(currentMode === '2v2' ? 'btnNav2v2' : 'btnNav1v1').classList.add('active');
    }
    
    document.getElementById(tabId).classList.remove('hidden');
}

function createLobby() {
    const user = AuthSession.getUser();
    const playerName = user ? user.username : "Player";
    
    let smashUrlInput = document.getElementById('smashUrl').value.trim();
    smashUrlInput = extractSmashUrlClient(smashUrlInput);

    if (!smashUrlInput) {
        showToast("Error: A valid Smash Karts room link or code is required!", "⚠️");
        return;
    }

    const winCondition = document.getElementById('winCondition').value;
    socket.emit('create_room', { playerName, smashUrl: smashUrlInput, winCondition, mode: currentMode });
}

socket.on('room_error', (data) => {
    showToast(data.message, "❌");
});

socket.on('room_created', (room) => openPreGameLobby(room));

function openPreGameLobby(room) {
    activeRoomData = room;
    closeFindGameModal();
    document.getElementById('preGameLobbyModal').classList.remove('hidden');
    updatePreGameLobbyUI(room);
}

function updatePreGameLobbyUI(room) {
    const playerList = document.getElementById('preGamePlayerList');
    if (!playerList) return;
    playerList.innerHTML = '';
    room.players.forEach((p, idx) => {
        const item = document.createElement('div');
        item.className = 'bg-blue-900/60 p-2 rounded-xl border border-white/10 flex justify-between';
        item.innerHTML = `<span class="font-bold text-white">👤 ${escapeHTML(p.name)}</span><span class="text-yellow-300 font-bold text-[10px]">Slot ${idx+1}</span>`;
        playerList.appendChild(item);
    });
}

function closePreGameLobbyModal() {
    document.getElementById('preGameLobbyModal').classList.add('hidden');
}

function enterGameFromLobby() {
    if (!activeRoomData || !activeRoomData.smashUrl) {
        showToast("Error: No valid Smash Karts launch room URL found!", "⚠️");
        return;
    }
    
    closePreGameLobbyModal();

    const user = AuthSession.getUser();
    if (user) {
        socket.emit('record_match_played', user.username);
    }

    const gameScreen = document.getElementById('gameScreen');
    const smashFrame = document.getElementById('smashFrame');
    const codeContainer = document.getElementById('gameRoomCodeContainer');
    const codeDisplay = document.getElementById('gameRoomCodeDisplay');
    
    // Check which setting the user chose
    if (currentGameplayMode === 'popup') {
        // 1. POPUP MODE: Open in a new window and hide the embed iframe
        window.open(activeRoomData.smashUrl, '_blank', 'width=1000,height=700');
        if (smashFrame) smashFrame.src = "";
        if (codeContainer) codeContainer.classList.add('hidden'); // Hide the code container
    } else {
        // 2. EMBED / TYPE IN CODE MODE: Put game in iframe and show code
        if (smashFrame) smashFrame.src = activeRoomData.smashUrl || "https://smashkarts.io";
        
        if (codeContainer) {
            codeContainer.classList.remove('hidden'); // Show the code text
            if (codeDisplay) codeDisplay.innerText = "(us643345)"; // Display your custom code
        }
    }
    
    // Show the game screen (for chat and UI)
    gameScreen.classList.remove('game-fade-exit', 'hidden');
    document.getElementById('gameModeBadge').innerText = activeRoomData.mode;
    triggerChatActivityTimer();
}

function leaveEmbeddedGame() {
    if (activeRoomData) {
        socket.emit('leave_match', { roomId: activeRoomData.roomId });
    }

    const gameScreen = document.getElementById('gameScreen');
    const smashFrame = document.getElementById('smashFrame');
    if (smashFrame) {
        smashFrame.src = '';
    }

    // Hide dropdown so it resets for the next game
    document.getElementById('gameHeaderDropdown').classList.add('hidden');

    gameScreen.classList.add('game-fade-exit');

    setTimeout(() => {
        gameScreen.classList.add('hidden');
        document.getElementById('mainDashboard').classList.remove('hidden');
        activeRoomData = null;
        
        const smashUrlInput = document.getElementById('smashUrl');
        if (smashUrlInput) smashUrlInput.value = '';
    }, 355);
}

function sendPreGameChatMessage() {
    const input = document.getElementById('preGameChatInput');
    const user = AuthSession.getUser();
    if (input.value.trim() && activeRoomData) {
        socket.emit('send_match_chat', { roomId: activeRoomData.roomId, message: input.value.trim(), senderName: user ? user.username : 'Player' });
        input.value = '';
    }
}

function sendMatchChatMessage() {
    const input = document.getElementById('matchChatInput');
    const user = AuthSession.getUser();
    if (input.value.trim() && activeRoomData) {
        socket.emit('send_match_chat', { roomId: activeRoomData.roomId, message: input.value.trim(), senderName: user ? user.username : 'Player' });
        input.value = '';
        triggerChatActivityTimer();
    }
}

socket.on('receive_match_chat', (data) => {
    const msg = `<div class="bg-blue-950/80 p-1.5 rounded-xl border border-white/10"><strong class="text-yellow-300">${escapeHTML(data.senderName)}:</strong> ${escapeHTML(data.message)}</div>`;
    
    const matchChat = document.getElementById('matchChatMessages');
    const preGameChat = document.getElementById('preGameChatMessages');

    if (matchChat) matchChat.innerHTML += msg;
    if (preGameChat) preGameChat.innerHTML += msg;

    if (matchChat) {
        while (matchChat.children.length > 10) matchChat.removeChild(matchChat.firstChild);
        matchChat.scrollTop = matchChat.scrollHeight;
    }
    if (preGameChat) {
        while (preGameChat.children.length > 10) preGameChat.removeChild(preGameChat.firstChild);
        preGameChat.scrollTop = preGameChat.scrollHeight;
    }
});

function openFindGameModal() {
    document.getElementById('findGameModal').classList.remove('hidden');
    socket.emit('get_public_rooms');
}

function closeFindGameModal() {
    document.getElementById('findGameModal').classList.add('hidden');
}

socket.on('public_rooms_update', (rooms) => {
    publicRoomsCache = rooms;
    const container = document.getElementById('publicRoomsList');
    if (!container) return;
    container.innerHTML = rooms.length === 0 ? `<p class="text-center text-xs text-blue-200">No rooms active.</p>` : '';
    
    rooms.forEach(room => {
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center bg-blue-950/80 p-3 rounded-2xl';
        row.innerHTML = `
            <div>
                <p class="text-xs text-white font-bold">${escapeHTML(room.hostName)} (${escapeHTML(room.mode)})</p>
                <p class="text-[10px] text-blue-200">${escapeHTML(room.winCondition)}</p>
            </div>
            <button onclick="joinPublicRoomById('${room.roomId}')" class="bg-emerald-500 hover:bg-emerald-400 text-white font-black px-3 py-1.5 rounded-xl text-xs uppercase">Join</button>
        `;
        container.appendChild(row);
    });
});

function joinPublicRoomById(roomId) {
    const room = publicRoomsCache.find(r => r.roomId === roomId);
    if (room) {
        openPreGameLobby(room);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    if (AuthSession.isLoggedIn()) {
        document.getElementById("authModal").classList.add("hidden");
        AuthSession.startTracker();
        updateUserUI();
    } else {
        document.getElementById("authModal").classList.remove("hidden");
    }
});