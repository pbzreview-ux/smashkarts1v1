const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

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

        io.to(player.id).emit(
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

    for (
        const word of
        BANNED_WORDS
    ) {
        cleanText =
            cleanText.replace(
                new RegExp(
                    `\\b${word}\\b`,
                    'gi'
                ),
                '***'
            );
    }

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

function findSocketByUsername(
    username
) {
    return Object.values(
        connectedPlayers
    ).find(
        p =>
            p.username
                .toLowerCase() ===
            String(
                username || ''
            ).toLowerCase()
    );
}

function publicRoomList() {
    return Array.from(
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
}

function broadcastPublicRooms() {
    io.emit(
        'public_rooms_update',
        publicRoomList()
    );
}


// =========================================================
// DELETE EVERY LIVE LOBBY AT 0 PLAYERS
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
            player =>
                player.id ===
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
            player =>
                player.id !==
                socket.id
        );

    // ALL lobby types disappear immediately at 0 players.
    if (
        room.players.length ===
        0
    ) {
        activeRoomsMap.delete(
            roomId
        );

        io.emit(
            'lobby_deleted',
            {
                roomId
            }
        );

    } else {
        io.to(
            roomId
        ).emit(
            'saved_room_update',
            room
        );
    }

    broadcastPublicRooms();
}


function addParticipantToHistory(
    room,
    username
) {
    const savedRoom =
        matchHistory[
            room.roomId
        ];

    if (!savedRoom) {
        return;
    }

    if (
        !Array.isArray(
            savedRoom.participants
        )
    ) {
        savedRoom.participants =
            [];
    }

    if (
        !savedRoom.participants.includes(
            username
        )
    ) {
        savedRoom.participants.push(
            username
        );
    }
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
        // LOGIN SESSION
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

                if (!player) {
                    return;
                }

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

                const player =
                    connectedPlayers[
                        socket.id
                    ];

                if (!player) {
                    return;
                }

                player.isOnline =
                    !!isOnline;

                savePlayer(
                    player
                );

                saveHistory();

                broadcastOnlineUsers();
            }
        );


        // =================================================
        // FRIEND REQUESTS
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
                    !sender ||
                    !target ||
                    !sender.isAuthenticated ||
                    !target.isAuthenticated
                ) {
                    return;
                }

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
                        moderateText(
                            message.trim()
                        ),

                    timestamp:
                        Date.now()
                };

                directMessageStore[
                    dmKey
                ].push(
                    msgObj
                );

                saveHistory();

                const targetPlayer =
                    findSocketByUsername(
                        cleanTarget
                    );

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
                                msgObj.message,

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
                    uname !== 'Player' &&
                    uname !== 'Guest'
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
        // FRIEND MATCH CHALLENGE
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
                    !target ||
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
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'A valid Smash Karts room link or code is required!'
                        }
                    );
                }

                io.to(
                    target.id
                ).emit(
                    'receive_match_challenge',
                    {
                        challengerSocketId:
                            socket.id,

                        fromUsername:
                            sanitizeUsername(
                                fromUsername
                            ),

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
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'A valid Smash Karts room link or code is required!'
                        }
                    );
                }

                const challenger =
                    connectedPlayers[
                        challengerSocketId
                    ];

                if (!challenger) {
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'That challenger is no longer online.'
                        }
                    );
                }

                const roomId =
                    crypto.randomUUID();

                const room = {
                    roomId,

                    hostName:
                        challenger.username,

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
                                sanitizeUsername(
                                    targetUsername
                                )
                        },

                        {
                            id:
                                challengerSocketId,

                            name:
                                challenger.username
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
                                player =>
                                    player.name
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
        // CREATE NORMAL 1v1 / 2v2 LOBBY
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
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'Error: You must provide a valid Smash Karts room link or code to join/create!'
                        }
                    );
                }

                // Leave any old lobby first.
                // If that made it empty, it gets deleted instantly.
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

                const room = {
                    roomId,

                    hostName:
                        player.username,

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
                                player.username
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
                        player.username
                    ]
                };

                saveHistory();

                socket.join(
                    roomId
                );

                socket.emit(
                    'room_created',
                    room
                );

                broadcastPublicRooms();
            }
        );


        socket.on(
            'get_public_rooms',
            broadcastPublicRooms
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
            }
        );


        // =================================================
        // FFA
        // =================================================

        function joinFFARoom(
            room,
            player
        ) {

            // Leave every other lobby first.
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
                    currentPlayer =>
                        currentPlayer.id ===
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

            addParticipantToHistory(
                room,
                player.username
            );

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


        // PLAY FFA:
        // join an existing lobby.
        // It DOES NOT automatically create one.
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
                                'No FFA lobby exists yet. Click CREATE LOBBY to make one.'
                        }
                    );
                }

                joinFFARoom(
                    room,
                    player
                );
            }
        );


        // CREATE LOBBY:
        // make a brand-new FFA lobby.
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
        // PASTE GAME CODE INTO CURRENT LOBBY
        // DOES NOT RELOAD OR CLOSE THE GAME
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
                                'That lobby no longer exists.'
                        }
                    );
                }

                if (
                    !room.players.some(
                        currentPlayer =>
                            currentPlayer.id ===
                            socket.id
                    )
                ) {
                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'You must be in the lobby to change its game code.'
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
                                'Paste a valid Smash Karts room code or link.'
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
                    'lobby_game_code_updated',
                    {
                        roomId,

                        smashUrl:
                            cleanUrl,

                        updatedBy:
                            player.username
                    }
                );

                io.to(
                    roomId
                ).emit(
                    'saved_room_update',
                    room
                );
            }
        );


        // =================================================
        // LOBBY CHAT
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
        // RESTORE OLD FRIENDS
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
        // SAVED MATCH HISTORY
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
                                Array.isArray(
                                    room.participants
                                ) &&
                                room.participants.includes(
                                    player.username
                                )
                        )
                        .sort(
                            (a, b) =>
                                (
                                    b.createdAt ||
                                    0
                                ) -
                                (
                                    a.createdAt ||
                                    0
                                )
                        )
                );
            }
        );


        // =================================================
        // JOIN A PUBLIC LOBBY
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
                        currentPlayer =>
                            currentPlayer.id ===
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

                addParticipantToHistory(
                    room,
                    player.username
                );

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

                // Remove player from every lobby.
                // Any lobby that reaches 0 players
                // is instantly deleted.
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
// ONLINE PLAYERS
// =========================================================

function broadcastOnlineUsers() {
    const playerList =
        Object.values(
            connectedPlayers
        )
            .filter(
                player =>
                    player.isAuthenticated &&
                    player.isOnline
            )
            .map(
                player => ({
                    id:
                        player.id,

                    username:
                        player.username,

                    friends:
                        Array.from(
                            player.friends
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
                player =>
                    player.username !==
                        'Player' &&
                    player.username !==
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
// BROWSER-SIDE FEATURES
// THIS IS AUTOMATICALLY ADDED AFTER script(1).js
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
                activeDMTargetUser.toUpperCase();
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
    // SAVED DIRECT MESSAGES
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
                    player =>
                        player.username ===
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
    // ROOM CHAT + LIVE PLAYER COUNT
    // =====================================================

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


    function updateLobbyCount(
        room
    ) {

        const count =
            room &&
            Array.isArray(
                room.players
            )
                ? room.players.length
                : 0;

        const label =
            document.getElementById(
                'gameLobbyPlayerCount'
            );

        if (
            label
        ) {
            label.textContent =
                '👥 ' +
                count +
                ' IN LOBBY';
        }
    }


    function updateLobbyCodeDisplay(
        room
    ) {

        const display =
            document.getElementById(
                'gameRoomCodeDisplay'
            );

        if (
            !display ||
            !room
        ) {
            return;
        }


        if (
            room.mode ===
            'ffa'
        ) {

            const match =
                String(
                    room.smashUrl ||
                    ''
                ).match(
                    /[?&]room=([^&]+)/i
                );

            display.textContent =
                match
                    ? decodeURIComponent(
                        match[1]
                    )
                    : 'FFA';
        }
    }


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

                updateLobbyCount(
                    room
                );

                updateLobbyCodeDisplay(
                    room
                );
            }
        }
    );


    socket.on(
        'lobby_deleted',
        ({
            roomId
        }) => {

            if (
                activeRoomData &&
                activeRoomData.roomId ===
                    roomId
            ) {
                activeRoomData =
                    null;

                updateLobbyCount(
                    null
                );
            }
        }
    );


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
                headings[1]
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
    // SAVED HISTORY VIEWER
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

    historyButton.textContent =
        '📜 Saved history';

    historyButton.className =
        'bg-blue-800 text-yellow-300 font-bold px-4 py-2 rounded-xl text-xs';

    historyButton.onclick =
        openHistory;


    const mainHeader =
        document.querySelector(
            '#mainDashboard header'
        );

    if (
        mainHeader &&
        !document.getElementById(
            'savedHistoryHeaderButton'
        )
    ) {
        historyButton.id =
            'savedHistoryHeaderButton';

        mainHeader.appendChild(
            historyButton
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
                        room.createdAt ||
                        Date.now()
                    ).toLocaleString() +
                    ' · ' +
                    room.mode +
                    ' · ' +
                    (
                        room.participants ||
                        []
                    ).join(
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
    // FFA SIDEBAR BUTTON + FFA CHOICE SCREEN
    // =====================================================

    const ffaModal =
        document.createElement(
            'div'
        );

    ffaModal.id =
        'ffaSetupModal';

    ffaModal.className =
        'hidden fixed inset-0 z-[100] flex items-center justify-center p-4';

    ffaModal.style.background =
        'rgba(5,15,45,.82)';


    const ffaCard =
        document.createElement(
            'div'
        );

    ffaCard.style.cssText =
        'width:min(460px,94vw);background:#173477;color:white;border:2px solid #ffd318;' +
        'border-radius:24px;padding:22px;box-shadow:0 20px 60px #0009';


    const ffaTop =
        document.createElement(
            'div'
        );

    ffaTop.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px';


    const ffaTitle =
        document.createElement(
            'h2'
        );

    ffaTitle.textContent =
        '🔥 FFA';

    ffaTitle.className =
        'font-bungee text-2xl text-yellow-300';


    const ffaClose =
        document.createElement(
            'button'
        );

    ffaClose.textContent =
        '✕';

    ffaClose.style.cssText =
        'font-size:20px;font-weight:900;color:white;padding:8px';

    ffaClose.onclick =
        () =>
            ffaModal.classList.add(
                'hidden'
            );


    ffaTop.append(
        ffaTitle,
        ffaClose
    );


    const ffaDescription =
        document.createElement(
            'p'
        );

    ffaDescription.textContent =
        'PLAY FFA joins an open lobby. CREATE LOBBY makes a new one.';

    ffaDescription.style.cssText =
        'font-size:13px;color:#c9d8ff;margin-bottom:16px;line-height:1.5';


    const playFFAButton =
        document.createElement(
            'button'
        );

    playFFAButton.textContent =
        '🔥 PLAY FFA';

    playFFAButton.style.cssText =
        'width:100%;padding:15px;border-radius:16px;background:#ffd318;color:#132b6e;' +
        'font-weight:900;font-size:18px;margin-bottom:12px';


    const createFFALobbyButton =
        document.createElement(
            'button'
        );

    createFFALobbyButton.textContent =
        '➕ CREATE LOBBY';

    createFFALobbyButton.style.cssText =
        'width:100%;padding:15px;border-radius:16px;background:#234caa;color:white;' +
        'border:1px solid #7f99d7;font-weight:900;font-size:18px';


    ffaCard.append(
        ffaTop,
        ffaDescription,
        playFFAButton,
        createFFALobbyButton
    );

    ffaModal.appendChild(
        ffaCard
    );

    document.body.appendChild(
        ffaModal
    );


    // This is the new sidebar FFA icon.
    const ffaNavButton =
        document.createElement(
            'button'
        );

    ffaNavButton.id =
        'btnNavFFA';

    ffaNavButton.type =
        'button';

    ffaNavButton.title =
        'FFA';

    ffaNavButton.textContent =
        '🔥';

    ffaNavButton.className =
        'sidebar-btn w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg';


    function installFFANavButton() {

        const oneVOneButton =
            document.getElementById(
                'btnNav1v1'
            );

        if (
            !oneVOneButton ||
            !oneVOneButton.parentElement
        ) {
            return;
        }


        // Leaderboard already sits directly before 1v1.
        // Inserting FFA before 1v1 makes:
        //
        // 🏆 Leaderboard
        // 🔥 FFA
        // 🎮 1v1
        // ⚔️ 2v2
        // 💬 Messages

        if (
            !document.getElementById(
                'btnNavFFA'
            )
        ) {
            oneVOneButton
                .parentElement
                .insertBefore(
                    ffaNavButton,
                    oneVOneButton
                );
        }
    }


    function openFFAMenu() {

        if (
            !AuthSession.getUser()
        ) {
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

            return;
        }


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


        ffaNavButton.classList.add(
            'active'
        );


        // IMPORTANT:
        // Clicking the sidebar icon does NOT join a lobby.
        ffaModal.classList.remove(
            'hidden'
        );
    }


    ffaNavButton.onclick =
        openFFAMenu;


    installFFANavButton();


    if (
        document.readyState ===
        'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            installFFANavButton
        );
    }


    // =====================================================
    // PLAY FFA / CREATE LOBBY BUTTONS
    // =====================================================

    let ffaWaitTimer =
        null;


    function setFFARequestBusy(
        button,
        busy,
        busyText
    ) {

        clearTimeout(
            ffaWaitTimer
        );

        playFFAButton.disabled =
            busy;

        createFFALobbyButton.disabled =
            busy;


        if (
            button
        ) {
            button.textContent =
                busy
                    ? busyText
                    : button.dataset.normalText;
        }


        if (
            !busy
        ) {
            playFFAButton.textContent =
                playFFAButton.dataset.normalText;

            createFFALobbyButton.textContent =
                createFFALobbyButton.dataset.normalText;
        }
    }


    playFFAButton.dataset.normalText =
        playFFAButton.textContent;

    createFFALobbyButton.dataset.normalText =
        createFFALobbyButton.textContent;


    function beginFFARequest(
        button,
        eventName,
        busyText
    ) {

        if (
            !socket.connected
        ) {
            showToast(
                'Connecting to the server. Try again in a moment.',
                'ℹ️'
            );

            return;
        }


        if (
            playFFAButton.disabled ||
            createFFALobbyButton.disabled
        ) {
            return;
        }


        setFFARequestBusy(
            button,
            true,
            busyText
        );


        socket.emit(
            eventName
        );


        ffaWaitTimer =
            setTimeout(
                () => {

                    setFFARequestBusy(
                        null,
                        false
                    );

                    showToast(
                        'The lobby did not respond. Please try again.',
                        'ℹ️'
                    );

                },
                8000
            );
    }


    playFFAButton.onclick =
        () =>
            beginFFARequest(
                playFFAButton,
                'play_ffa',
                'JOINING…'
            );


    createFFALobbyButton.onclick =
        () =>
            beginFFARequest(
                createFFALobbyButton,
                'create_ffa_lobby',
                'CREATING…'
            );


    socket.on(
        'ffa_no_lobby',
        data => {

            setFFARequestBusy(
                null,
                false
            );

            showToast(
                (
                    data &&
                    data.message
                ) ||
                'No FFA lobby is open yet.',
                'ℹ️'
            );
        }
    );


    socket.on(
        'room_error',
        () =>
            setFFARequestBusy(
                null,
                false
            )
    );


    socket.on(
        'disconnect',
        () =>
            setFFARequestBusy(
                null,
                false
            )
    );


    // =====================================================
    // ENTER FFA GAME
    // =====================================================

    function startFFAGame(
        room
    ) {

        setFFARequestBusy(
            null,
            false
        );

        ffaModal.classList.add(
            'hidden'
        );


        activeRoomData =
            room;


        renderRoomMessages(
            room.messages ||
            []
        );


        updatePreGameLobbyUI(
            room
        );


        updateLobbyCount(
            room
        );


        // Force FFA into the embedded play screen.
        // This keeps the Lobby / Paste Code / Chat toolbar available.
        const oldGameplayMode =
            currentGameplayMode;


        currentGameplayMode =
            'embed';


        try {
            enterGameFromLobby();

        } finally {
            currentGameplayMode =
                oldGameplayMode;
        }


        currentRoomCode =
            '';


        const badge =
            document.getElementById(
                'gameModeBadge'
            );

        if (
            badge
        ) {
            badge.textContent =
                'FFA';
        }


        const codeContainer =
            document.getElementById(
                'gameRoomCodeContainer'
            );

        if (
            codeContainer
        ) {
            codeContainer.hidden =
                true;
        }


        const chatTitle =
            document.querySelector(
                '#chatOverlay .font-bungee'
            );

        if (
            chatTitle
        ) {
            chatTitle.textContent =
                '💬 LOBBY CHAT';
        }
    }


    socket.on(
        'ffa_lobby_ready',
        startFFAGame
    );


    // =====================================================
    // IN-GAME TOOLBAR
    //
    // FAR LEFT:
    // 👥 3 IN LOBBY
    //
    // FAR RIGHT:
    // 📋 PASTE CODE TO LOBBY
    // 👥 LOBBY
    // 💬 SHOW CHAT
    // =====================================================

    function installGameToolbarExtras() {

        const actions =
            document.querySelector(
                '.game-actions'
            );

        const brand =
            document.querySelector(
                '.game-brand'
            );


        if (
            !actions ||
            !brand
        ) {
            return;
        }


        // ---------------------------------------------
        // LIVE PLAYER COUNT ON FAR LEFT
        // ---------------------------------------------

        let count =
            document.getElementById(
                'gameLobbyPlayerCount'
            );


        if (
            !count
        ) {

            count =
                document.createElement(
                    'span'
                );

            count.id =
                'gameLobbyPlayerCount';

            count.textContent =
                '👥 0 IN LOBBY';

            count.style.cssText =
                'font-size:13px;font-weight:900;color:#ffe238;background:#ffffff12;' +
                'border:1px solid #ffffff30;border-radius:18px;padding:9px 13px;white-space:nowrap';


            // game-brand is the far left side of the toolbar.
            brand.appendChild(
                count
            );
        }


        // ---------------------------------------------
        // PASTE CODE TO LOBBY
        // ---------------------------------------------

        let pasteButton =
            document.getElementById(
                'pasteCodeToLobbyButton'
            );


        if (
            !pasteButton
        ) {

            pasteButton =
                document.createElement(
                    'button'
                );

            pasteButton.id =
                'pasteCodeToLobbyButton';

            pasteButton.className =
                'game-control';

            pasteButton.textContent =
                '📋 PASTE CODE TO LOBBY';


            pasteButton.onclick =
                () => {

                    if (
                        !activeRoomData
                    ) {
                        showToast(
                            'You are not in a lobby.',
                            'ℹ️'
                        );

                        return;
                    }


                    const code =
                        window.prompt(
                            'Paste the Smash Karts room code or full room link.\n\n' +
                            'This updates the lobby without closing or reloading your current game.'
                        );


                    if (
                        code ===
                        null
                    ) {
                        return;
                    }


                    if (
                        !code.trim()
                    ) {
                        showToast(
                            'No code was pasted.',
                            'ℹ️'
                        );

                        return;
                    }


                    socket.emit(
                        'update_lobby_game_code',
                        {
                            roomId:
                                activeRoomData.roomId,

                            code:
                                code.trim()
                        }
                    );
                };
        }


        // ---------------------------------------------
        // LOBBY BUTTON
        // ---------------------------------------------

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
                            'You are not in a lobby.',
                            'ℹ️'
                        );

                        return;
                    }


                    openPreGameLobby(
                        activeRoomData
                    );
                };
        }


        // Your existing Show Chat button.
        const chatButton =
            document.getElementById(
                'gameChatToggle'
            );


        if (
            chatButton
        ) {

            // Final order:
            // PASTE CODE -> LOBBY -> SHOW CHAT

            actions.insertBefore(
                pasteButton,
                chatButton
            );

            actions.insertBefore(
                lobbyButton,
                chatButton
            );

        } else {

            actions.append(
                pasteButton,
                lobbyButton
            );
        }


        updateLobbyCount(
            activeRoomData
        );
    }


    installGameToolbarExtras();


    if (
        document.readyState ===
        'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            installGameToolbarExtras
        );
    }


    // =====================================================
    // CODE UPDATED IN LOBBY
    // =====================================================

    socket.on(
        'lobby_game_code_updated',
        data => {

            if (
                !activeRoomData ||
                activeRoomData.roomId !==
                    data.roomId
            ) {
                return;
            }


            activeRoomData.smashUrl =
                data.smashUrl;


            updateLobbyCodeDisplay(
                activeRoomData
            );


            showToast(
                'Lobby game code updated by ' +
                data.updatedBy +
                '.',
                '📋'
            );


            // IMPORTANT:
            // We intentionally DO NOT change smashFrame.src here.
            //
            // That means pasting a new lobby code does NOT kick
            // you out of your current game.
        }
    );


    // =====================================================
    // OPENING LOBBY DOES NOT RESTART GAME
    // =====================================================

    const originalEnterGameFromLobby =
        enterGameFromLobby;


    enterGameFromLobby =
        function (...args) {

            const screen =
                document.getElementById(
                    'gameScreen'
                );


            // If already inside the game,
            // BACK TO GAME only closes the lobby window.
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


            return originalEnterGameFromLobby.apply(
                this,
                args
            );
        };


    restorePreferences();
}