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
let currentRoomCode = '';

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

/* ================== MEMORY FUNCTIONS ================== */
function getLocalFriends(username) {
    return JSON.parse(localStorage.getItem(`friends_${username}`)) || [];
}

function saveLocalFriends(username, friendsArray) {
    localStorage.setItem(`friends_${username}`, JSON.stringify(friendsArray));
}

function isUserFriend(targetUsername) {
    const currentUser = AuthSession.getUser();
    if (!currentUser) return false;
    
    let localFriends = getLocalFriends(currentUser.username);
    if (localFriends.includes(targetUsername)) return true;

    const myUserObj = onlineUsersCache.find(u => u.username === currentUser.username);
    if (myUserObj && myUserObj.friends && myUserObj.friends.includes(targetUsername)) {
        localFriends.push(targetUsername);
        saveLocalFriends(currentUser.username, localFriends);
        return true;
    }
    return false;
}

function renderLeaderboard(topPlayers) {
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
}
/* ======================================================= */

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
        
        renderLeaderboard(JSON.parse(localStorage.getItem('saved_leaderboard')) || []);
        updateFriendsTabList();
        
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

        const isFriend = isUserFriend(u.username);
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
    
    const user = AuthSession.getUser();
    if (user) {
        let friends = getLocalFriends(user.username);
        if (!friends.includes(username)) {
            friends.push(username);
            saveLocalFriends(user.username, friends);
        }
    }
    updateFriendsTabList();
}

function declineFriendRequestByName(username) {
    socket.emit('decline_friend_request', { challengerUsername: username });
    showToast(`Declined friend request from ${username}.`, "✕");
}

socket.on('friend_request_accepted', (data) => {
    showToast(`You and ${data.username} are now friends!`, "🤝");
    const user = AuthSession.getUser();
    if (user) {
        let friends = getLocalFriends(user.username);
        if (!friends.includes(data.username)) {
            friends.push(data.username);
            saveLocalFriends(user.username, friends);
        }
    }
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

    let friendNames = getLocalFriends(currentUser.username);
    
    const myUserObj = onlineUsersCache.find(u => u.username === currentUser.username);
    if (myUserObj && myUserObj.friends) {
        myUserObj.friends.forEach(f => {
            if (!friendNames.includes(f)) friendNames.push(f);
        });
        saveLocalFriends(currentUser.username, friendNames);
    }

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
    localStorage.setItem('saved_leaderboard', JSON.stringify(topPlayers));
    renderLeaderboard(topPlayers);
});

function triggerChatActivityTimer() {
    const overlay = document.getElementById('chatOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden-overlay');
    clearTimeout(chatInactivityTimer);
    chatInactivityTimer = setTimeout(() => {
        overlay.classList.add('hidden-overlay');
        const label = document.getElementById('toggleChatBtnLabel');
        if (label) label.innerText = 'Show Chat';
    }, 5005);
}

function toggleOverlayChat() {
    const overlay = document.getElementById('chatOverlay');
    const label = document.getElementById('toggleChatBtnLabel');
    if (!overlay) return;
    if (overlay.classList.contains('hidden-overlay')) {
        overlay.classList.remove('hidden-overlay');
        if (label) label.innerText = 'Hide Chat';
        triggerChatActivityTimer();
    } else {
        overlay.classList.add('hidden-overlay');
        if (label) label.innerText = 'Show Chat';
        clearTimeout(chatInactivityTimer);
    }
}

document.getElementById('matchChatInput')?.addEventListener('input', triggerChatActivityTimer);

function toggleGameTopBar() {
    const topBar = document.getElementById('gameTopBar');
    const icon = document.getElementById('topBarTabIcon');
    if (!topBar) return;

    if (topBar.classList.contains('translate-y-0')) {
        topBar.classList.remove('translate-y-0');
        if (icon) icon.innerText = '▼';
    } else {
        topBar.classList.add('translate-y-0');
        if (icon) icon.innerText = '▲';
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

    text = text.replace(/['"]+/g, '');

    const linkMatch = text.match(/https?:\/\/(www\.)?smashkarts\.io(\/link\/)?\?[^\s]+/i);
    if (linkMatch) {
        let matchedUrl = linkMatch[0];
        if (!matchedUrl.includes('/link/')) {
            matchedUrl = matchedUrl.replace('smashkarts.io/?', 'smashkarts.io/link/?');
        }
        return matchedUrl;
    }
    
    const roomMatch = text.match(/Room:\s*([A-Za-z0-9]+)/i) || text.match(/room=([A-Za-z0-9]+)/i);
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
        
        let localLeaderboard = JSON.parse(localStorage.getItem('saved_leaderboard')) || [];
        let pIndex = localLeaderboard.findIndex(p => p.username === user.username);
        if (pIndex >= 0) {
            localLeaderboard[pIndex].matches = (localLeaderboard[pIndex].matches || 0) + 1;
        } else {
            localLeaderboard.push({ username: user.username, matches: 1 });
        }
        localLeaderboard.sort((a, b) => b.matches - a.matches);
        localStorage.setItem('saved_leaderboard', JSON.stringify(localLeaderboard));
        renderLeaderboard(localLeaderboard);
    }

    const gameScreen = document.getElementById('gameScreen');
    const smashFrame = document.getElementById('smashFrame');
    const gameRoomCodeDisplay = document.getElementById('gameRoomCodeDisplay');
    
    let roomCode = "us643345";
    if (activeRoomData && activeRoomData.smashUrl) {
        const match = activeRoomData.smashUrl.match(/room=([A-Za-z0-9]+)/i);
        if (match) roomCode = match[1];
    }

    currentRoomCode = roomCode;
    if (gameRoomCodeDisplay) {
        gameRoomCodeDisplay.innerText = roomCode;
    }

    let popupMsgDiv = document.getElementById('popupMessageOverlay');
    if (!popupMsgDiv && gameScreen) {
        popupMsgDiv = document.createElement('div');
        popupMsgDiv.id = 'popupMessageOverlay';
        popupMsgDiv.className = 'absolute inset-0 flex items-center justify-center pointer-events-none z-10';
        gameScreen.appendChild(popupMsgDiv);
    }

    if (currentGameplayMode === 'popup') {
        window.open(activeRoomData.smashUrl, '_blank', 'width=1000,height=700');
        if (smashFrame) smashFrame.classList.add('hidden');
        if (popupMsgDiv) {
            popupMsgDiv.innerHTML = `<div class="bg-blue-950/90 border border-yellow-400/50 px-5 py-2.5 rounded-xl shadow-xl text-yellow-300 font-bungee text-xs tracking-wide">JOIN POP UP TAB :)</div>`;
            popupMsgDiv.classList.remove('hidden');
        }
    } else {
        if (popupMsgDiv) popupMsgDiv.classList.add('hidden');
        if (smashFrame) {
            smashFrame.classList.remove('hidden');
            smashFrame.src = activeRoomData.smashUrl || "https://smashkarts.io";
        }
    }
    
    gameScreen.classList.remove('game-fade-exit', 'hidden');
    const badge = document.getElementById('gameModeBadge');
    if (badge) badge.innerText = activeRoomData.mode;
    triggerChatActivityTimer();
}

function copyActiveRoomCode(code) {
    const codeToCopy = code || currentRoomCode;
    if (navigator.clipboard && codeToCopy) {
        navigator.clipboard.writeText(codeToCopy).then(() => {
            showToast(`Room code (${codeToCopy}) copied to clipboard!`, "📋");
        }).catch(() => {
            showToast("Failed to copy code.", "❌");
        });
    }
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

    const popupMsgDiv = document.getElementById('popupMessageOverlay');
    if (popupMsgDiv) popupMsgDiv.classList.add('hidden');

    const topBar = document.getElementById('gameTopBar');
    if (topBar) topBar.classList.remove('translate-y-0');

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

document.addEventListener("DOMContentLoaded", () => {
    if (AuthSession.isLoggedIn()) {
        document.getElementById("authModal").classList.add("hidden");
        AuthSession.startTracker();
        updateUserUI();
        
        renderLeaderboard(JSON.parse(localStorage.getItem('saved_leaderboard')) || []);
        updateFriendsTabList();
    } else {
        document.getElementById("authModal").classList.remove("hidden");
    }
});
/* =========================================================
   V22 KART HUB LAUNCHER
   Added on top of the stable V20 frontend. This module is
   intentionally client-side so it cannot corrupt persistent
   accounts, roles, DMs, tournaments, Redis state, or the bot.
   ========================================================= */
(function installKartHubV22(){
    const HUB_STATE_KEY = 'kart_hub_v22_state';
    const HUB_FEATURE_KEY = 'kart_hub_v22_features';
    const DEATH_REF_KEY = 'kart_hub_v22_death_reference';
    const HUB_VERSION = '22.0';
    let hubRoot = null;
    let currentView = 'home';
    let grindTick = null;
    let screenStream = null;
    let deathDetectorTimer = null;
    let deathDetectorHits = 0;
    let deathDetectorCooldownUntil = 0;
    let latestQueueCounts = {};
    let latestQueueState = null;

    const defaults = {
        sessionStartedAt: Date.now(), sessionPausedAt: 0, sessionPausedTotal: 0,
        sessionRunning: true, kills: 0, deaths: 0, wins: 0, losses: 0, matches: 0,
        reps: 0, launches: 0, streak: 0, bestStreak: 0, xp: 0, region: 'auto',
        ratingBand: 150, recentOpponentAvoid: true, topBarHeight: 52, topBarDrop: 0,
        compactBar: false, focusMode: false, highContrast: false, largeText: false,
        reducedMotion: false, goalMatches: 10, goalWins: 5, goalReps: 50,
        dailyNote: '', currentMap: '', currentWeapon: '', activeDrills: [],
        drillProgress: {}, featureSearch: '', featureCategory: 'all',
        coachTip: 'Share your Smash Karts screen, then use the death detector or manual counters.',
        deathThreshold: 18, deathDetectorEnabled: false, lastRoomCode: '',
        recentRooms: [], sessionHistory: [], commandOpen: false
    };

    function readJSON(key, fallback){ try { const v=JSON.parse(localStorage.getItem(key)); return v==null?fallback:v; } catch { return fallback; } }
    function writeJSON(key, value){ try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
    let state = Object.assign({}, defaults, readJSON(HUB_STATE_KEY, {}));
    let featureFlags = readJSON(HUB_FEATURE_KEY, {});
    function save(){ writeJSON(HUB_STATE_KEY, state); writeJSON(HUB_FEATURE_KEY, featureFlags); }
    function esc(value){ return String(value ?? '').replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
    function clamp(n,min,max){ return Math.max(min,Math.min(max,Number(n)||0)); }
    function toast(text){ const el=document.createElement('div'); el.className='kh-toast'; el.textContent=text; document.body.appendChild(el); setTimeout(()=>el.remove(),2200); }
    function currentUser(){ try { return typeof AuthSession!=='undefined' && AuthSession.getUser ? AuthSession.getUser() : null; } catch { return null; } }
    function levelFromXp(xp){ return Math.min(200, Math.max(1, Math.floor(Math.sqrt(Math.max(0,xp)/45))+1)); }
    function levelProgress(){ const lvl=levelFromXp(state.xp); const low=Math.pow(lvl-1,2)*45; const high=Math.pow(lvl,2)*45; return Math.round(100*(state.xp-low)/Math.max(1,high-low)); }
    function addXp(amount, reason='grind'){ state.xp=Math.max(0,state.xp+Number(amount||0)); save(); refreshChrome(); toast(`+${amount} XP · ${reason}`); }
    function sessionElapsed(){ const end=state.sessionRunning?Date.now():(state.sessionPausedAt||Date.now()); return Math.max(0,end-state.sessionStartedAt-state.sessionPausedTotal); }
    function fmtTime(ms){ const s=Math.floor(ms/1000); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }

    // 524 individual tools / drill presets / analytics switches.
    const skillAreas = ['Movement','Aim','Dodging','Routing','Pickup Control','Weapon Timing','Spawn Control','Positioning','Camera Control','Boost Control','Drift Control','Recovery','Awareness','Prediction','Counterplay','Pressure','Defense','Aggression','Patience','Closing','Comebacks','Consistency','Tournament Play','Mental Reset'];
    const drillModes = ['Warmup','5-Minute Focus','10 Reps','25 Reps','No-Death Challenge','Speed Run','Precision Run','Consistency Set','Under Pressure','Replay Review','Personal Best','Daily Challenge'];
    const metrics = ['Kills','Deaths','K/D','Wins','Losses','Win Rate','Match Count','Session Time','Streak','Reps','Launches','XP'];
    const metricViews = ['Live','Session','Today','7 Days','30 Days','Best','Average','Trend'];
    const oneVOneDimensions = ['Queue Speed','Rating Quality','Opponent Variety','Rematch Control','Warmup Flow','Ranked Focus','Casual Focus','Match Notes','Tilt Control','Result Review'];
    const oneVOneModes = ['Minimal','Balanced','Aggressive','Safe','Grind'];
    const ffaDimensions = ['12 Player','24 Player','Lobby Discovery','Route Practice','Survival Focus','Score Push'];
    const ffaModes = ['Quick','Balanced','High Pressure','Practice','Tournament'];
    const ecosystemGroups = ['Launcher','Social','Tournament','Coach','Streamer','Customization','Accessibility','Performance','Privacy','Utilities'];
    const ecosystemTools = ['Quick Toggle','Smart Reminder','Preset','Compact Mode','History','Favorite'];

    const featureCatalog = [];
    skillAreas.forEach(area=>drillModes.forEach(mode=>featureCatalog.push({id:`drill:${area}:${mode}`,category:'Grind Drills',name:`${area} · ${mode}`,desc:'Trackable practice preset with reps and completion.'})));
    metrics.forEach(metric=>metricViews.forEach(view=>featureCatalog.push({id:`metric:${metric}:${view}`,category:'Analytics',name:`${metric} · ${view}`,desc:'Enable this analytics view in your grind setup.'})));
    oneVOneDimensions.forEach(dim=>oneVOneModes.forEach(mode=>featureCatalog.push({id:`1v1:${dim}:${mode}`,category:'1v1 Arena',name:`${dim} · ${mode}`,desc:'1v1 preference / workflow switch.'})));
    ffaDimensions.forEach(dim=>ffaModes.forEach(mode=>featureCatalog.push({id:`ffa:${dim}:${mode}`,category:'FFA',name:`${dim} · ${mode}`,desc:'FFA launcher or grind preference.'})));
    ecosystemGroups.forEach(group=>ecosystemTools.forEach(tool=>featureCatalog.push({id:`eco:${group}:${tool}`,category:group,name:`${group} · ${tool}`,desc:'Hub utility control stored to your browser profile.'})));

    const navItems = [
        ['home','🏠','HOME'],['arena','⚔️','1v1 ARENA'],['grind','🔥','GRIND LAB'],['stats','📊','STATS'],
        ['coach','🎯','COACH'],['stream','🔴','STREAMER'],['social','💬','SOCIAL'],['tourney','🏆','TOURNAMENTS'],
        ['features','⚡','FEATURE VAULT'],['settings','⚙️','SETTINGS']
    ];

    function createHub(){
        if(document.getElementById('khHub')) return document.getElementById('khHub');
        const root=document.createElement('div'); root.id='khHub';
        root.innerHTML=`<div class="kh-shell">
            <aside class="kh-left">
                <div class="kh-card kh-profile" id="khProfileCard"></div>
                <div class="kh-side-title">HUB</div>
                <div class="kh-card kh-nav" id="khNav"></div>
            </aside>
            <main class="kh-main" id="khMain"></main>
            <aside class="kh-right">
                <div class="kh-side-title">TODAY</div>
                <div class="kh-card kh-profile" id="khToday"></div>
                <div class="kh-side-title">QUICK</div>
                <div class="kh-card kh-nav" id="khQuickSide"></div>
                <div class="kh-side-title">STATUS</div>
                <div class="kh-card kh-profile" id="khStatus"></div>
            </aside>
        </div>`;
        document.body.appendChild(root); hubRoot=root;
        const nav=root.querySelector('#khNav');
        navItems.forEach(([id,icon,label])=>{ const b=document.createElement('button'); b.dataset.view=id; b.innerHTML=`${icon} ${label}`; b.onclick=()=>showView(id); nav.appendChild(b); });
        root.querySelector('#khQuickSide').innerHTML=`
            <button onclick="window.kartHub.playSK()">▶ PLAY SMASH KARTS</button>
            <button onclick="window.kartHub.show('arena')">⚔ 1v1 MATCHMAKING</button>
            <button onclick="window.kartHub.openCreate()">＋ CREATE LOBBY</button>
            <button onclick="window.kartHub.openJoin()">↪ JOIN / FIND GAME</button>
            <button onclick="window.kartHub.show('grind')">🔥 START GRIND</button>
            <button onclick="window.kartHub.command()">⌨ COMMAND PALETTE</button>`;
        createCommandPalette(); createHubReturnButton(); applyVisualSettings(); refreshChrome(); showView('home');
        return root;
    }

    function refreshChrome(){
        if(!hubRoot) return;
        const user=currentUser(); const level=levelFromXp(state.xp); const p=levelProgress();
        const avatar=(user?.avatar||user?.pfp||'');
        hubRoot.querySelector('#khProfileCard').innerHTML=`<div class="kh-profile-top"><div class="kh-avatar">${avatar?`<img src="${esc(avatar)}" alt="">`:'🏎️'}</div><div><div class="kh-name">${esc(user?.username||'Guest Racer')}</div><div class="kh-sub">HUB LEVEL ${level} · ${state.xp} XP</div></div></div><div class="kh-progress"><div class="kh-progress-row"><span>LEVEL ${level}</span><span>${p}%</span></div><div class="kh-bar"><i style="width:${p}%"></i></div></div><div class="kh-mini-grid"><div class="kh-stat"><b>${state.wins}</b><span>Wins</span></div><div class="kh-stat"><b>${state.streak}</b><span>Streak</span></div><div class="kh-stat"><b>${state.matches}</b><span>Matches</span></div><div class="kh-stat"><b>${state.reps}</b><span>Reps</span></div></div>`;
        const wr=state.matches?Math.round(100*state.wins/state.matches):0;
        hubRoot.querySelector('#khToday').innerHTML=`<div class="kh-stat"><b id="khSessionClock">${fmtTime(sessionElapsed())}</b><span>Session</span></div><div class="kh-mini-grid"><div class="kh-stat"><b>${state.kills}</b><span>Kills</span></div><div class="kh-stat"><b>${state.deaths}</b><span>Deaths</span></div><div class="kh-stat"><b>${wr}%</b><span>Win Rate</span></div><div class="kh-stat"><b>${featureCatalog.length}</b><span>Tools</span></div></div>`;
        const online=document.getElementById('onlineCountBadge')?.textContent||'Live';
        hubRoot.querySelector('#khStatus').innerHTML=`<div class="kh-status-row" style="justify-content:flex-start"><span class="kh-pill green">● ${esc(online)}</span><span class="kh-pill">V${HUB_VERSION}</span><span class="kh-pill yellow">${featureCatalog.length} FEATURES</span></div><p style="margin-top:10px;font-size:9px;color:#cfe4ff">Stable V20 backend preserved. Hub tools are layered client-side.</p>`;
        hubRoot.querySelectorAll('#khNav button').forEach(b=>b.classList.toggle('active',b.dataset.view===currentView));
    }

    function panel(title, copy, body){ return `<section class="kh-card kh-panel"><div class="kh-panel-head"><div><div class="kh-panel-title">${title}</div><div class="kh-panel-copy">${copy}</div></div><span class="kh-pill yellow">${featureCatalog.length} HUB TOOLS</span></div>${body}</section>`; }
    function showView(view){ currentView=view; if(!hubRoot)createHub(); hubRoot.classList.remove('kh-hidden'); refreshChrome(); const main=hubRoot.querySelector('#khMain'); if(!main)return;
        if(view==='home') renderHome(main); else if(view==='arena') renderArena(main); else if(view==='grind') renderGrind(main); else if(view==='stats') renderStats(main); else if(view==='coach') renderCoach(main); else if(view==='stream') renderStream(main); else if(view==='social') renderSocial(main); else if(view==='tourney') renderTourney(main); else if(view==='features') renderFeatures(main); else renderSettings(main);
        refreshChrome();
    }
    function hideHub(){ hubRoot?.classList.add('kh-hidden'); }
    function showHub(){ if(!hubRoot)createHub(); hubRoot.classList.remove('kh-hidden'); showView(currentView||'home'); }

    function renderHome(main){
        main.innerHTML=`<div class="kh-center-home"><div class="kh-logo"><span class="a">KART</span><br><span class="b">HUB</span></div><div class="kh-tagline">PLAY · GRIND · COMPETE · CREATE</div><button class="kh-play" id="khPlay">▶ PLAY SK</button><div class="kh-quick"><button data-q="arena">⚔ 1v1 ARENA</button><button data-q="create">＋ CREATE</button><button data-q="join">↪ JOIN</button><button data-q="grind">🔥 GRIND</button></div><div class="kh-status-row"><span class="kh-pill green">Launcher Ready</span><span class="kh-pill">Ctrl+K Commands</span><span class="kh-pill">Adjustable Game Bar</span><span class="kh-pill">Coach / Stream Share</span></div></div>`;
        main.querySelector('#khPlay').onclick=playSK;
        main.querySelector('[data-q="arena"]').onclick=()=>showView('arena');
        main.querySelector('[data-q="create"]').onclick=openCreate;
        main.querySelector('[data-q="join"]').onclick=openJoin;
        main.querySelector('[data-q="grind"]').onclick=()=>showView('grind');
    }

    function renderArena(main){
        const casual=Number(latestQueueCounts['1v1:casual:2']||0), ranked=Number(latestQueueCounts['1v1:ranked:2']||0);
        main.innerHTML=panel('1v1 ARENA','A separate competitive area for matchmaking, grinding and custom rooms.',`<div class="kh-arena-hero"><h2>1v1</h2><p>Queue from here without mixing competitive play into the rest of the launcher.</p><div class="kh-arena-modes"><div class="kh-mode casual" data-mode="casual"><strong>CASUAL</strong><span>${casual} searching · fast queue · guests allowed</span></div><div class="kh-mode rank" data-mode="ranked"><strong>RANKED</strong><span>${ranked} searching · rating focused · account required</span></div><div class="kh-mode custom" data-mode="custom"><strong>CUSTOM</strong><span>Create or paste a private Smash Karts room.</span></div></div><div class="kh-status-row" style="justify-content:flex-start"><span class="kh-pill" id="khQueueState">${esc(queueStatusText())}</span><button class="kh-btn red" id="khCancelQueue">CANCEL QUEUE</button></div></div><div class="kh-grid" style="margin-top:12px"><div class="kh-box kh-span-6"><h3>MATCHMAKING PREFERENCES</h3><label class="kh-label">Region</label><select class="kh-select" id="khRegion"><option value="auto">Auto</option><option value="us-east">US East</option><option value="us-west">US West</option><option value="eu">Europe</option><option value="asia">Asia</option></select><label class="kh-label">Preferred rating search band: ±<span id="khBandValue">${state.ratingBand}</span></label><input class="kh-range" id="khRatingBand" type="range" min="50" max="500" step="25" value="${state.ratingBand}"><label class="kh-label"><input type="checkbox" id="khAvoidRecent" ${state.recentOpponentAvoid?'checked':''}> Avoid recent opponents when possible</label></div><div class="kh-box kh-span-6"><h3>GRIND SHORTCUTS</h3><div class="kh-mini-grid"><button class="kh-btn" data-arena-action="warmup">5 MIN WARMUP</button><button class="kh-btn" data-arena-action="note">OPPONENT NOTE</button><button class="kh-btn" data-arena-action="win">LOG WIN</button><button class="kh-btn" data-arena-action="loss">LOG LOSS</button></div><p style="margin-top:10px">Ranked remains account-only. Custom rooms remain casual/manual so competitive verification can stay separate.</p></div></div>`);
        main.querySelector('[data-mode="casual"]').onclick=()=>join1v1('casual'); main.querySelector('[data-mode="ranked"]').onclick=()=>join1v1('ranked'); main.querySelector('[data-mode="custom"]').onclick=openCustom1v1; main.querySelector('#khCancelQueue').onclick=cancelQueue;
        const region=main.querySelector('#khRegion'); region.value=state.region; region.onchange=e=>{state.region=e.target.value;save();};
        const band=main.querySelector('#khRatingBand'); band.oninput=e=>{state.ratingBand=Number(e.target.value);main.querySelector('#khBandValue').textContent=state.ratingBand;save();};
        main.querySelector('#khAvoidRecent').onchange=e=>{state.recentOpponentAvoid=e.target.checked;save();};
        main.querySelector('[data-arena-action="warmup"]').onclick=()=>{showView('grind'); setTimeout(()=>startPresetDrill('Movement · Warmup'),0);};
        main.querySelector('[data-arena-action="note"]').onclick=()=>{const n=prompt('Opponent / matchup note:'); if(n){state.dailyNote=(state.dailyNote?state.dailyNote+'\n':'')+n;save();toast('Opponent note saved.');}};
        main.querySelector('[data-arena-action="win"]').onclick=()=>logResult(true); main.querySelector('[data-arena-action="loss"]').onclick=()=>logResult(false);
    }

    function queueStatusText(){ if(!latestQueueState)return 'Not searching'; if(latestQueueState.state==='queued')return `Searching ${String(latestQueueState.queueType||'').toUpperCase()} 1v1…`; return latestQueueState.message||latestQueueState.state||'Ready'; }
    function join1v1(type){ const user=currentUser(); if(type==='ranked' && user?.isGuest){ toast('Ranked requires a saved account.'); try{window.openOptionalLogin?.();}catch{} return; } latestQueueState={state:'queued',queueType:type}; socket.emit('join_matchmaking_queue',{mode:'1v1',queueType:type,maxPlayers:2,region:state.region||'auto',ratingBand:state.ratingBand,avoidRecent:state.recentOpponentAvoid}); renderArena(hubRoot.querySelector('#khMain')); }
    function cancelQueue(){ socket.emit('cancel_matchmaking'); latestQueueState=null; if(currentView==='arena')renderArena(hubRoot.querySelector('#khMain')); }
    function openCustom1v1(){ hideHub(); try{window.switchMatchMode?.('1v1');}catch{} }

    function renderGrind(main){
        const active=state.activeDrills||[];
        main.innerHTML=panel('GRIND LAB','Session tracking, goals, reps, drills, notes and mental-reset tools.',`<div class="kh-grid"><div class="kh-box kh-span-4"><h3>SESSION</h3><div class="kh-grind-timer" id="khGrindClock">${fmtTime(sessionElapsed())}</div><div style="display:flex;gap:7px"><button class="kh-btn green" id="khPause">${state.sessionRunning?'PAUSE':'RESUME'}</button><button class="kh-btn red" id="khResetSession">RESET SESSION</button></div><label class="kh-label">Daily note</label><textarea class="kh-textarea" id="khDailyNote" placeholder="What are you grinding today?">${esc(state.dailyNote)}</textarea></div><div class="kh-box kh-span-4"><h3>LIVE COUNTERS</h3>${counterHTML('kills','Kills',state.kills)}${counterHTML('deaths','Deaths',state.deaths)}${counterHTML('wins','Wins',state.wins)}${counterHTML('losses','Losses',state.losses)}${counterHTML('reps','Reps',state.reps)}</div><div class="kh-box kh-span-4"><h3>GOALS</h3>${goalHTML('Matches',state.matches,state.goalMatches,'goalMatches')}${goalHTML('Wins',state.wins,state.goalWins,'goalWins')}${goalHTML('Reps',state.reps,state.goalReps,'goalReps')}<button class="kh-btn yellow wide" id="khCompleteGoal" style="margin-top:8px">CLAIM DAILY GRIND XP</button></div><div class="kh-box kh-span-6"><h3>ACTIVE DRILL QUEUE</h3><div class="kh-drill-list" id="khActiveDrills">${active.length?active.map(id=>drillRow(id)).join(''):'<p>No drills queued. Add one from Feature Vault or use a preset below.</p>'}</div></div><div class="kh-box kh-span-6"><h3>QUICK PRESETS</h3><div class="kh-mini-grid"><button class="kh-btn" data-preset="Movement · Warmup">MOVEMENT</button><button class="kh-btn" data-preset="Aim · 25 Reps">AIM 25</button><button class="kh-btn" data-preset="Dodging · No-Death Challenge">NO-DEATH</button><button class="kh-btn" data-preset="Mental Reset · 5-Minute Focus">RESET</button><button class="kh-btn" data-preset="Consistency · Daily Challenge">CONSISTENCY</button><button class="kh-btn" data-preset="Tournament Play · Under Pressure">PRESSURE</button></div><label class="kh-label">Current map / arena</label><input class="kh-input" id="khMap" value="${esc(state.currentMap)}" placeholder="Optional"><label class="kh-label">Current weapon focus</label><input class="kh-input" id="khWeapon" value="${esc(state.currentWeapon)}" placeholder="Optional"></div></div>`);
        main.querySelector('#khPause').onclick=toggleSession; main.querySelector('#khResetSession').onclick=resetSession; main.querySelector('#khDailyNote').oninput=e=>{state.dailyNote=e.target.value;save();}; main.querySelector('#khCompleteGoal').onclick=claimGoalXp; main.querySelector('#khMap').oninput=e=>{state.currentMap=e.target.value;save();}; main.querySelector('#khWeapon').oninput=e=>{state.currentWeapon=e.target.value;save();};
        main.querySelectorAll('[data-counter]').forEach(b=>b.onclick=()=>adjustCounter(b.dataset.counter,Number(b.dataset.delta))); main.querySelectorAll('[data-goal]').forEach(i=>i.onchange=()=>{state[i.dataset.goal]=Math.max(1,Number(i.value)||1);save();renderGrind(main);}); main.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>startPresetDrill(b.dataset.preset)); main.querySelectorAll('[data-drill-plus]').forEach(b=>b.onclick=()=>logDrillRep(b.dataset.drillPlus)); main.querySelectorAll('[data-drill-remove]').forEach(b=>b.onclick=()=>removeDrill(b.dataset.drillRemove));
    }
    function counterHTML(key,label,value){ return `<div class="kh-counter"><span>${label}</span><b>${value}</b><div class="kh-counter-controls"><button data-counter="${key}" data-delta="-1">−</button><button data-counter="${key}" data-delta="1">＋</button></div></div>`; }
    function goalHTML(label,value,goal,key){ const pct=Math.min(100,Math.round(100*value/Math.max(1,goal))); return `<label class="kh-label">${label}: ${value} / <input data-goal="${key}" type="number" value="${goal}" min="1" style="width:55px;background:#092f67;color:white;border:1px solid #6d9ed5;border-radius:7px;padding:2px 4px"></label><div class="kh-bar"><i style="width:${pct}%"></i></div>`; }
    function drillRow(id){ const f=featureCatalog.find(x=>x.id===id); if(!f)return''; const p=Number(state.drillProgress?.[id]||0); return `<div class="kh-drill"><div><b>${esc(f.name)}</b><br><small>${p} reps logged</small></div><button data-drill-plus="${esc(id)}">+ REP</button><button data-drill-remove="${esc(id)}">✕</button></div>`; }
    function startPresetDrill(name){ const f=featureCatalog.find(x=>x.name===name); if(!f)return; state.activeDrills ||= []; if(!state.activeDrills.includes(f.id))state.activeDrills.push(f.id); featureFlags[f.id]=true; save(); if(currentView==='grind')renderGrind(hubRoot.querySelector('#khMain')); toast(`Queued ${name}`); }
    function logDrillRep(id){ state.drillProgress ||= {}; state.drillProgress[id]=(state.drillProgress[id]||0)+1; state.reps++; state.xp+=2; save(); renderGrind(hubRoot.querySelector('#khMain')); refreshChrome(); }
    function removeDrill(id){ state.activeDrills=(state.activeDrills||[]).filter(x=>x!==id); save(); renderGrind(hubRoot.querySelector('#khMain')); }
    function adjustCounter(key,delta){ state[key]=Math.max(0,Number(state[key]||0)+delta); if(key==='wins'&&delta>0){state.matches++;state.streak++;state.bestStreak=Math.max(state.bestStreak,state.streak);state.xp+=20;} if(key==='losses'&&delta>0){state.matches++;state.streak=0;state.xp+=5;} if(key==='kills'&&delta>0)state.xp+=2; if(key==='reps'&&delta>0)state.xp+=1; save(); renderGrind(hubRoot.querySelector('#khMain')); refreshChrome(); }
    function logResult(win){ if(win){state.wins++;state.streak++;state.bestStreak=Math.max(state.bestStreak,state.streak);state.xp+=20;}else{state.losses++;state.streak=0;state.xp+=5;} state.matches++; save(); refreshChrome(); toast(win?'Win logged. +20 XP':'Loss logged. +5 XP'); if(currentView==='arena')renderArena(hubRoot.querySelector('#khMain')); }
    function toggleSession(){ if(state.sessionRunning){state.sessionPausedAt=Date.now();state.sessionRunning=false;}else{state.sessionPausedTotal+=Date.now()-(state.sessionPausedAt||Date.now());state.sessionPausedAt=0;state.sessionRunning=true;} save(); renderGrind(hubRoot.querySelector('#khMain')); }
    function resetSession(){ if(!confirm('Save this session to history and start a new one?'))return; state.sessionHistory ||= []; state.sessionHistory.unshift({at:Date.now(),duration:sessionElapsed(),wins:state.wins,losses:state.losses,kills:state.kills,deaths:state.deaths,reps:state.reps}); state.sessionHistory=state.sessionHistory.slice(0,50); Object.assign(state,{sessionStartedAt:Date.now(),sessionPausedAt:0,sessionPausedTotal:0,sessionRunning:true,kills:0,deaths:0,wins:0,losses:0,matches:0,reps:0,streak:0}); save(); renderGrind(hubRoot.querySelector('#khMain')); refreshChrome(); }
    function claimGoalXp(){ const complete=state.matches>=state.goalMatches && state.wins>=state.goalWins && state.reps>=state.goalReps; if(!complete)return toast('Finish all three daily goals first.'); addXp(250,'daily grind complete'); }

    function renderStats(main){
        const kd=state.deaths?(state.kills/state.deaths).toFixed(2):state.kills.toFixed(2); const wr=state.matches?Math.round(100*state.wins/state.matches):0; const history=state.sessionHistory||[];
        main.innerHTML=panel('STATS & ANALYTICS','Local grind analytics that do not touch your persistent server account.',`<div class="kh-grid"><div class="kh-box kh-span-3"><h3>K/D</h3><div class="kh-grind-timer">${kd}</div></div><div class="kh-box kh-span-3"><h3>WIN RATE</h3><div class="kh-grind-timer">${wr}%</div></div><div class="kh-box kh-span-3"><h3>BEST STREAK</h3><div class="kh-grind-timer">${state.bestStreak}</div></div><div class="kh-box kh-span-3"><h3>XP</h3><div class="kh-grind-timer">${state.xp}</div></div><div class="kh-box kh-span-8"><h3>RECENT SESSIONS</h3><div class="kh-drill-list">${history.length?history.slice(0,12).map(s=>`<div class="kh-drill"><div><b>${new Date(s.at).toLocaleString()}</b><br><small>${fmtTime(s.duration)} · ${s.wins}W ${s.losses}L · ${s.kills}K ${s.deaths}D · ${s.reps} reps</small></div><span class="kh-pill">${s.wins+s.losses?Math.round(100*s.wins/(s.wins+s.losses)):0}%</span><span></span></div>`).join(''):'<p>No completed sessions yet.</p>'}</div></div><div class="kh-box kh-span-4"><h3>DATA</h3><button class="kh-btn wide" id="khExport">EXPORT HUB DATA</button><button class="kh-btn wide" id="khImport" style="margin-top:7px">IMPORT HUB DATA</button><button class="kh-btn red wide" id="khClearStats" style="margin-top:7px">CLEAR LOCAL HUB STATS</button><p style="margin-top:8px">This affects only V22 local grind data, not your real account, DMs, roles or Redis data.</p></div></div>`);
        main.querySelector('#khExport').onclick=exportHubData; main.querySelector('#khImport').onclick=importHubData; main.querySelector('#khClearStats').onclick=()=>{if(confirm('Clear only local V22 grind stats?')){Object.assign(state,{kills:0,deaths:0,wins:0,losses:0,matches:0,reps:0,streak:0,bestStreak:0,xp:0,sessionHistory:[],drillProgress:{}});save();renderStats(main);refreshChrome();}};
    }
    function exportHubData(){ const blob=new Blob([JSON.stringify({version:HUB_VERSION,state,featureFlags},null,2)],{type:'application/json'}); const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='kart-hub-v22-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
    function importHubData(){ const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.onchange=()=>{const f=input.files?.[0];if(!f)return;const r=new FileReader();r.onload=()=>{try{const v=JSON.parse(r.result);if(v.state)state=Object.assign({},defaults,v.state);if(v.featureFlags)featureFlags=v.featureFlags;save();applyVisualSettings();showView('stats');toast('Hub backup imported.');}catch{toast('That backup could not be read.');}};r.readAsText(f);};input.click(); }

    function renderCoach(main){
        main.innerHTML=panel('COACH MODE','Opt-in screen sharing, manual tracking and beta death-screen recognition.',`<div class="kh-grid"><div class="kh-box kh-span-8"><h3>SCREEN</h3><video id="khCoachVideo" class="kh-screen-video" autoplay muted playsinline></video><div style="display:flex;gap:7px;margin-top:8px;flex-wrap:wrap"><button class="kh-btn green" id="khShare">START SCREEN SHARE</button><button class="kh-btn red" id="khStopShare">STOP</button><button class="kh-btn yellow" id="khCaptureDeath">CAPTURE DEATH REFERENCE</button><button class="kh-btn" id="khDetector">${state.deathDetectorEnabled?'STOP':'START'} DETECTOR</button></div></div><div class="kh-box kh-span-4"><h3>COACH COUNTERS</h3>${counterHTML('deaths','Deaths',state.deaths)}${counterHTML('kills','Kills',state.kills)}<label class="kh-label">Death similarity tolerance: <span id="khThresholdValue">${state.deathThreshold}</span></label><input class="kh-range" id="khThreshold" type="range" min="5" max="50" value="${state.deathThreshold}"><label class="kh-label">Coach note</label><textarea class="kh-textarea" id="khCoachTip">${esc(state.coachTip)}</textarea><p>Detector checks only the shared video locally in your browser. Nothing is silently captured.</p></div></div>`);
        main.querySelector('#khShare').onclick=startScreenShare; main.querySelector('#khStopShare').onclick=stopScreenShare; main.querySelector('#khCaptureDeath').onclick=captureDeathReference; main.querySelector('#khDetector').onclick=toggleDeathDetector; main.querySelector('#khThreshold').oninput=e=>{state.deathThreshold=Number(e.target.value);main.querySelector('#khThresholdValue').textContent=state.deathThreshold;save();}; main.querySelector('#khCoachTip').oninput=e=>{state.coachTip=e.target.value;save();}; main.querySelectorAll('[data-counter]').forEach(b=>b.onclick=()=>{adjustCounter(b.dataset.counter,Number(b.dataset.delta));renderCoach(main);}); attachStreamToVideo();
    }
    async function startScreenShare(){ try{ screenStream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:15},audio:false}); const track=screenStream.getVideoTracks()[0];track.addEventListener('ended',()=>{screenStream=null;stopDeathDetector();});attachStreamToVideo();toast('Screen sharing started.'); }catch(e){toast('Screen share was cancelled or unavailable.');} }
    function stopScreenShare(){ if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null;} stopDeathDetector();attachStreamToVideo();toast('Screen sharing stopped.'); }
    function attachStreamToVideo(){ const v=document.getElementById('khCoachVideo')||document.getElementById('khStreamVideo'); if(v)v.srcObject=screenStream; }
    function frameVector(){ const v=document.getElementById('khCoachVideo')||document.getElementById('khStreamVideo'); if(!v||!screenStream||v.readyState<2)return null; const c=document.createElement('canvas');c.width=64;c.height=36;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(v,0,0,c.width,c.height);const d=ctx.getImageData(0,0,c.width,c.height).data;const out=[];for(let i=0;i<d.length;i+=4)out.push(Math.round((d[i]+d[i+1]+d[i+2])/3));return out; }
    function captureDeathReference(){ const vec=frameVector();if(!vec)return toast('Start screen share and show a real death screen first.');writeJSON(DEATH_REF_KEY,vec);toast('Death reference captured.'); }
    function toggleDeathDetector(){ if(state.deathDetectorEnabled)stopDeathDetector();else startDeathDetector(); if(currentView==='coach')renderCoach(hubRoot.querySelector('#khMain')); }
    function startDeathDetector(){ if(!screenStream)return toast('Start screen share first.'); if(!readJSON(DEATH_REF_KEY,null))return toast('Capture a death reference first.'); state.deathDetectorEnabled=true;save();clearInterval(deathDetectorTimer);deathDetectorTimer=setInterval(checkDeathFrame,650);toast('Death detector started.'); }
    function stopDeathDetector(){ state.deathDetectorEnabled=false;save();clearInterval(deathDetectorTimer);deathDetectorTimer=null;deathDetectorHits=0; }
    function checkDeathFrame(){ if(Date.now()<deathDetectorCooldownUntil)return;const ref=readJSON(DEATH_REF_KEY,null),cur=frameVector();if(!ref||!cur||ref.length!==cur.length)return;let diff=0;for(let i=0;i<ref.length;i++)diff+=Math.abs(ref[i]-cur[i]);diff/=ref.length;if(diff<=state.deathThreshold)deathDetectorHits++;else deathDetectorHits=0;if(deathDetectorHits>=3){state.deaths++;state.xp+=1;save();refreshChrome();deathDetectorHits=0;deathDetectorCooldownUntil=Date.now()+4500;toast('Death detected +1');if(currentView==='coach')renderCoach(hubRoot.querySelector('#khMain'));}}

    function renderStream(main){ main.innerHTML=panel('STREAMER DESK','Use the same opt-in share feed for private coaching, overlays and stream prep.',`<div class="kh-grid"><div class="kh-box kh-span-8"><h3>SHARED GAME PREVIEW</h3><video id="khStreamVideo" class="kh-screen-video" autoplay muted playsinline></video><div style="display:flex;gap:7px;margin-top:8px"><button class="kh-btn green" id="khStreamShare">SHARE GAME</button><button class="kh-btn red" id="khStreamStop">STOP</button></div></div><div class="kh-box kh-span-4"><h3>STREAM TOOLS</h3>${featureToggleLine('eco:Streamer:Quick Toggle','Streamer mode')}${featureToggleLine('eco:Streamer:Smart Reminder','Private room-code reminder')}${featureToggleLine('eco:Streamer:Preset','Public stats overlay preset')}${featureToggleLine('eco:Streamer:Compact Mode','Compact overlay')}${featureToggleLine('eco:Streamer:History','Highlight history')}${featureToggleLine('eco:Streamer:Favorite','Favorite stream setup')}<p style="margin-top:10px">This hub does not secretly broadcast the screen. Sharing always uses the browser permission prompt.</p></div></div>`); main.querySelector('#khStreamShare').onclick=startScreenShare;main.querySelector('#khStreamStop').onclick=stopScreenShare;main.querySelectorAll('[data-feature-toggle]').forEach(bindFeatureButton);attachStreamToVideo(); }

    function renderSocial(main){ main.innerHTML=panel('SOCIAL','Fast access to the stable friends, DMs, groups and presence systems.',`<div class="kh-grid"><div class="kh-box kh-span-6"><h3>FRIENDS & MESSAGES</h3><button class="kh-btn yellow wide" id="khMessages">OPEN MESSAGES</button><button class="kh-btn wide" id="khOnline" style="margin-top:7px">ONLINE PLAYERS</button><button class="kh-btn wide" id="khProfile" style="margin-top:7px">MY PROFILE</button></div><div class="kh-box kh-span-6"><h3>SOCIAL GRIND</h3><p>Use your existing account/friend data. V22 does not replace or reset it.</p>${featureToggleLine('eco:Social:Quick Toggle','LFG quick toggle')}${featureToggleLine('eco:Social:Smart Reminder','Friend-online reminder')}${featureToggleLine('eco:Social:Preset','Party preset')}${featureToggleLine('eco:Social:Compact Mode','Compact DMs')}${featureToggleLine('eco:Social:History','Recent teammates')}${featureToggleLine('eco:Social:Favorite','Favorite squad')}</div></div>`); main.querySelector('#khMessages').onclick=()=>{hideHub();try{window.showMessagesTab?.();}catch{}};main.querySelector('#khOnline').onclick=()=>{hideHub();try{window.openOnlineModal?.();}catch{}};main.querySelector('#khProfile').onclick=()=>{hideHub();try{window.openMyProfile?.();}catch{}};main.querySelectorAll('[data-feature-toggle]').forEach(bindFeatureButton); }
    function renderTourney(main){ main.innerHTML=panel('TOURNAMENT CENTER','Launch the existing tournament system from a dedicated hub area.',`<div class="kh-grid"><div class="kh-box kh-span-8"><h3>TOURNAMENT ACCESS</h3><button class="kh-btn yellow" id="khOpenTourney">OPEN TOURNAMENTS</button><p style="margin-top:8px">Existing public/private visibility, hosts, regions, schedules and tournament data stay on the stable server.</p></div><div class="kh-box kh-span-4"><h3>TOURNAMENT GRIND</h3>${featureToggleLine('eco:Tournament:Quick Toggle','Tournament focus')}${featureToggleLine('eco:Tournament:Smart Reminder','Check-in reminder')}${featureToggleLine('eco:Tournament:Preset','Tournament warmup preset')}${featureToggleLine('eco:Tournament:Compact Mode','Compact bracket view')}${featureToggleLine('eco:Tournament:History','Event history')}${featureToggleLine('eco:Tournament:Favorite','Favorite event')}</div></div>`); main.querySelector('#khOpenTourney').onclick=()=>{hideHub();try{window.openTournamentPage?.();window.openTournaments?.();}catch{}};main.querySelectorAll('[data-feature-toggle]').forEach(bindFeatureButton); }

    function renderFeatures(main){ const cats=['all',...new Set(featureCatalog.map(f=>f.category))]; const q=String(state.featureSearch||'').toLowerCase(); const filtered=featureCatalog.filter(f=>(state.featureCategory==='all'||f.category===state.featureCategory)&&(!q||f.name.toLowerCase().includes(q)||f.category.toLowerCase().includes(q))); main.innerHTML=panel('FEATURE VAULT',`${featureCatalog.length} individual drill presets, analytics views, matchmaking preferences and hub utilities.`,`<div class="kh-feature-tools"><input class="kh-input" id="khFeatureSearch" value="${esc(state.featureSearch)}" placeholder="Search ${featureCatalog.length} features"><select class="kh-select" id="khFeatureCategory">${cats.map(c=>`<option value="${esc(c)}" ${c===state.featureCategory?'selected':''}>${esc(c)}</option>`).join('')}</select><button class="kh-btn yellow" id="khEnableVisible">ENABLE VISIBLE</button></div><div class="kh-feature-list">${filtered.map(featureCard).join('')}</div><div class="kh-status-row" style="justify-content:flex-start;margin-top:10px"><span class="kh-pill">${filtered.length} shown</span><span class="kh-pill green">${Object.values(featureFlags).filter(Boolean).length} enabled</span><span class="kh-pill yellow">${featureCatalog.length} total</span></div>`); main.querySelector('#khFeatureSearch').oninput=e=>{state.featureSearch=e.target.value;save();renderFeatures(main);}; main.querySelector('#khFeatureCategory').onchange=e=>{state.featureCategory=e.target.value;save();renderFeatures(main);}; main.querySelector('#khEnableVisible').onclick=()=>{filtered.forEach(f=>featureFlags[f.id]=true);save();renderFeatures(main);}; main.querySelectorAll('[data-feature-toggle]').forEach(bindFeatureButton); }
    function featureCard(f){ return `<div class="kh-feature"><div><b>${esc(f.name)}</b><small>${esc(f.category)} · ${esc(f.desc)}</small></div><button class="kh-toggle ${featureFlags[f.id]?'on':''}" data-feature-toggle="${esc(f.id)}" aria-label="Toggle"></button></div>`; }
    function featureToggleLine(id,label){ return `<div class="kh-counter"><span>${esc(label)}</span><button class="kh-toggle ${featureFlags[id]?'on':''}" data-feature-toggle="${esc(id)}"></button></div>`; }
    function bindFeatureButton(btn){ btn.onclick=()=>{const id=btn.dataset.featureToggle;featureFlags[id]=!featureFlags[id];if(id.startsWith('drill:')&&featureFlags[id]){state.activeDrills ||= [];if(!state.activeDrills.includes(id))state.activeDrills.push(id);}save();btn.classList.toggle('on',!!featureFlags[id]);}; }

    function renderSettings(main){ main.innerHTML=panel('HUB SETTINGS','Customize launcher behavior and exactly how far the in-game top bar drops down.',`<div class="kh-grid"><div class="kh-box kh-span-6"><h3>IN-GAME TOP BAR</h3><label class="kh-label">Toolbar height: <span id="khBarHeightValue">${state.topBarHeight}px</span></label><input class="kh-range" id="khBarHeight" type="range" min="38" max="120" value="${state.topBarHeight}"><label class="kh-label">Drop from top: <span id="khBarDropValue">${state.topBarDrop}px</span></label><input class="kh-range" id="khBarDrop" type="range" min="0" max="220" value="${state.topBarDrop}"><div style="margin-top:8px">${settingToggle('compactBar','Compact toolbar')} ${settingToggle('focusMode','Launcher focus mode')}</div></div><div class="kh-box kh-span-6"><h3>ACCESSIBILITY / VISUALS</h3>${settingToggle('highContrast','High contrast')}${settingToggle('largeText','Larger hub text')}${settingToggle('reducedMotion','Reduce motion')}<button class="kh-btn red wide" id="khResetPrefs" style="margin-top:8px">RESET HUB PREFERENCES</button></div><div class="kh-box kh-span-12"><h3>KEYBOARD</h3><div class="kh-status-row" style="justify-content:flex-start"><span class="kh-pill">Ctrl+K · Commands</span><span class="kh-pill">H · Hub</span><span class="kh-pill">G · Grind Lab</span><span class="kh-pill">1 · 1v1 Arena</span><span class="kh-pill">Esc · Close command palette</span></div></div></div>`); const h=main.querySelector('#khBarHeight'),d=main.querySelector('#khBarDrop'); h.oninput=e=>{state.topBarHeight=Number(e.target.value);main.querySelector('#khBarHeightValue').textContent=state.topBarHeight+'px';applyVisualSettings();save();};d.oninput=e=>{state.topBarDrop=Number(e.target.value);main.querySelector('#khBarDropValue').textContent=state.topBarDrop+'px';applyVisualSettings();save();}; main.querySelectorAll('[data-setting]').forEach(b=>b.onchange=()=>{state[b.dataset.setting]=b.checked;applyVisualSettings();save();}); main.querySelector('#khResetPrefs').onclick=()=>{if(confirm('Reset only V22 hub preferences?')){const keep={xp:state.xp,wins:state.wins,losses:state.losses,kills:state.kills,deaths:state.deaths,matches:state.matches,reps:state.reps,sessionHistory:state.sessionHistory,drillProgress:state.drillProgress};state=Object.assign({},defaults,keep,{sessionStartedAt:Date.now()});featureFlags={};save();applyVisualSettings();renderSettings(main);refreshChrome();}}; }
    function settingToggle(key,label){ return `<label class="kh-counter"><span>${esc(label)}</span><input type="checkbox" data-setting="${key}" ${state[key]?'checked':''}></label>`; }
    function applyVisualSettings(){ const root=document.documentElement;root.style.setProperty('--kh-gamebar-height',`${clamp(state.topBarHeight,38,120)}px`);root.style.setProperty('--kh-gamebar-drop',`${clamp(state.topBarDrop,0,220)}px`);document.body.classList.toggle('kh-compact',!!state.compactBar);document.body.classList.toggle('kh-focus',!!state.focusMode);document.body.classList.toggle('kh-high-contrast',!!state.highContrast);document.body.classList.toggle('kh-large-text',!!state.largeText);document.body.classList.toggle('kh-reduce-motion',!!state.reducedMotion);const gs=document.getElementById('gameScreen');if(gs)gs.style.setProperty('--menu-height',`${clamp(state.topBarHeight,38,120)+clamp(state.topBarDrop,0,220)}px`); }

    function playSK(){ state.launches++; state.xp+=3; save();refreshChrome();window.open('https://smashkarts.io','_blank','noopener'); }
    function openCreate(){ hideHub(); try{ if(typeof window.openFfaPage==='function')window.openFfaPage(); else if(typeof window.switchMatchMode==='function')window.switchMatchMode('1v1'); }catch{} }
    function openJoin(){ hideHub(); try{ if(typeof window.openFindGameModal==='function')window.openFindGameModal(); else if(typeof openFindGameModal==='function')openFindGameModal(); }catch{} }

    function createHubReturnButton(){ if(document.getElementById('khHubButton'))return;const b=document.createElement('button');b.id='khHubButton';b.textContent='⌂ HUB';b.onclick=showHub;document.body.appendChild(b); }
    function createCommandPalette(){ if(document.getElementById('khCommand'))return;const wrap=document.createElement('div');wrap.id='khCommand';wrap.className='kh-command hidden';wrap.innerHTML=`<div class="kh-command-card"><input id="khCommandInput" class="kh-input" placeholder="Search commands…"><div id="khCommandResults" class="kh-command-results"></div></div>`;document.body.appendChild(wrap);wrap.addEventListener('click',e=>{if(e.target===wrap)closeCommand();});wrap.querySelector('#khCommandInput').addEventListener('input',renderCommands); }
    const commands=[['Home',()=>showView('home')],['1v1 Arena',()=>showView('arena')],['Grind Lab',()=>showView('grind')],['Stats',()=>showView('stats')],['Coach Mode',()=>showView('coach')],['Streamer Desk',()=>showView('stream')],['Social',()=>showView('social')],['Tournaments',()=>showView('tourney')],['Feature Vault',()=>showView('features')],['Settings',()=>showView('settings')],['Play Smash Karts',playSK],['Create Lobby',openCreate],['Find / Join Game',openJoin],['Cancel Queue',cancelQueue],['Start Casual 1v1',()=>join1v1('casual')],['Start Ranked 1v1',()=>join1v1('ranked')]];
    function openCommand(){ createCommandPalette();const el=document.getElementById('khCommand');el.classList.remove('hidden');const input=document.getElementById('khCommandInput');input.value='';renderCommands();setTimeout(()=>input.focus(),0); }
    function closeCommand(){document.getElementById('khCommand')?.classList.add('hidden');}
    function renderCommands(){const input=document.getElementById('khCommandInput');const host=document.getElementById('khCommandResults');if(!host)return;const q=(input?.value||'').toLowerCase();const rows=commands.filter(([n])=>n.toLowerCase().includes(q)).slice(0,20);host.innerHTML='';rows.forEach(([name,fn])=>{const r=document.createElement('div');r.className='kh-command-item';r.innerHTML=`<b>${esc(name)}</b><span>↵</span>`;r.onclick=()=>{closeCommand();fn();};host.appendChild(r);});}

    socket.on?.('matchmaking_counts',data=>{latestQueueCounts=data?.queues||{};if(currentView==='arena'&&!hubRoot?.classList.contains('kh-hidden'))renderArena(hubRoot.querySelector('#khMain'));});
    socket.on?.('matchmaking_state',data=>{latestQueueState=data;if(currentView==='arena'&&!hubRoot?.classList.contains('kh-hidden'))renderArena(hubRoot.querySelector('#khMain'));});
    socket.on?.('matchmaking_cancelled',data=>{latestQueueState={state:'cancelled',message:data?.message||'Matchmaking cancelled'};if(currentView==='arena'&&!hubRoot?.classList.contains('kh-hidden'))renderArena(hubRoot.querySelector('#khMain'));});
    socket.on?.('matchmaking_room_ready',data=>{ latestQueueState={state:'room-ready',message:'Room ready'}; if(data?.smashUrl){state.lastRoomCode=data.smashUrl;state.recentRooms=[data.smashUrl,...(state.recentRooms||[]).filter(x=>x!==data.smashUrl)].slice(0,10);save();} hideHub(); });

    document.addEventListener('keydown',e=>{const tag=e.target?.tagName;if(['INPUT','TEXTAREA','SELECT'].includes(tag))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCommand();return;}if(e.key==='Escape'){closeCommand();return;}if(e.key.toLowerCase()==='h')showHub();if(e.key.toLowerCase()==='g')showView('grind');if(e.key==='1')showView('arena');});

    function install(){ createHub(); applyVisualSettings(); if(grindTick)clearInterval(grindTick);grindTick=setInterval(()=>{const c=document.getElementById('khSessionClock');if(c)c.textContent=fmtTime(sessionElapsed());const g=document.getElementById('khGrindClock');if(g)g.textContent=fmtTime(sessionElapsed());},1000); window.kartHub={show:showView,hide:hideHub,open:showHub,playSK,openCreate,openJoin,command:openCommand,featureCount:featureCatalog.length,features:featureCatalog}; console.log(`[KART HUB V${HUB_VERSION}] ${featureCatalog.length} tools loaded`); }
    if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',()=>setTimeout(install,0));else setTimeout(install,0);
})();
