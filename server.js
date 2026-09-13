// =====================================================
// PLAY FFA SIDEBAR BUTTON
// Goes directly between LEADERBOARD and 1v1
// =====================================================

const ffaButton = document.createElement('button');

ffaButton.id = 'btnNavFFA';
ffaButton.type = 'button';
ffaButton.title = 'Play FFA';
ffaButton.textContent = '🔥';

ffaButton.className =
    'sidebar-btn w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg';

// Find the existing sidebar buttons.
const leaderboardButton =
    document.getElementById('btnNavLeaderboard');

const oneVOneButton =
    document.getElementById('btnNav1v1');

// Insert FFA immediately BEFORE 1v1.
// Since Leaderboard is directly before 1v1,
// this puts FFA exactly between them.
if (
    oneVOneButton &&
    oneVOneButton.parentElement &&
    !document.getElementById('btnNavFFA')
) {
    oneVOneButton.parentElement.insertBefore(
        ffaButton,
        oneVOneButton
    );
}

let ffaWaitTimer = null;

function finishFFARequest() {
    clearTimeout(ffaWaitTimer);

    ffaButton.disabled = false;
    ffaButton.textContent = '🔥';
    ffaButton.title = 'Play FFA';
}

ffaButton.onclick = function () {

    if (!AuthSession.getUser()) {

        const authModal =
            document.getElementById('authModal');

        if (authModal) {
            authModal.classList.remove('hidden');
        }

        return;
    }

    if (!socket.connected) {

        showToast(
            'Connecting to the lobby. Try again in a moment.',
            'ℹ️'
        );

        return;
    }

    if (ffaButton.disabled) {
        return;
    }

    // Remove active highlight from every sidebar button.
    document
        .querySelectorAll('.sidebar-btn')
        .forEach(button => {
            button.classList.remove('active');
        });

    // Highlight FFA.
    ffaButton.classList.add('active');

    ffaButton.disabled = true;
    ffaButton.textContent = '⏳';
    ffaButton.title = 'Joining FFA...';

    socket.emit('play_ffa');

    ffaWaitTimer = setTimeout(() => {

        finishFFARequest();

        showToast(
            'The FFA lobby did not respond. Please try again.',
            'ℹ️'
        );

    }, 8000);
};

socket.on(
    'room_error',
    finishFFARequest
);

socket.on(
    'disconnect',
    finishFFARequest
);