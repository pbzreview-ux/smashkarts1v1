function enterGameFromLobby() {
    if (!activeRoomData || !activeRoomData.smashUrl) {
        showToast("Error: No valid Smash Karts launch room URL found!", "❌");
        return;
    }
    
    closePreGameLobbyModal();

    const user = AuthSession.getUser();
    if (user) {
        socket.emit('record_match_played', user.username);
    }

    // Always open in a popup window since Smash Karts blocks iframes
    window.open(activeRoomData.smashUrl, 'SmashKarts1v1Match', 'width=1100,height=750,resizable=yes,scrollbars=yes');
    
    // Show the chat/overlay helper screen without the broken iframe
    const gameScreen = document.getElementById('gameScreen');
    const smashFrame = document.getElementById('smashFrame');
    smashFrame.src = ''; // Clear iframe to avoid security errors
    gameScreen.classList.remove('hidden');
    document.getElementById('gameModeBadge').innerText = activeRoomData.mode;
}