const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Only expose website assets, never saved messages or server source.
app.get('/script.js', (req, res) => {
    const filename = ['script.js', 'script(1).js'].find(name =>
        fs.existsSync(path.join(__dirname, name))
    );

    if (!filename) {
        return res.status(404).send('Missing script.js');
    }

    res.type('application/javascript').send(
        fs.readFileSync(path.join(__dirname, filename), 'utf8') +
        '\n;(' + installSavedHistory.toString() + ')();'
    );
});

app.use((req, res, next) => {
    if (/^\/data(?:\/|$)/i.test(req.path)) {
        return res.sendStatus(404);
    }

    if (
        req.path === '/' ||
        /\.(html|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|mp3|mp4)$/i.test(req.path)
    ) {
        return next();
    }

    res.sendStatus(404);
});

app.use(express.static(__dirname));

const connectedPlayers = {};
const activeRoomsMap = new Map();

const dataDirectory = path.resolve(
    process.env.SMASH_DATA_DIR ||
    path.join(__dirname, 'data')
);

fs.mkdirSync(
    dataDirectory,
    { recursive: true }
);

const dataFile = path.join(
    dataDirectory,
    'history.json'
);

const saved = fs.existsSync(dataFile)
    ? JSON.parse(
        fs.readFileSync(
            dataFile,
            'utf8'
        )
    )
    : {
        profiles: {},
        stats: {},
        directMessages: {},
        matches: {}
    };

// Stop on invalid data instead of silently overwriting existing history.
if (
    !saved.profiles ||
    !saved.stats ||
    !saved.directMessages ||
    !saved.matches
) {
    throw new Error(
        'Invalid history.json. Restore your backup before restarting.'
    );
}

const profiles = Object.assign(
    Object.create(null),
    saved.profiles
);

const playerStats = Object.assign(
    Object.create(null),
    saved.stats
);

const directMessageStore = Object.assign(
    Object.create(null),
    saved.directMessages
);

const matchHistory = Object.assign(
    Object.create(null),
    saved.matches
);

function saveHistory() {
    const temporary =
        dataFile + '.tmp';

    const fd = fs.openSync(
        temporary,
        'w',
        0o600
    );

    try {
        fs.writeFileSync(
            fd,
            JSON.stringify({
                profiles,
                stats: playerStats,
                directMessages: directMessageStore,
                matches: matchHistory
            })
        );

        fs.fsyncSync(fd);

    } finally {
        fs.closeSync(fd);
    }

    fs.renameSync(
        temporary,
        dataFile
    );
}

function profileFor(username) {
    if (!profiles[username]) {
        profiles[username] = {
            friends: [],
            requests: [],
            isOnline: true
        };
    }

    return profiles[username];
}

function savePlayer(player) {
    const profile =
        profileFor(
            player.username
        );

    profile.friends =
        Array.from(
            player.friends
        );

    profile.requests =
        Array.from(
            player.friendRequests
        );

    profile.isOnline =
        player.isOnline;
}

function syncFriends(username) {
    const profile =
        profileFor(username);

    for (
        const player of
        Object.values(
            connectedPlayers
        )
    ) {
        if (
            player.username !== username ||
            !player.isAuthenticated
        ) {
            continue;
        }

        player.friends =
            new Set(
                profile.friends
            );

        player.friendRequests =
            new Set(
                profile.requests
            );

        io.to(
            player.id
        ).emit(
            'saved_friends',
            {
                friends:
                    profile.friends,

                requests:
                    profile.requests
            }
        );
    }
}

function escapeHTML(str) {
    if (!str) {
        return '';
    }

    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeUsername(name) {
    if (
        !name ||
        typeof name !== 'string'
    ) {
        return 'Player';
    }

    const trimmed =
        name.trim();

    if (
        !trimmed ||
        trimmed.toLowerCase() === 'undefined' ||
        trimmed.toLowerCase() === 'null'
    ) {
        return 'Player';
    }

    return escapeHTML(
        trimmed.slice(
            0,
            20
        )
    );
}

function extractSmashUrl(rawInput) {
    if (!rawInput) {
        return null;
    }

    let text =
        String(
            rawInput
        ).trim();

    if (
        text.includes(
            'ttps://'
        )
    ) {
        text =
            text.replace(
                /^ttps:\/\//i,
                'https://'
            );
    }

    const linkMatch =
        text.match(
            /https?:\/\/(www\.)?smashkarts\.io\/link\/\?[^\s]+/i
        );

    if (linkMatch) {
        return linkMatch[0];
    }

    const roomMatch =
        text.match(
            /Room:\s*([A-Za-z0-9]+)/i
        );

    if (roomMatch) {
        return (
            'https://smashkarts.io/link/?room=' +
            encodeURIComponent(
                roomMatch[1]
            )
        );
    }

    if (
        text.length > 0 &&
        !text.includes(' ') &&
        !text.includes('\n') &&
        !text.includes('/')
    ) {
        return (
            'https://smashkarts.io/link/?room=' +
            encodeURIComponent(
                text
            )
        );
    }

    return null;
}

function moderateText(text) {
    if (!text) {
        return '';
    }

    const BANNED_WORDS = [
        'badword1',
        'badword2',
        'hate',
        'spam'
    ];

    let cleanText =
        String(text);

    BANNED_WORDS.forEach(
        word => {

            const regex =
                new RegExp(
                    `\\b${word}\\b`,
                    'gi'
                );

            cleanText =
                cleanText.replace(
                    regex,
                    '***'
                );
        }
    );

    return cleanText;
}

function getDMKey(
    u1,
    u2
) {
    return JSON.stringify(
        [
            u1,
            u2
        ].sort()
    );
}

function findSocketByUsername(username) {
    return Object.values(
        connectedPlayers
    ).find(
        p =>
            p.username
                .toLowerCase() ===
            username
                .toLowerCase()
    );
}

function broadcastPublicRooms() {
    const roomsList =
        Array.from(
            activeRoomsMap.values()
        ).map(
            ({
                roomId,
                hostName,
                winCondition,
                mode,
                maxPlayers,
                players
            }) => ({
                roomId,
                hostName,
                winCondition,
                mode,
                maxPlayers,
                players
            })
        );

    io.emit(
        'public_rooms_update',
        roomsList
    );
}


// =========================================================
// DELETE EVERY LOBBY AT ZERO PLAYERS
// =========================================================

function leaveLiveRoom(
    socket,
    roomId
) {
    const room =
        activeRoomsMap.get(
            roomId
        );

    if (
        !room ||
        !room.players.some(
            p =>
                p.id ===
                socket.id
        )
    ) {
        return;
    }

    socket.leave(
        roomId
    );

    room.players =
        room.players.filter(
            p =>
                p.id !==
                socket.id
        );

    // Every live/public lobby disappears instantly at zero players.
    // Saved history remains.
    if (
        room.players.length ===
        0
    ) {
        activeRoomsMap.delete(
            roomId
        );

        broadcastPublicRooms();

        return;
    }

    io.to(
        roomId
    ).emit(
        'saved_room_update',
        room
    );

    broadcastPublicRooms();
}


// =========================================================
// SOCKET CONNECTION
// =========================================================

io.on(
    'connection',
    socket => {

        connectedPlayers[
            socket.id
        ] = {
            id:
                socket.id,

            username:
                'Guest',

            email:
                null,

            isAuthenticated:
                false,

            isOnline:
                true,

            friends:
                new Set(),

            friendRequests:
                new Set()
        };


        // =================================================
        // USER SESSION
        // =================================================

        socket.on(
            'set_user_session',
            userData => {

                if (
                    !userData ||
                    !userData.username
                ) {
                    return;
                }

                const uname =
                    sanitizeUsername(
                        userData.username
                    );

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                if (player) {
                    player.username =
                        uname;

                    player.email =
                        userData.email ||
                        null;

                    player.isAuthenticated =
                        true;

                    const profile =
                        profileFor(
                            uname
                        );

                    player.friends =
                        new Set(
                            profile.friends
                        );

                    player.friendRequests =
                        new Set(
                            profile.requests
                        );

                    player.isOnline =
                        profile.isOnline;

                    socket.emit(
                        'saved_friends',
                        {
                            friends:
                                profile.friends,

                            requests:
                                profile.requests
                        }
                    );

                    socket.emit(
                        'friend_requests_update',
                        Array.from(
                            player.friendRequests
                        )
                    );
                }

                if (
                    !playerStats[
                        uname
                    ]
                ) {
                    playerStats[
                        uname
                    ] = 0;
                }

                saveHistory();

                broadcastOnlineUsers();

                broadcastLeaderboard();
            }
        );


        // =================================================
        // ONLINE STATUS
        // =================================================

        socket.on(
            'toggle_online_status',
            isOnline => {

                if (
                    connectedPlayers[
                        socket.id
                    ]
                ) {
                    connectedPlayers[
                        socket.id
                    ].isOnline =
                        !!isOnline;

                    savePlayer(
                        connectedPlayers[
                            socket.id
                        ]
                    );

                    saveHistory();

                    broadcastOnlineUsers();
                }
            }
        );


        // =================================================
        // FRIEND REQUEST
        // =================================================

        socket.on(
            'send_friend_request',
            ({
                targetSocketId
            }) => {

                const sender =
                    connectedPlayers[
                        socket.id
                    ];

                const target =
                    connectedPlayers[
                        targetSocketId
                    ];

                if (
                    sender &&
                    target &&
                    sender.isAuthenticated &&
                    target.isAuthenticated
                ) {
                    if (
                        sender.username ===
                            target.username ||
                        sender.friends.has(
                            target.username
                        )
                    ) {
                        return;
                    }

                    target.friendRequests.add(
                        sender.username
                    );

                    savePlayer(
                        target
                    );

                    saveHistory();

                    syncFriends(
                        target.username
                    );

                    io.to(
                        targetSocketId
                    ).emit(
                        'receive_friend_request',
                        {
                            fromSocketId:
                                socket.id,

                            fromUsername:
                                sender.username
                        }
                    );

                    io.to(
                        targetSocketId
                    ).emit(
                        'friend_requests_update',
                        Array.from(
                            target.friendRequests
                        )
                    );
                }
            }
        );


        socket.on(
            'decline_friend_request',
            ({
                challengerUsername
            }) => {

                const user =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !user ||
                    !user.isAuthenticated
                ) {
                    return;
                }

                user.friendRequests.delete(
                    challengerUsername
                );

                savePlayer(
                    user
                );

                saveHistory();

                syncFriends(
                    user.username
                );

                socket.emit(
                    'friend_requests_update',
                    Array.from(
                        user.friendRequests
                    )
                );
            }
        );


        socket.on(
            'accept_friend_request',
            ({
                challengerUsername
            }) => {

                const user =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !user ||
                    !user.isAuthenticated
                ) {
                    return;
                }

                if (
                    !user.friendRequests.has(
                        challengerUsername
                    )
                ) {
                    return;
                }

                user.friends.add(
                    challengerUsername
                );

                user.friendRequests.delete(
                    challengerUsername
                );

                const otherProfile =
                    profileFor(
                        challengerUsername
                    );

                if (
                    !otherProfile.friends.includes(
                        user.username
                    )
                ) {
                    otherProfile.friends.push(
                        user.username
                    );
                }

                otherProfile.requests =
                    otherProfile.requests.filter(
                        name =>
                            name !==
                            user.username
                    );

                savePlayer(
                    user
                );

                saveHistory();

                syncFriends(
                    user.username
                );

                syncFriends(
                    challengerUsername
                );

                const challenger =
                    findSocketByUsername(
                        challengerUsername
                    );

                if (
                    challenger
                ) {
                    challenger.friends.add(
                        user.username
                    );

                    io.to(
                        challenger.id
                    ).emit(
                        'friend_request_accepted',
                        {
                            username:
                                user.username
                        }
                    );
                }

                socket.emit(
                    'friend_requests_update',
                    Array.from(
                        user.friendRequests
                    )
                );

                socket.emit(
                    'friend_request_accepted',
                    {
                        username:
                            challengerUsername
                    }
                );

                broadcastOnlineUsers();
            }
        );


        // =================================================
        // DIRECT MESSAGES
        // =================================================

        socket.on(
            'send_direct_message',
            ({
                targetUsername,
                message
            }) => {

                const sender =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !sender ||
                    !sender.isAuthenticated ||
                    !message ||
                    !message.trim()
                ) {
                    return;
                }

                const cleanTarget =
                    sanitizeUsername(
                        targetUsername
                    );

                const targetPlayer =
                    findSocketByUsername(
                        cleanTarget
                    );

                if (
                    !sender.friends.has(
                        cleanTarget
                    )
                ) {
                    return socket.emit(
                        'dm_error',
                        {
                            message:
                                'You can only message users on your friends list.'
                        }
                    );
                }

                const cleanMsg =
                    moderateText(
                        message.trim()
                    );

                const dmKey =
                    getDMKey(
                        sender.username,
                        cleanTarget
                    );

                if (
                    !directMessageStore[
                        dmKey
                    ]
                ) {
                    directMessageStore[
                        dmKey
                    ] = [];
                }

                const msgObj = {
                    senderUsername:
                        sender.username,

                    message:
                        cleanMsg,

                    timestamp:
                        Date.now()
                };

                directMessageStore[
                    dmKey
                ].push(
                    msgObj
                );

                saveHistory();

                if (
                    targetPlayer
                ) {
                    io.to(
                        targetPlayer.id
                    ).emit(
                        'receive_direct_message',
                        {
                            senderSocketId:
                                socket.id,

                            senderUsername:
                                sender.username,

                            message:
                                cleanMsg,

                            history:
                                directMessageStore[
                                    dmKey
                                ]
                        }
                    );
                }

                socket.emit(
                    'dm_sent_success',
                    {
                        targetUsername:
                            cleanTarget,

                        history:
                            directMessageStore[
                                dmKey
                            ]
                    }
                );
            }
        );


        socket.on(
            'get_dm_history',
            ({
                targetUsername
            }) => {

                const sender =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !sender ||
                    !sender.isAuthenticated
                ) {
                    return;
                }

                const cleanTarget =
                    sanitizeUsername(
                        targetUsername
                    );

                if (
                    !sender.friends.has(
                        cleanTarget
                    )
                ) {
                    return;
                }

                const dmKey =
                    getDMKey(
                        sender.username,
                        cleanTarget
                    );

                socket.emit(
                    'load_dm_history',
                    {
                        targetUsername:
                            cleanTarget,

                        history:
                            directMessageStore[
                                dmKey
                            ] || []
                    }
                );
            }
        );


        // =================================================
        // STATS
        // =================================================

        socket.on(
            'record_match_played',
            () => {

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !player ||
                    !player.isAuthenticated
                ) {
                    return;
                }

                const uname =
                    player.username;

                if (
                    uname &&
                    uname !==
                        'Player' &&
                    uname !==
                        'Guest'
                ) {
                    playerStats[
                        uname
                    ] =
                        (
                            playerStats[
                                uname
                            ] || 0
                        ) + 1;

                    saveHistory();

                    broadcastLeaderboard();
                }
            }
        );


        // =================================================
        // MATCH CHALLENGES
        // =================================================

        socket.on(
            'send_match_challenge',
            ({
                targetSocketId,
                targetUsername,
                fromUsername,
                mode,
                smashUrl
            }) => {

                const sender =
                    connectedPlayers[
                        socket.id
                    ];

                const target =
                    targetSocketId
                        ? connectedPlayers[
                            targetSocketId
                        ]
                        : findSocketByUsername(
                            targetUsername
                        );

                if (
                    !sender ||
                    !target
                ) {
                    return;
                }

                if (
                    !sender.friends.has(
                        target.username
                    )
                ) {
                    return;
                }

                const cleanUrl =
                    extractSmashUrl(
                        smashUrl
                    );

                if (!cleanUrl) {
                    socket.emit(
                        'room_error',
                        {
                            message:
                                'A valid Smash Karts room link or code is required!'
                        }
                    );

                    return;
                }

                const senderName =
                    sanitizeUsername(
                        fromUsername
                    );

                io.to(
                    target.id
                ).emit(
                    'receive_match_challenge',
                    {
                        challengerSocketId:
                            socket.id,

                        fromUsername:
                            senderName,

                        mode:
                            mode ||
                            '1v1',

                        smashUrl:
                            cleanUrl
                    }
                );
            }
        );


        socket.on(
            'accept_match_challenge',
            ({
                challengerSocketId,
                targetUsername,
                smashUrl
            }) => {

                const cleanUrl =
                    extractSmashUrl(
                        smashUrl
                    );

                if (!cleanUrl) {
                    socket.emit(
                        'room_error',
                        {
                            message:
                                'A valid Smash Karts room link or code is required!'
                        }
                    );

                    return;
                }

                const acceptName =
                    sanitizeUsername(
                        targetUsername
                    );

                const challenger =
                    connectedPlayers[
                        challengerSocketId
                    ];

                const challengerName =
                    challenger
                        ? challenger.username
                        : 'Challenger';

                const roomId =
                    crypto.randomUUID();

                const room = {
                    roomId,

                    hostName:
                        challengerName,

                    smashUrl:
                        cleanUrl,

                    winCondition:
                        'First to 3',

                    mode:
                        '1v1',

                    maxPlayers:
                        2,

                    players: [
                        {
                            id:
                                socket.id,

                            name:
                                acceptName
                        },

                        {
                            id:
                                challengerSocketId,

                            name:
                                challengerName
                        }
                    ],

                    exitedPlayers:
                        [],

                    messages:
                        []
                };

                activeRoomsMap.set(
                    roomId,
                    room
                );

                matchHistory[
                    roomId
                ] = {
                    ...room,

                    createdAt:
                        Date.now(),

                    participants: [
                        ...new Set(
                            room.players.map(
                                p =>
                                    p.name
                            )
                        )
                    ]
                };

                saveHistory();

                socket.join(
                    roomId
                );

                const challengerSocket =
                    io.sockets.sockets.get(
                        challengerSocketId
                    );

                if (
                    challengerSocket
                ) {
                    challengerSocket.join(
                        roomId
                    );
                }

                io.to(
                    roomId
                ).emit(
                    'challenge_game_start',
                    room
                );

                broadcastPublicRooms();
            }
        );


        // =================================================
        // CREATE NORMAL ROOM
        // =================================================

        socket.on(
            'create_room',
            data => {

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !player ||
                    !player.isAuthenticated
                ) {
                    return;
                }

                const cleanUrl =
                    extractSmashUrl(
                        data.smashUrl
                    );

                if (!cleanUrl) {
                    socket.emit(
                        'room_error',
                        {
                            message:
                                'Error: You must provide a valid Smash Karts room link or code to join/create!'
                        }
                    );

                    return;
                }

                for (
                    const oldId of
                    Array.from(
                        activeRoomsMap.keys()
                    )
                ) {
                    leaveLiveRoom(
                        socket,
                        oldId
                    );
                }

                const roomId =
                    crypto.randomUUID();

                const mode =
                    data.mode ===
                    '2v2'
                        ? '2v2'
                        : '1v1';

                const hostName =
                    player.username;

                const newRoom = {
                    roomId,

                    hostName,

                    smashUrl:
                        cleanUrl,

                    winCondition:
                        escapeHTML(
                            data.winCondition ||
                            'First to 3'
                        ),

                    mode,

                    maxPlayers:
                        mode ===
                        '2v2'
                            ? 4
                            : 2,

                    players: [
                        {
                            id:
                                socket.id,

                            name:
                                hostName
                        }
                    ],

                    exitedPlayers:
                        [],

                    messages:
                        []
                };

                activeRoomsMap.set(
                    roomId,
                    newRoom
                );

                matchHistory[
                    roomId
                ] = {
                    ...newRoom,

                    createdAt:
                        Date.now(),

                    participants: [
                        hostName
                    ]
                };

                saveHistory();

                socket.join(
                    roomId
                );

                socket.emit(
                    'room_created',
                    newRoom
                );

                broadcastPublicRooms();
            }
        );


        socket.on(
            'get_public_rooms',
            () => {
                broadcastPublicRooms();
            }
        );


        socket.on(
            'leave_match',
            ({
                roomId
            }) => {

                leaveLiveRoom(
                    socket,
                    roomId
                );

                broadcastPublicRooms();
            }
        );


        // =================================================
        // FFA
        // =================================================

        function joinFFARoom(
            room,
            player
        ) {

            for (
                const oldId of
                Array.from(
                    activeRoomsMap.keys()
                )
            ) {
                if (
                    oldId !==
                    room.roomId
                ) {
                    leaveLiveRoom(
                        socket,
                        oldId
                    );
                }
            }

            if (
                !room.players.some(
                    p =>
                        p.id ===
                        socket.id
                )
            ) {

                if (
                    room.players.length >=
                    room.maxPlayers
                ) {
                    socket.emit(
                        'room_error',
                        {
                            message:
                                'That FFA lobby is full.'
                        }
                    );

                    return false;
                }

                room.players.push({
                    id:
                        socket.id,

                    name:
                        player.username
                });
            }

            if (
                matchHistory[
                    room.roomId
                ] &&
                !matchHistory[
                    room.roomId
                ].participants.includes(
                    player.username
                )
            ) {
                matchHistory[
                    room.roomId
                ].participants.push(
                    player.username
                );
            }

            socket.join(
                room.roomId
            );

            saveHistory();

            socket.emit(
                'ffa_lobby_ready',
                room
            );

            io.to(
                room.roomId
            ).emit(
                'saved_room_update',
                room
            );

            broadcastPublicRooms();

            return true;
        }


        socket.on(
            'play_ffa',
            () => {

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !player ||
                    !player.isAuthenticated
                ) {
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'Please log in before playing FFA.'
                        }
                    );
                }

                const room =
                    Array.from(
                        activeRoomsMap.values()
                    ).find(
                        item =>
                            item.mode ===
                                'ffa' &&
                            item.players.length <
                                item.maxPlayers
                    );

                if (!room) {
                    return socket.emit(
                        'ffa_no_lobby',
                        {
                            message:
                                'No FFA lobby is open yet. Click CREATE LOBBY to make one.'
                        }
                    );
                }

                joinFFARoom(
                    room,
                    player
                );
            }
        );


        socket.on(
            'create_ffa_lobby',
            () => {

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !player ||
                    !player.isAuthenticated
                ) {
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'Please log in before creating an FFA lobby.'
                        }
                    );
                }

                for (
                    const oldId of
                    Array.from(
                        activeRoomsMap.keys()
                    )
                ) {
                    leaveLiveRoom(
                        socket,
                        oldId
                    );
                }

                const roomId =
                    crypto.randomUUID();

                const room = {
                    roomId,

                    hostName:
                        player.username,

                    smashUrl:
                        'https://smashkarts.io',

                    winCondition:
                        'Free for all',

                    mode:
                        'ffa',

                    maxPlayers:
                        1000,

                    players:
                        [],

                    exitedPlayers:
                        [],

                    messages:
                        []
                };

                activeRoomsMap.set(
                    roomId,
                    room
                );

                matchHistory[
                    roomId
                ] = {
                    ...room,

                    createdAt:
                        Date.now(),

                    participants:
                        []
                };

                joinFFARoom(
                    room,
                    player
                );
            }
        );


        // =================================================
        // PASTE CODE TO LOBBY
        // =================================================

        socket.on(
            'update_lobby_game_code',
            ({
                roomId,
                code
            }) => {

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                const room =
                    activeRoomsMap.get(
                        roomId
                    );

                if (
                    !player ||
                    !player.isAuthenticated ||
                    !room
                ) {
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'Lobby not found.'
                        }
                    );
                }

                if (
                    !room.players.some(
                        p =>
                            p.id ===
                            socket.id
                    )
                ) {
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'You must be inside the lobby before changing its game code.'
                        }
                    );
                }

                const cleanUrl =
                    extractSmashUrl(
                        code
                    );

                if (!cleanUrl) {
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'Paste a valid Smash Karts room code or room link.'
                        }
                    );
                }

                room.smashUrl =
                    cleanUrl;

                room.gameCodeUpdatedBy =
                    player.username;

                room.gameCodeUpdatedAt =
                    Date.now();

                if (
                    matchHistory[
                        roomId
                    ]
                ) {
                    matchHistory[
                        roomId
                    ].smashUrl =
                        cleanUrl;

                    matchHistory[
                        roomId
                    ].gameCodeUpdatedBy =
                        player.username;

                    matchHistory[
                        roomId
                    ].gameCodeUpdatedAt =
                        room.gameCodeUpdatedAt;
                }

                saveHistory();

                io.to(
                    roomId
                ).emit(
                    'saved_room_update',
                    room
                );

                io.to(
                    roomId
                ).emit(
                    'lobby_game_code_updated',
                    {
                        roomId,

                        smashUrl:
                            cleanUrl,

                        updatedBy:
                            player.username
                    }
                );
            }
        );


        // =================================================
        // ROOM CHAT
        // =================================================

        socket.on(
            'send_match_chat',
            ({
                roomId,
                message
            }) => {

                const room =
                    activeRoomsMap.get(
                        roomId
                    );

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !room ||
                    !player ||
                    !player.isAuthenticated ||
                    !socket.rooms.has(
                        roomId
                    )
                ) {
                    return;
                }

                if (
                    typeof message !==
                        'string' ||
                    !message.trim()
                ) {
                    return;
                }

                const msgObj = {
                    roomId,

                    senderName:
                        player.username,

                    message:
                        moderateText(
                            message.trim()
                        ),

                    timestamp:
                        Date.now()
                };

                room.messages.push(
                    msgObj
                );

                if (
                    matchHistory[
                        roomId
                    ]
                ) {
                    matchHistory[
                        roomId
                    ].messages =
                        room.messages;
                }

                saveHistory();

                io.to(
                    roomId
                ).emit(
                    'receive_match_chat',
                    msgObj
                );
            }
        );


        // =================================================
        // LEGACY FRIENDS
        // =================================================

        socket.on(
            'restore_legacy_friends',
            ({
                friends
            }) => {

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !player ||
                    !player.isAuthenticated ||
                    !Array.isArray(
                        friends
                    )
                ) {
                    return;
                }

                for (
                    const name of
                    friends
                ) {

                    if (
                        typeof name !==
                        'string'
                    ) {
                        continue;
                    }

                    const targetName =
                        sanitizeUsername(
                            name
                        );

                    if (
                        targetName ===
                            player.username ||
                        player.friends.has(
                            targetName
                        )
                    ) {
                        continue;
                    }

                    const target =
                        profileFor(
                            targetName
                        );

                    if (
                        !target.requests.includes(
                            player.username
                        )
                    ) {
                        target.requests.push(
                            player.username
                        );
                    }

                    syncFriends(
                        targetName
                    );
                }

                saveHistory();
            }
        );


        // =================================================
        // SAVED HISTORY
        // =================================================

        socket.on(
            'get_saved_match_history',
            () => {

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                if (
                    !player ||
                    !player.isAuthenticated
                ) {
                    return;
                }

                socket.emit(
                    'saved_match_history',

                    Object.values(
                        matchHistory
                    )
                        .filter(
                            room =>
                                room.participants.includes(
                                    player.username
                                )
                        )
                        .sort(
                            (a, b) =>
                                b.createdAt -
                                a.createdAt
                        )
                );
            }
        );


        // =================================================
        // JOIN PUBLIC ROOM
        // =================================================

        socket.on(
            'join_public_room',
            ({
                roomId
            }) => {

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                const room =
                    activeRoomsMap.get(
                        roomId
                    );

                if (
                    !player ||
                    !player.isAuthenticated ||
                    !room
                ) {
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'That lobby is no longer available.'
                        }
                    );
                }

                for (
                    const oldId of
                    Array.from(
                        activeRoomsMap.keys()
                    )
                ) {

                    if (
                        oldId !==
                        roomId
                    ) {
                        leaveLiveRoom(
                            socket,
                            oldId
                        );
                    }
                }

                if (
                    !room.players.some(
                        p =>
                            p.id ===
                            socket.id
                    )
                ) {

                    if (
                        room.players.length >=
                        room.maxPlayers
                    ) {
                        return socket.emit(
                            'room_error',
                            {
                                message:
                                    'That lobby is full.'
                            }
                        );
                    }

                    room.players.push({
                        id:
                            socket.id,

                        name:
                            player.username
                    });
                }

                if (
                    matchHistory[
                        roomId
                    ] &&
                    !matchHistory[
                        roomId
                    ].participants.includes(
                        player.username
                    )
                ) {
                    matchHistory[
                        roomId
                    ].participants.push(
                        player.username
                    );
                }

                saveHistory();

                socket.join(
                    roomId
                );

                socket.emit(
                    room.mode ===
                    'ffa'
                        ? 'ffa_lobby_ready'
                        : 'room_created',

                    room
                );

                io.to(
                    roomId
                ).emit(
                    'saved_room_update',
                    room
                );

                broadcastPublicRooms();
            }
        );


        // =================================================
        // DISCONNECT
        // =================================================

        socket.on(
            'disconnect',
            () => {

                for (
                    const roomId of
                    Array.from(
                        activeRoomsMap.keys()
                    )
                ) {
                    leaveLiveRoom(
                        socket,
                        roomId
                    );
                }

                delete connectedPlayers[
                    socket.id
                ];

                broadcastOnlineUsers();

                broadcastPublicRooms();
            }
        );
    }
);


// =========================================================
// ONLINE USERS
// =========================================================

function broadcastOnlineUsers() {
    const playerList =
        Object.values(
            connectedPlayers
        )
            .filter(
                p =>
                    p.isAuthenticated &&
                    p.isOnline
            )
            .map(
                p => ({
                    id:
                        p.id,

                    username:
                        p.username,

                    friends:
                        Array.from(
                            p.friends
                        )
                })
            );

    io.emit(
        'online_users_update',
        {
            count:
                playerList.length,

            users:
                playerList
        }
    );
}


// =========================================================
// LEADERBOARD
// =========================================================

function broadcastLeaderboard() {
    const topPlayers =
        Object.entries(
            playerStats
        )
            .map(
                ([
                    username,
                    matches
                ]) => ({
                    username,
                    matches
                })
            )
            .filter(
                p =>
                    p.username !==
                        'Player' &&
                    p.username !==
                        'Guest'
            )
            .sort(
                (a, b) =>
                    b.matches -
                    a.matches
            )
            .slice(
                0,
                5
            );

    io.emit(
        'leaderboard_update',
        topPlayers
    );
}


// =========================================================
// START SERVER
// =========================================================

const PORT =
    process.env.PORT ||
    3000;

server.listen(
    PORT,
    () => {
        console.log(
            `Smashkarts1v1s Arena running on port ${PORT}`
        );
    }
);


// =========================================================
// BROWSER FEATURES
// =========================================================

function installSavedHistory() {

    const defaults = {
        gameplay:
            'popup',

        online:
            true,

        mode:
            '1v1',

        win:
            'First to 3',

        lastFriend:
            null
    };

    let preferences = {
        ...defaults
    };

    let settingsWarningShown =
        false;


    // =====================================================
    // SETTINGS
    // =====================================================

    function storageKey() {

        const user =
            AuthSession.getUser();

        return (
            'smash_preferences_v1:' +
            (
                user
                    ? String(
                        user.email ||
                        user.username
                    ).toLowerCase()

                    : 'guest'
            )
        );
    }


    function readPreferences() {

        try {

            return {
                ...defaults,

                ...JSON.parse(
                    localStorage.getItem(
                        storageKey()
                    ) || '{}'
                )
            };

        } catch {

            return {
                ...defaults
            };
        }
    }


    function savePreferences() {

        try {

            localStorage.setItem(
                storageKey(),
                JSON.stringify(
                    preferences
                )
            );

        } catch {

            if (
                !settingsWarningShown
            ) {

                showToast(
                    'Browser storage is full or disabled; settings could not be saved.',
                    '⚠️'
                );
            }

            settingsWarningShown =
                true;
        }
    }


    const originalSwitchMode =
        switchMatchMode;


    function restorePreferences() {

        preferences =
            readPreferences();


        currentGameplayMode =
            preferences.gameplay ===
            'embed'
                ? 'embed'
                : 'popup';


        const gameplaySelect =
            document.getElementById(
                'gameplayModeSelect'
            );


        if (
            gameplaySelect
        ) {
            gameplaySelect.value =
                currentGameplayMode;
        }


        const onlineToggle =
            document.getElementById(
                'onlineStatusToggle'
            );


        if (
            onlineToggle
        ) {
            onlineToggle.checked =
                preferences.online !==
                false;
        }


        originalSwitchMode(
            preferences.mode ===
                '2v2'
                ? '2v2'
                : '1v1'
        );


        const winCondition =
            document.getElementById(
                'winCondition'
            );


        if (
            winCondition
        ) {

            winCondition.value =
                [
                    'First to 3',
                    'First to 6',
                    'First to 10'
                ].includes(
                    preferences.win
                )
                    ? preferences.win
                    : 'First to 3';
        }


        activeDMTargetUser =
            preferences.lastFriend;


        const activeHeader =
            document.getElementById(
                'activeDMChatHeader'
            );


        if (
            activeDMTargetUser &&
            activeHeader
        ) {

            activeHeader.textContent =
                '💬 MESSAGE WITH ' +
                activeDMTargetUser
                    .toUpperCase();
        }
    }


    switchMatchMode =
        function (mode) {

            originalSwitchMode(
                mode
            );

            preferences.mode =
                mode;

            savePreferences();
        };


    updateGameplayMode =
        function (mode) {

            currentGameplayMode =
                mode ===
                'embed'
                    ? 'embed'
                    : 'popup';

            preferences.gameplay =
                currentGameplayMode;

            savePreferences();
        };


    const originalOnlineStatus =
        toggleOnlineStatus;


    toggleOnlineStatus =
        function (online) {

            preferences.online =
                !!online;

            savePreferences();

            originalOnlineStatus(
                online
            );
        };


    const winCondition =
        document.getElementById(
            'winCondition'
        );


    if (
        winCondition
    ) {

        winCondition.addEventListener(
            'change',
            event => {

                preferences.win =
                    event.target.value;

                savePreferences();
            }
        );
    }


    const originalUpdateUserUI =
        updateUserUI;


    updateUserUI =
        function () {

            restorePreferences();

            originalUpdateUserUI();

            if (
                AuthSession.getUser()
            ) {

                socket.emit(
                    'toggle_online_status',
                    preferences.online !==
                        false
                );


                if (
                    activeDMTargetUser
                ) {

                    socket.emit(
                        'get_dm_history',
                        {
                            targetUsername:
                                activeDMTargetUser
                        }
                    );
                }
            }
        };


    socket.on(
        'connect',
        () => {

            if (
                AuthSession.getUser()
            ) {
                updateUserUI();
            }
        }
    );


    // =====================================================
    // DIRECT MESSAGE HISTORY
    // =====================================================

    const originalOpenDM =
        openTabDMWith;


    openTabDMWith =
        function (username) {

            preferences.lastFriend =
                username;

            savePreferences();

            closeOnlineModal();

            const messages =
                document.getElementById(
                    'tabDMMessages'
                );

            if (
                messages
            ) {
                messages.replaceChildren();
            }

            originalOpenDM(
                username
            );
        };


    renderDMMessages =
        function (history) {

            const container =
                document.getElementById(
                    'tabDMMessages'
                );

            if (
                !container
            ) {
                return;
            }

            const user =
                AuthSession.getUser();

            container.replaceChildren();

            for (
                const message of
                history || []
            ) {

                const own =
                    user &&
                    message.senderUsername ===
                        user.username;

                const row =
                    document.createElement(
                        'div'
                    );

                row.className =
                    own
                        ? 'text-right'
                        : 'text-left';

                const bubble =
                    document.createElement(
                        'span'
                    );

                bubble.className =
                    (
                        own
                            ? 'bg-yellow-400 text-blue-950'
                            : 'bg-blue-800 text-white'
                    ) +
                    ' font-bold px-2.5 py-1 rounded-xl inline-block text-[11px] mb-1';

                bubble.style.overflowWrap =
                    'anywhere';

                bubble.textContent =
                    (
                        own
                            ? 'Me'
                            : message.senderUsername
                    ) +
                    ': ' +
                    message.message;

                if (
                    message.timestamp
                ) {
                    bubble.title =
                        new Date(
                            message.timestamp
                        ).toLocaleString();
                }

                row.appendChild(
                    bubble
                );

                container.appendChild(
                    row
                );
            }

            container.scrollTop =
                container.scrollHeight;
        };


    socket.off(
        'dm_sent_success'
    );

    socket.off(
        'load_dm_history'
    );


    for (
        const event of [
            'dm_sent_success',
            'load_dm_history'
        ]
    ) {

        socket.on(
            event,
            data => {

                if (
                    data.targetUsername ===
                    activeDMTargetUser
                ) {
                    renderDMMessages(
                        data.history
                    );
                }
            }
        );
    }


    // =====================================================
    // SAVED FRIENDS
    // =====================================================

    socket.on(
        'saved_friends',
        data => {

            const user =
                AuthSession.getUser();

            if (
                !user
            ) {
                return;
            }

            const previous =
                getLocalFriends(
                    user.username
                );

            saveLocalFriends(
                user.username,
                data.friends
            );

            pendingFriendRequests =
                data.requests;


            const cachedSelf =
                onlineUsersCache.find(
                    p =>
                        p.username ===
                        user.username
                );

            if (
                cachedSelf
            ) {
                cachedSelf.friends =
                    data.friends;
            }


            updateFriendsTabList();


            const missing =
                previous.filter(
                    name =>
                        !data.friends.includes(
                            name
                        )
                );


            if (
                missing.length
            ) {
                socket.emit(
                    'restore_legacy_friends',
                    {
                        friends:
                            missing
                    }
                );
            }
        }
    );


    acceptFriendRequestByName =
        function (username) {

            socket.emit(
                'accept_friend_request',
                {
                    challengerUsername:
                        username
                }
            );
        };


    joinPublicRoomById =
        function (roomId) {

            socket.emit(
                'join_public_room',
                {
                    roomId
                }
            );
        };


    // =====================================================
    // LOBBY CHAT / ROOM UPDATES
    // =====================================================

    socket.on(
        'saved_room_update',
        room => {

            if (
                activeRoomData &&
                activeRoomData.roomId ===
                    room.roomId
            ) {

                activeRoomData =
                    room;

                updatePreGameLobbyUI(
                    room
                );

                renderRoomMessages(
                    room.messages ||
                    []
                );

                if (
                    typeof updateLobbyToolbar ===
                    'function'
                ) {
                    updateLobbyToolbar(
                        room
                    );
                }
            }
        }
    );


    function renderRoomMessages(
        messages
    ) {

        for (
            const id of [
                'matchChatMessages',
                'preGameChatMessages'
            ]
        ) {

            const container =
                document.getElementById(
                    id
                );

            if (
                !container
            ) {
                continue;
            }

            container.replaceChildren();

            for (
                const message of
                messages || []
            ) {

                const row =
                    document.createElement(
                        'div'
                    );

                row.className =
                    'bg-blue-950/80 p-1.5 rounded-xl border border-white/10';

                row.style.overflowWrap =
                    'anywhere';

                row.textContent =
                    message.senderName +
                    ': ' +
                    message.message;

                container.appendChild(
                    row
                );
            }

            container.scrollTop =
                container.scrollHeight;
        }
    }


    const originalOpenLobby =
        openPreGameLobby;


    openPreGameLobby =
        function (room) {

            originalOpenLobby(
                room
            );

            renderRoomMessages(
                room.messages ||
                    []
            );

            updatePreGameLobbyUI(
                room
            );

            const lobbyTitle =
                document.querySelector(
                    '#preGameLobbyModal h3'
                );

            if (
                lobbyTitle
            ) {
                lobbyTitle.textContent =
                    room.mode ===
                    'ffa'
                        ? '👥 FFA LOBBY'
                        : '👥 MATCH LOBBY';
            }


            const headings =
                document.querySelectorAll(
                    '#preGameLobbyModal h4'
                );

            if (
                headings[
                    0
                ]
            ) {
                headings[
                    0
                ].textContent =
                    `👥 ACTIVE PLAYERS (${room.players.length})`;
            }

            if (
                headings[
                    1
                ]
            ) {
                headings[
                    1
                ].textContent =
                    '💬 LOBBY CHAT';
            }


            const playButton =
                document.querySelector(
                    '#preGameLobbyModal button[onclick="enterGameFromLobby()"]'
                );

            if (
                playButton
            ) {

                const gameScreen =
                    document.getElementById(
                        'gameScreen'
                    );

                playButton.textContent =
                    gameScreen &&
                    gameScreen.classList.contains(
                        'hidden'
                    )
                        ? '🚀 JOIN GAME'
                        : '🎮 BACK TO GAME';
            }
        };


    socket.off(
        'receive_match_chat'
    );


    socket.on(
        'receive_match_chat',
        message => {

            if (
                !activeRoomData
            ) {
                return;
            }

            if (
                message.roomId &&
                message.roomId !==
                    activeRoomData.roomId
            ) {
                return;
            }

            if (
                !activeRoomData.messages
            ) {
                activeRoomData.messages =
                    [];
            }

            activeRoomData.messages.push(
                message
            );

            renderRoomMessages(
                activeRoomData.messages
            );
        }
    );


    // =====================================================
    // SAVED HISTORY
    // =====================================================

    const historyDialog =
        document.createElement(
            'dialog'
        );

    historyDialog.style.cssText =
        'width:min(720px,94vw);max-height:85vh;background:#173477;color:white;' +
        'border:2px solid #ffd318;border-radius:20px;padding:20px;overflow:auto';


    const historyClose =
        document.createElement(
            'button'
        );

    historyClose.textContent =
        '✕ Close history';

    historyClose.style.cssText =
        'float:right;padding:8px;color:#ffe238;font-weight:bold';

    historyClose.onclick =
        () =>
            historyDialog.close();


    const historyTitle =
        document.createElement(
            'h2'
        );

    historyTitle.textContent =
        'Saved match history';

    historyTitle.style.cssText =
        'font-size:20px;font-weight:bold;margin-bottom:20px';


    const historyList =
        document.createElement(
            'div'
        );


    historyDialog.append(
        historyClose,
        historyTitle,
        historyList
    );

    document.body.appendChild(
        historyDialog
    );


    function openHistory() {

        historyList.textContent =
            'Loading saved matches…';

        if (
            !historyDialog.open
        ) {
            historyDialog.showModal();
        }

        socket.emit(
            'get_saved_match_history'
        );
    }


    const historyButton =
        document.createElement(
            'button'
        );

    historyButton.id =
        'headerHistoryButton';

    historyButton.textContent =
        '📜 History';

    historyButton.className =
        'bg-blue-800 hover:bg-blue-700 text-yellow-300 text-xs font-bold px-4 py-2 rounded-xl';

    historyButton.onclick =
        openHistory;


    // =====================================================
    // HISTORY + LOGOUT TOGETHER
    // =====================================================

    const mainHeader =
        document.querySelector(
            '#mainDashboard header'
        );


    if (
        mainHeader
    ) {

        const logoutButton =
            mainHeader.querySelector(
                'button[onclick*="AuthSession.logout"]'
            );


        const headerActions =
            document.createElement(
                'div'
            );

        headerActions.id =
            'headerAccountActions';

        headerActions.className =
            'flex items-center gap-2';


        headerActions.appendChild(
            historyButton
        );


        if (
            logoutButton
        ) {
            headerActions.appendChild(
                logoutButton
            );
        }


        mainHeader.appendChild(
            headerActions
        );
    }


    socket.on(
        'saved_match_history',
        rooms => {

            historyList.replaceChildren();


            if (
                !rooms.length
            ) {
                historyList.textContent =
                    'No saved matches yet. New matches will appear here.';
            }


            for (
                const room of
                rooms
            ) {

                const details =
                    document.createElement(
                        'details'
                    );

                details.style.cssText =
                    'padding:12px;margin-bottom:10px;background:#102653;border-radius:12px';


                const summary =
                    document.createElement(
                        'summary'
                    );

                summary.style.cursor =
                    'pointer';


                summary.textContent =
                    new Date(
                        room.createdAt
                    ).toLocaleString() +
                    ' · ' +
                    room.mode +
                    ' · ' +
                    room.participants.join(
                        ', '
                    );


                details.appendChild(
                    summary
                );


                for (
                    const message of
                    room.messages ||
                    []
                ) {

                    const row =
                        document.createElement(
                            'p'
                        );

                    row.style.cssText =
                        'margin-top:8px;overflow-wrap:anywhere';

                    row.textContent =
                        message.senderName +
                        ': ' +
                        message.message;

                    details.appendChild(
                        row
                    );
                }


                if (
                    !(
                        room.messages ||
                        []
                    ).length
                ) {

                    const empty =
                        document.createElement(
                            'p'
                        );

                    empty.textContent =
                        'No chat messages in this match.';

                    details.appendChild(
                        empty
                    );
                }


                historyList.appendChild(
                    details
                );
            }
        }
    );


    // =====================================================
    // FFA SIDEBAR BUTTON
    // =====================================================

    const ffaButton =
        document.createElement(
            'button'
        );


    ffaButton.id =
        'btnNavFFA';


    ffaButton.type =
        'button';


    ffaButton.title =
        'FFA';


    ffaButton.textContent =
        '🔥';


    ffaButton.className =
        'sidebar-btn w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg';


    const oneVOneButton =
        document.getElementById(
            'btnNav1v1'
        );


    if (
        oneVOneButton &&
        oneVOneButton.parentElement &&
        !document.getElementById(
            'btnNavFFA'
        )
    ) {

        oneVOneButton
            .parentElement
            .insertBefore(
                ffaButton,
                oneVOneButton
            );
    }


    // =====================================================
    // FFA REAL TAB PAGE
    // Same dashboard/card system as 1v1 and 2v2.
    // NOT an overlay.
    // =====================================================

    const setupTab =
        document.getElementById(
            'setupTab'
        );


    const ffaTab =
        document.createElement(
            'div'
        );


    ffaTab.id =
        'ffaTab';


    ffaTab.className =
        'tab-content hidden space-y-6';


    ffaTab.innerHTML = `
        <div class="flex justify-between items-center border-b border-white/10 pb-4 gap-4">
            <div>
                <h2 class="font-bungee text-2xl text-white">
                    FFA MATCHMAKING
                </h2>

                <p class="text-xs text-blue-200">
                    Start or join a free-for-all match
                </p>
            </div>

            <button
                id="ffaPublicLobbyButton"
                type="button"
                class="text-xs bg-emerald-500 hover:bg-emerald-400 text-white font-black px-5 py-2.5 rounded-xl uppercase"
            >
                🔍 Public Lobbies
            </button>
        </div>


        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">

            <div>
                <label class="block text-xs font-bold uppercase text-blue-200 mb-2">
                    Join an FFA Lobby
                </label>

                <button
                    id="ffaPlayButton"
                    type="button"
                    class="btn-smash w-full py-4 rounded-2xl font-bungee text-xl text-white"
                >
                    🔥 PLAY FFA
                </button>

                <p class="text-[11px] text-blue-200 mt-2">
                    Join an FFA lobby that is already open.
                </p>
            </div>


            <div>
                <label class="block text-xs font-bold uppercase text-blue-200 mb-2">
                    Start a New FFA Lobby
                </label>

                <button
                    id="ffaCreateButton"
                    type="button"
                    class="bg-emerald-500 hover:bg-emerald-400 w-full py-4 rounded-2xl font-bungee text-xl text-white shadow-lg"
                >
                    + CREATE LOBBY
                </button>

                <p class="text-[11px] text-blue-200 mt-2">
                    Create a fresh FFA lobby and wait for players.
                </p>
            </div>

        </div>


        <div class="bg-blue-900/60 border border-white/10 rounded-2xl p-4">
            <p class="text-xs text-blue-100 leading-relaxed">

                Once you are playing, use

                <strong class="text-yellow-300">
                    PASTE CODE TO LOBBY
                </strong>

                to share the Smash Karts room code without leaving the game.

            </p>
        </div>
    `;


    if (
        setupTab &&
        setupTab.parentElement &&
        !document.getElementById(
            'ffaTab'
        )
    ) {

        setupTab
            .parentElement
            .insertBefore(
                ffaTab,
                setupTab
            );
    }


    function showFFATab() {

        document
            .querySelectorAll(
                '.tab-content'
            )
            .forEach(
                element =>
                    element.classList.add(
                        'hidden'
                    )
            );


        document
            .querySelectorAll(
                '.sidebar-btn'
            )
            .forEach(
                button =>
                    button.classList.remove(
                        'active'
                    )
            );


        ffaButton.classList.add(
            'active'
        );


        ffaTab.classList.remove(
            'hidden'
        );
    }


    ffaButton.onclick =
        showFFATab;


    const ffaPlayButton =
        ffaTab.querySelector(
            '#ffaPlayButton'
        );


    const ffaCreateButton =
        ffaTab.querySelector(
            '#ffaCreateButton'
        );


    const ffaPublicLobbyButton =
        ffaTab.querySelector(
            '#ffaPublicLobbyButton'
        );


    if (
        ffaPublicLobbyButton
    ) {
        ffaPublicLobbyButton.onclick =
            () =>
                openFindGameModal();
    }


    let ffaWaitTimer =
        null;


    function requireFFAUser() {

        if (
            AuthSession.getUser()
        ) {
            return true;
        }


        const authModal =
            document.getElementById(
                'authModal'
            );


        if (
            authModal
        ) {
            authModal.classList.remove(
                'hidden'
            );
        }


        return false;
    }


    function finishFFARequest() {

        clearTimeout(
            ffaWaitTimer
        );


        if (
            ffaPlayButton
        ) {
            ffaPlayButton.disabled =
                false;

            ffaPlayButton.style.opacity =
                '';
        }


        if (
            ffaCreateButton
        ) {
            ffaCreateButton.disabled =
                false;

            ffaCreateButton.style.opacity =
                '';
        }
    }


    function beginFFARequest() {

        finishFFARequest();


        if (
            ffaPlayButton
        ) {
            ffaPlayButton.disabled =
                true;

            ffaPlayButton.style.opacity =
                '0.65';
        }


        if (
            ffaCreateButton
        ) {
            ffaCreateButton.disabled =
                true;

            ffaCreateButton.style.opacity =
                '0.65';
        }


        ffaWaitTimer =
            setTimeout(
                () => {

                    finishFFARequest();

                    showToast(
                        'The FFA lobby did not respond. Please try again.',
                        'ℹ️'
                    );

                },
                8000
            );
    }


    ffaPlayButton.onclick =
        () => {

            if (
                !requireFFAUser()
            ) {
                return;
            }


            if (
                !socket.connected
            ) {
                showToast(
                    'Connecting to the lobby. Try again in a moment.',
                    'ℹ️'
                );

                return;
            }


            beginFFARequest();


            socket.emit(
                'play_ffa'
            );
        };


    ffaCreateButton.onclick =
        () => {

            if (
                !requireFFAUser()
            ) {
                return;
            }


            if (
                !socket.connected
            ) {
                showToast(
                    'Connecting to the lobby. Try again in a moment.',
                    'ℹ️'
                );

                return;
            }


            beginFFARequest();


            socket.emit(
                'create_ffa_lobby'
            );
        };


    socket.on(
        'ffa_no_lobby',
        data => {

            finishFFARequest();


            showToast(
                data &&
                data.message
                    ? data.message
                    : 'No FFA lobby is open yet.',
                'ℹ️'
            );
        }
    );


    socket.on(
        'room_error',
        finishFFARequest
    );


    socket.on(
        'disconnect',
        finishFFARequest
    );


    socket.on(
        'ffa_lobby_ready',
        room => {

            finishFFARequest();


            activeRoomData =
                room;


            renderRoomMessages(
                room.messages ||
                    []
            );


            updateLobbyToolbar(
                room
            );


            openPreGameLobby(
                room
            );
        }
    );


    // =====================================================
    // GAME LOBBY TOOLBAR
    // =====================================================

    function extractLobbyCode(url) {

        if (
            !url
        ) {
            return '';
        }


        const match =
            String(
                url
            ).match(
                /room=([A-Za-z0-9]+)/i
            );


        return match
            ? match[
                1
            ]
            : '';
    }


    function updateLobbyToolbar(
        room
    ) {

        if (
            !room
        ) {
            return;
        }


        installGameLobbyControls();


        const players =
            Array.isArray(
                room.players
            )
                ? room.players
                : [];


        const count =
            players.length;


        const countBadge =
            document.getElementById(
                'gameLobbyPlayerCount'
            );


        if (
            countBadge
        ) {
            countBadge.textContent =
                `👥 ${count} IN LOBBY`;
        }


        const playerNames =
            document.getElementById(
                'gameLobbyPlayerNames'
            );


        if (
            playerNames
        ) {

            playerNames.replaceChildren();


            if (
                players.length ===
                0
            ) {

                const empty =
                    document.createElement(
                        'span'
                    );

                empty.textContent =
                    'No active players';

                empty.style.opacity =
                    '0.75';


                playerNames.appendChild(
                    empty
                );

            } else {

                players
                    .slice(
                        0,
                        6
                    )
                    .forEach(
                        player => {

                            const chip =
                                document.createElement(
                                    'span'
                                );


                            chip.textContent =
                                `👤 ${player.name}`;


                            chip.style.cssText =
                                'display:inline-flex;' +
                                'align-items:center;' +
                                'max-width:150px;' +
                                'overflow:hidden;' +
                                'text-overflow:ellipsis;' +
                                'white-space:nowrap;' +
                                'background:#234caa;' +
                                'border:1px solid #ffffff25;' +
                                'border-radius:14px;' +
                                'padding:4px 8px;' +
                                'color:#fff;' +
                                'font:800 11px sans-serif;';


                            playerNames.appendChild(
                                chip
                            );
                        }
                    );


                if (
                    players.length >
                    6
                ) {

                    const more =
                        document.createElement(
                            'span'
                        );


                    more.textContent =
                        `+${players.length - 6} more`;


                    more.style.cssText =
                        'display:inline-flex;' +
                        'align-items:center;' +
                        'background:#102653;' +
                        'border:1px solid #ffffff25;' +
                        'border-radius:14px;' +
                        'padding:4px 8px;' +
                        'color:#ffe238;' +
                        'font:900 11px sans-serif;';


                    playerNames.appendChild(
                        more
                    );
                }
            }
        }


        if (
            typeof updatePreGameLobbyUI ===
            'function'
        ) {
            updatePreGameLobbyUI(
                room
            );
        }


        const gameModeBadge =
            document.getElementById(
                'gameModeBadge'
            );


        if (
            gameModeBadge &&
            room.mode
        ) {
            gameModeBadge.textContent =
                String(
                    room.mode
                ).toUpperCase();
        }


        const roomCode =
            extractLobbyCode(
                room.smashUrl
            );


        currentRoomCode =
            roomCode;


        const codeDisplay =
            document.getElementById(
                'gameRoomCodeDisplay'
            );


        if (
            codeDisplay
        ) {
            codeDisplay.textContent =
                roomCode ||
                'NOT SET';
        }


        const codeContainer =
            document.getElementById(
                'gameRoomCodeContainer'
            );


        if (
            codeContainer
        ) {
            codeContainer.hidden =
                room.mode ===
                'ffa';
        }
    }


    function promptPasteCodeToLobby() {

        if (
            !activeRoomData
        ) {
            showToast(
                'You are not currently in a lobby.',
                'ℹ️'
            );

            return;
        }


        const pasted =
            window.prompt(
                'Paste the Smash Karts room code or room link:'
            );


        if (
            pasted ===
            null
        ) {
            return;
        }


        const value =
            pasted.trim();


        if (
            !value
        ) {
            showToast(
                'Paste a room code or link first.',
                '⚠️'
            );

            return;
        }


        socket.emit(
            'update_lobby_game_code',
            {
                roomId:
                    activeRoomData.roomId,

                code:
                    value
            }
        );
    }


    function installGameLobbyControls() {

        const toolbar =
            document.querySelector(
                '.game-actions'
            );


        const brand =
            document.querySelector(
                '.game-brand'
            );


        const chatButton =
            document.getElementById(
                'gameChatToggle'
            );


        if (
            brand &&
            !document.getElementById(
                'gameLobbyPlayersTab'
            )
        ) {

            const playersTab =
                document.createElement(
                    'div'
                );


            playersTab.id =
                'gameLobbyPlayersTab';


            playersTab.style.cssText =
                'display:flex;' +
                'align-items:center;' +
                'gap:7px;' +
                'min-width:0;' +
                'max-width:min(52vw,760px);' +
                'background:#102653;' +
                'border:1px solid #ffffff30;' +
                'border-radius:18px;' +
                'padding:6px 9px;';


            const countBadge =
                document.createElement(
                    'span'
                );


            countBadge.id =
                'gameLobbyPlayerCount';


            countBadge.textContent =
                '👥 0 IN LOBBY';


            countBadge.style.cssText =
                'font:900 12px sans-serif;' +
                'color:#ffe238;' +
                'white-space:nowrap;';


            const playerNames =
                document.createElement(
                    'div'
                );


            playerNames.id =
                'gameLobbyPlayerNames';


            playerNames.setAttribute(
                'aria-label',
                'Active players in lobby'
            );


            playerNames.style.cssText =
                'display:flex;' +
                'align-items:center;' +
                'gap:5px;' +
                'min-width:0;' +
                'overflow:hidden;' +
                'white-space:nowrap;';


            playersTab.append(
                countBadge,
                playerNames
            );


            brand.appendChild(
                playersTab
            );
        }


        if (
            !toolbar ||
            !chatButton
        ) {
            return;
        }


        let pasteButton =
            document.getElementById(
                'pasteLobbyCodeButton'
            );


        if (
            !pasteButton
        ) {

            pasteButton =
                document.createElement(
                    'button'
                );


            pasteButton.id =
                'pasteLobbyCodeButton';


            pasteButton.type =
                'button';


            pasteButton.className =
                'game-control';


            pasteButton.textContent =
                '📋 PASTE CODE TO LOBBY';


            pasteButton.onclick =
                promptPasteCodeToLobby;
        }


        let lobbyButton =
            document.getElementById(
                'arenaLobbyButton'
            );


        if (
            !lobbyButton
        ) {

            lobbyButton =
                document.createElement(
                    'button'
                );


            lobbyButton.id =
                'arenaLobbyButton';


            lobbyButton.type =
                'button';


            lobbyButton.className =
                'game-control';


            lobbyButton.textContent =
                '👥 LOBBY';


            lobbyButton.onclick =
                () => {

                    if (
                        !activeRoomData
                    ) {
                        showToast(
                            'You are not currently in a lobby.',
                            'ℹ️'
                        );

                        return;
                    }


                    openPreGameLobby(
                        activeRoomData
                    );
                };
        }


        // Exact order:
        //
        // PASTE CODE TO LOBBY
        // LOBBY
        // SHOW CHAT

        toolbar.insertBefore(
            pasteButton,
            chatButton
        );


        toolbar.insertBefore(
            lobbyButton,
            chatButton
        );
    }


    installGameLobbyControls();


    document.addEventListener(
        'DOMContentLoaded',
        installGameLobbyControls
    );


    // =====================================================
    // MOVE SHOW / HIDE MENU A TINY BIT LEFT
    // Original HTML uses right:22px.
    // This moves it 10px left.
    // =====================================================

    const gameToolbarToggle =
        document.getElementById(
            'gameToolbarToggle'
        );


    if (
        gameToolbarToggle
    ) {
        gameToolbarToggle.style.right =
            '32px';
    }


    socket.on(
        'lobby_game_code_updated',
        data => {

            if (
                !activeRoomData ||
                data.roomId !==
                    activeRoomData.roomId
            ) {
                return;
            }


            activeRoomData.smashUrl =
                data.smashUrl;


            updateLobbyToolbar(
                activeRoomData
            );


            const roomCode =
                extractLobbyCode(
                    data.smashUrl
                );


            showToast(
                roomCode
                    ? `${data.updatedBy} pasted room code ${roomCode} into the lobby.`
                    : `${data.updatedBy} updated the lobby game link.`,
                '📋'
            );
        }
    );


    // =====================================================
    // ENTER GAME
    // =====================================================

    const enterWithOverlay =
        enterGameFromLobby;


    enterGameFromLobby =
        function (...args) {

            const screen =
                document.getElementById(
                    'gameScreen'
                );


            if (
                screen &&
                !screen.classList.contains(
                    'hidden'
                ) &&
                !screen.classList.contains(
                    'game-fade-exit'
                )
            ) {

                closePreGameLobbyModal();

                return;
            }


            const result =
                enterWithOverlay.apply(
                    this,
                    args
                );


            installGameLobbyControls();


            if (
                activeRoomData
            ) {
                updateLobbyToolbar(
                    activeRoomData
                );
            }


            requestAnimationFrame(
                () => {

                    installGameLobbyControls();


                    if (
                        activeRoomData
                    ) {
                        updateLobbyToolbar(
                            activeRoomData
                        );
                    }
                }
            );


            return result;
        };


    const defaultChatTitle =
        document.querySelector(
            '#chatOverlay .font-bungee'
        );


    if (
        defaultChatTitle
    ) {
        defaultChatTitle.textContent =
            '💬 LOBBY CHAT';
    }


    restorePreferences();
}