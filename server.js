const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve your existing browser script, then append the extra lobby/FFA UI below.
app.get('/script.js', (req, res) => {
    const filename = ['script.js', 'script(1).js'].find(name =>
        fs.existsSync(path.join(__dirname, name))
    );

    if (!filename) {
        return res
            .status(404)
            .send('Missing script.js or script(1).js');
    }

    res
        .type('application/javascript')
        .send(
            fs.readFileSync(
                path.join(
                    __dirname,
                    filename
                ),
                'utf8'
            ) +
            '\n;(' +
            installArenaExtras.toString() +
            ')();'
        );
});


app.use((req, res, next) => {

    if (
        /^\/data(?:\/|$)/i.test(
            req.path
        )
    ) {
        return res.sendStatus(404);
    }


    if (
        req.path === '/' ||
        /\.(html|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|mp3|mp4)$/i
            .test(req.path)
    ) {
        return next();
    }


    res.sendStatus(404);
});


app.use(
    express.static(__dirname)
);


// =========================================================
// SERVER DATA
// =========================================================

const connectedPlayers = {};

const activeRoomsMap =
    new Map();


const dataDirectory =
    path.resolve(
        process.env.SMASH_DATA_DIR ||
        path.join(
            __dirname,
            'data'
        )
    );


fs.mkdirSync(
    dataDirectory,
    {
        recursive: true
    }
);


const dataFile =
    path.join(
        dataDirectory,
        'history.json'
    );


const saved =
    fs.existsSync(
        dataFile
    )
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


const profiles =
    Object.assign(
        Object.create(null),
        saved.profiles
    );


const playerStats =
    Object.assign(
        Object.create(null),
        saved.stats
    );


const directMessageStore =
    Object.assign(
        Object.create(null),
        saved.directMessages
    );


const matchHistory =
    Object.assign(
        Object.create(null),
        saved.matches
    );


// =========================================================
// SAVE HISTORY
// =========================================================

function saveHistory() {

    const temp =
        dataFile + '.tmp';


    const fd =
        fs.openSync(
            temp,
            'w',
            0o600
        );


    try {

        fs.writeFileSync(
            fd,
            JSON.stringify({
                profiles,
                stats:
                    playerStats,
                directMessages:
                    directMessageStore,
                matches:
                    matchHistory
            })
        );


        fs.fsyncSync(fd);

    } finally {

        fs.closeSync(fd);
    }


    fs.renameSync(
        temp,
        dataFile
    );
}


// =========================================================
// PROFILE HELPERS
// =========================================================

function profileFor(username) {

    if (
        !profiles[
            username
        ]
    ) {

        profiles[
            username
        ] = {
            friends: [],
            requests: [],
            isOnline: true
        };
    }


    return profiles[
        username
    ];
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
        profileFor(
            username
        );


    for (
        const player of
        Object.values(
            connectedPlayers
        )
    ) {

        if (
            player.username !==
                username ||
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


// =========================================================
// BASIC HELPERS
// =========================================================

function escapeHTML(str) {

    if (!str) {
        return '';
    }


    return String(str)

        .replace(
            /&/g,
            '&amp;'
        )

        .replace(
            /</g,
            '&lt;'
        )

        .replace(
            />/g,
            '&gt;'
        )

        .replace(
            /"/g,
            '&quot;'
        )

        .replace(
            /'/g,
            '&#039;'
        );
}


function sanitizeUsername(name) {

    if (
        !name ||
        typeof name !==
            'string'
    ) {
        return 'Player';
    }


    const trimmed =
        name.trim();


    if (
        !trimmed ||
        trimmed
            .toLowerCase() ===
            'undefined' ||
        trimmed
            .toLowerCase() ===
            'null'
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


// =========================================================
// ORDINARY ROOM CODE PARSER
// Used by the existing 1v1 / 2v2 system.
// =========================================================

function extractSmashUrl(
    rawInput
) {

    if (!rawInput) {
        return null;
    }


    let text =
        String(
            rawInput
        )
            .trim()
            .replace(
                /['"]+/g,
                ''
            );


    if (
        /^ttps:\/\//i.test(
            text
        )
    ) {

        text =
            'h' + text;
    }


    const link =
        text.match(
            /https?:\/\/(?:www\.)?smashkarts\.io\/link\/\?[^\s]+/i
        );


    if (link) {
        return link[0];
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
        /^[A-Za-z0-9]+$/.test(
            text
        )
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


// =========================================================
// STRICTER ROOM CODE CHECK
//
// Used ONLY for the in-game PASTE CODE button.
//
// Random words / random URLs do not get sent.
// =========================================================

function extractVerifiedLookingRoomUrl(
    rawInput
) {

    if (!rawInput) {
        return null;
    }


    const text =
        String(
            rawInput
        )
            .trim()
            .replace(
                /['"]+/g,
                ''
            );


    function validCode(code) {

        return (
            typeof code ===
                'string' &&
            /^[A-Za-z0-9]{6,12}$/.test(
                code
            ) &&
            /[A-Za-z]/.test(
                code
            ) &&
            /\d/.test(
                code
            )
        );
    }


    // Bare code
    if (
        validCode(
            text
        )
    ) {

        return (
            'https://smashkarts.io/link/?room=' +
            encodeURIComponent(
                text
            )
        );
    }


    // Room: CODE
    const roomLabel =
        text.match(
            /^Room:\s*([A-Za-z0-9]+)$/i
        );


    if (
        roomLabel &&
        validCode(
            roomLabel[1]
        )
    ) {

        return (
            'https://smashkarts.io/link/?room=' +
            encodeURIComponent(
                roomLabel[1]
            )
        );
    }


    // Official Smash Karts link
    try {

        const url =
            new URL(
                text
            );


        const host =
            url.hostname
                .toLowerCase();


        if (
            host !==
                'smashkarts.io' &&
            host !==
                'www.smashkarts.io'
        ) {
            return null;
        }


        const code =
            url.searchParams.get(
                'room'
            );


        if (
            !validCode(
                code
            )
        ) {
            return null;
        }


        return (
            'https://smashkarts.io/link/?room=' +
            encodeURIComponent(
                code
            )
        );

    } catch {

        return null;
    }
}


function moderateText(text) {

    if (!text) {
        return '';
    }


    const banned = [
        'badword1',
        'badword2',
        'hate',
        'spam'
    ];


    let clean =
        String(text);


    for (
        const word of
        banned
    ) {

        clean =
            clean.replace(
                new RegExp(
                    `\\b${word}\\b`,
                    'gi'
                ),
                '***'
            );
    }


    return clean;
}


function getDMKey(
    a,
    b
) {

    return JSON.stringify(
        [
            a,
            b
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
                username ||
                ''
            )
                .toLowerCase()
    );
}


// =========================================================
// PUBLIC LOBBIES
// =========================================================

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
// DELETE ALL EMPTY LOBBIES
//
// This applies to:
// 1v1
// 2v2
// FFA
// public rooms
// friend rooms
//
// At 0 players the LIVE lobby disappears immediately.
// Saved history stays.
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

    const old =
        matchHistory[
            room.roomId
        ];


    if (!old) {
        return;
    }


    if (
        !Array.isArray(
            old.participants
        )
    ) {

        old.participants =
            [];
    }


    if (
        !old.participants.includes(
            username
        )
    ) {

        old.participants.push(
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
        // SESSION
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


                const player =
                    connectedPlayers[
                        socket.id
                    ];


                if (!player) {
                    return;
                }


                const username =
                    sanitizeUsername(
                        userData.username
                    );


                const profile =
                    profileFor(
                        username
                    );


                player.username =
                    username;


                player.email =
                    userData.email ||
                    null;


                player.isAuthenticated =
                    true;


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
                        username
                    ]
                ) {

                    playerStats[
                        username
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
                    !user.isAuthenticated ||
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


                const other =
                    profileFor(
                        challengerUsername
                    );


                if (
                    !other.friends.includes(
                        user.username
                    )
                ) {

                    other.friends.push(
                        user.username
                    );
                }


                other.requests =
                    other.requests.filter(
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


                const targetName =
                    sanitizeUsername(
                        targetUsername
                    );


                if (
                    !sender.friends.has(
                        targetName
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


                const key =
                    getDMKey(
                        sender.username,
                        targetName
                    );


                if (
                    !directMessageStore[
                        key
                    ]
                ) {

                    directMessageStore[
                        key
                    ] = [];
                }


                const msg = {

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
                    key
                ].push(
                    msg
                );


                saveHistory();


                const target =
                    findSocketByUsername(
                        targetName
                    );


                if (
                    target
                ) {

                    io.to(
                        target.id
                    ).emit(
                        'receive_direct_message',
                        {
                            senderSocketId:
                                socket.id,

                            senderUsername:
                                sender.username,

                            message:
                                msg.message,

                            history:
                                directMessageStore[
                                    key
                                ]
                        }
                    );
                }


                socket.emit(
                    'dm_sent_success',
                    {
                        targetUsername:
                            targetName,

                        history:
                            directMessageStore[
                                key
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


                const targetName =
                    sanitizeUsername(
                        targetUsername
                    );


                if (
                    !sender.friends.has(
                        targetName
                    )
                ) {
                    return;
                }


                const key =
                    getDMKey(
                        sender.username,
                        targetName
                    );


                socket.emit(
                    'load_dm_history',
                    {
                        targetUsername:
                            targetName,

                        history:
                            directMessageStore[
                                key
                            ] || []
                    }
                );
            }
        );


        // =================================================
        // MATCH STATS
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


                if (
                    player.username !==
                        'Player' &&
                    player.username !==
                        'Guest'
                ) {

                    playerStats[
                        player.username
                    ] =
                        (
                            playerStats[
                                player.username
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


                if (
                    !challenger
                ) {

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

                    participants:
                        [
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
        // CREATE NORMAL 1v1 / 2v2 ROOM
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


                const mode =
                    data.mode ===
                    '2v2'
                        ? '2v2'
                        : '1v1';


                const roomId =
                    crypto.randomUUID();


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
        // FFA LOBBIES
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


        // PLAY FFA joins an existing lobby.
        // It does NOT auto-create one.
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
                        r =>
                            r.mode ===
                                'ffa' &&
                            r.players.length <
                                r.maxPlayers
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


        // CREATE LOBBY creates a fresh FFA website lobby.
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

                    // Opens Smash Karts normally.
                    // A real room code can then be pasted from in-game.
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
        // PASTE CODE INTO CURRENT WEBSITE LOBBY
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
                        p =>
                            p.id ===
                            socket.id
                    )
                ) {

                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'You are not inside that lobby.'
                        }
                    );
                }


                const cleanUrl =
                    extractVerifiedLookingRoomUrl(
                        code
                    );


                if (!cleanUrl) {

                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'That does not look like a valid Smash Karts room code. Nothing was pasted.'
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


                const msg = {

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
                    msg
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
                    msg
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

    const users =
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
                users.length,

            users
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
// BROWSER-SIDE EXTRAS
//
// This automatically runs AFTER your existing script.js
// or script(1).js.
// =========================================================

function installArenaExtras() {


    // =====================================================
    // SAVED SETTINGS
    // =====================================================

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
                    )
                        .toLowerCase()

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
                    ) ||
                    '{}'
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


        const win =
            document.getElementById(
                'winCondition'
            );


        if (
            win
        ) {

            win.value =
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


        const dmHeader =
            document.getElementById(
                'activeDMChatHeader'
            );


        if (
            activeDMTargetUser &&
            dmHeader
        ) {

            dmHeader.textContent =
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
            e => {

                preferences.win =
                    e.target.value;


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
    // SAVED DMs / FRIENDS
    // =====================================================

    const originalOpenDM =
        openTabDMWith;


    openTabDMWith =
        function (username) {

            preferences.lastFriend =
                username;


            savePreferences();


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
                history ||
                []
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


    socket.on(
        'dm_sent_success',
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


    socket.on(
        'load_dm_history',
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
        username => {

            socket.emit(
                'accept_friend_request',
                {
                    challengerUsername:
                        username
                }
            );
        };


    joinPublicRoomById =
        roomId => {

            socket.emit(
                'join_public_room',
                {
                    roomId
                }
            );
        };


    // =====================================================
    // ROOM CHAT / ACTIVE PLAYERS
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
                messages ||
                []
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


    function extractRoomCode(
        url
    ) {

        const match =
            String(
                url ||
                ''
            ).match(
                /[?&]room=([A-Za-z0-9]+)/i
            );


        return match
            ? match[1]
            : '';
    }


    function refreshLobbyUI(
        room
    ) {

        if (
            !room
        ) {
            return;
        }


        ensureGameToolbarExtras();


        const players =
            Array.isArray(
                room.players
            )
                ? room.players
                : [];


        // =================================================
        // LIVE LOBBY COUNT
        // =================================================

        const count =
            document.getElementById(
                'gameLobbyPlayerCount'
            );


        if (
            count
        ) {

            count.textContent =
                `👥 ${players.length} IN LOBBY`;
        }


        // =================================================
        // PLAYER NAMES NEXT TO COUNT
        // =================================================

        const names =
            document.getElementById(
                'gameLobbyPlayerNames'
            );


        if (
            names
        ) {

            names.replaceChildren();


            const text =
                players.length
                    ? players
                        .map(
                            p =>
                                p.name
                        )
                        .join(
                            ', '
                        )

                    : 'No active players';


            names.textContent =
                text;


            names.title =
                text;
        }


        // Refresh the full players list
        // inside the Lobby page too.
        if (
            typeof updatePreGameLobbyUI ===
            'function'
        ) {

            updatePreGameLobbyUI(
                room
            );
        }


        const badge =
            document.getElementById(
                'gameModeBadge'
            );


        if (
            badge &&
            room.mode
        ) {

            badge.textContent =
                String(
                    room.mode
                ).toUpperCase();
        }


        const code =
            extractRoomCode(
                room.smashUrl
            );


        currentRoomCode =
            code;


        const codeDisplay =
            document.getElementById(
                'gameRoomCodeDisplay'
            );


        if (
            codeDisplay
        ) {

            codeDisplay.textContent =
                code ||
                (
                    room.mode ===
                    'ffa'
                        ? 'NOT SET'
                        : '------'
                );
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


                renderRoomMessages(
                    room.messages ||
                    []
                );


                refreshLobbyUI(
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


                const count =
                    document.getElementById(
                        'gameLobbyPlayerCount'
                    );


                if (
                    count
                ) {

                    count.textContent =
                        '👥 0 IN LOBBY';
                }


                const names =
                    document.getElementById(
                        'gameLobbyPlayerNames'
                    );


                if (
                    names
                ) {

                    names.textContent =
                        'No active players';
                }
            }
        }
    );


    socket.off(
        'receive_match_chat'
    );


    socket.on(
        'receive_match_chat',
        message => {

            if (
                !activeRoomData ||
                (
                    message.roomId &&
                    message.roomId !==
                        activeRoomData.roomId
                )
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
    // LOBBY WINDOW
    // =====================================================

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


            refreshLobbyUI(
                room
            );


            const title =
                document.querySelector(
                    '#preGameLobbyModal h3'
                );


            if (
                title
            ) {

                title.textContent =
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


            const gameScreen =
                document.getElementById(
                    'gameScreen'
                );


            if (
                playButton
            ) {

                playButton.textContent =
                    gameScreen &&
                    !gameScreen.classList.contains(
                        'hidden'
                    )
                        ? '🎮 BACK TO GAME'
                        : '🚀 JOIN GAME';
            }
        };


    // =====================================================
    // HISTORY
    // =====================================================

    const historyDialog =
        document.createElement(
            'dialog'
        );


    historyDialog.style.cssText =
        'width:min(720px,94vw);' +
        'max-height:85vh;' +
        'background:#173477;' +
        'color:white;' +
        'border:2px solid #ffd318;' +
        'border-radius:20px;' +
        'padding:20px;' +
        'overflow:auto';


    const historyClose =
        document.createElement(
            'button'
        );


    historyClose.textContent =
        '✕ Close history';


    historyClose.style.cssText =
        'float:right;' +
        'padding:8px;' +
        'color:#ffe238;' +
        'font-weight:bold';


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
        'font-size:20px;' +
        'font-weight:bold;' +
        'margin-bottom:20px';


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


    // Put History directly beside Logout.
    const mainHeader =
        document.querySelector(
            '#mainDashboard header'
        );


    if (
        mainHeader &&
        !document.getElementById(
            'headerHistoryButton'
        )
    ) {

        const logoutButton =
            mainHeader.querySelector(
                'button[onclick*="AuthSession.logout"]'
            );


        if (
            logoutButton
        ) {

            mainHeader.insertBefore(
                historyButton,
                logoutButton
            );

        } else {

            mainHeader.appendChild(
                historyButton
            );
        }
    }


    socket.on(
        'saved_match_history',
        rooms => {

            historyList.replaceChildren();


            if (
                !rooms.length
            ) {

                historyList.textContent =
                    'No saved matches yet.';
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
                    'padding:12px;' +
                    'margin-bottom:10px;' +
                    'background:#102653;' +
                    'border-radius:12px';


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
                        'margin-top:8px;' +
                        'overflow-wrap:anywhere';


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
    // FFA REAL PAGE
    //
    // This is NOT an overlay.
    // It uses the same center-page tab system as 1v1 / 2v2.
    // =====================================================

    function installFFATab() {

        const oneVOneButton =
            document.getElementById(
                'btnNav1v1'
            );


        const setupTab =
            document.getElementById(
                'setupTab'
            );


        if (
            !oneVOneButton ||
            !setupTab
        ) {
            return;
        }


        // ---------------------------------------------
        // SIDEBAR FFA BUTTON
        // ---------------------------------------------

        let ffaNav =
            document.getElementById(
                'btnNavFFA'
            );


        if (
            !ffaNav
        ) {

            ffaNav =
                document.createElement(
                    'button'
                );


            ffaNav.id =
                'btnNavFFA';


            ffaNav.type =
                'button';


            ffaNav.title =
                'FFA Matchmaking';


            ffaNav.textContent =
                '🔥';


            ffaNav.className =
                'sidebar-btn w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg';


            // Exact order:
            //
            // 🏆 Leaderboard
            // 🔥 FFA
            // 🎮 1v1
            // ⚔️ 2v2
            // 💬 Messages
            oneVOneButton
                .parentElement
                .insertBefore(
                    ffaNav,
                    oneVOneButton
                );
        }


        // ---------------------------------------------
        // FFA PAGE
        // ---------------------------------------------

        let ffaTab =
            document.getElementById(
                'ffaTab'
            );


        if (
            !ffaTab
        ) {

            ffaTab =
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
                            Join an open FFA lobby or create a new one
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


                <div class="space-y-4">

                    <button
                        id="ffaPlayButton"
                        type="button"
                        class="btn-smash w-full py-4 rounded-2xl font-bungee text-xl text-white"
                    >
                        🔥 PLAY FFA
                    </button>


                    <button
                        id="ffaCreateButton"
                        type="button"
                        class="bg-emerald-500 hover:bg-emerald-400 w-full py-4 rounded-2xl font-bungee text-xl text-white shadow-lg"
                    >
                        + CREATE LOBBY
                    </button>

                </div>


                <div class="bg-blue-900/60 border border-white/10 rounded-2xl p-4">

                    <p class="text-xs text-blue-100 leading-relaxed">

                        PLAY FFA joins an existing FFA lobby.

                        CREATE LOBBY makes a new one.

                        Once you are playing, use

                        <strong class="text-yellow-300">
                            PASTE CODE
                        </strong>

                        in the blue game bar to share the Smash Karts room code.

                    </p>

                </div>
            `;


            setupTab
                .parentElement
                .insertBefore(
                    ffaTab,
                    setupTab
                );
        }


        // ---------------------------------------------
        // SHOW FFA PAGE
        // ---------------------------------------------

        ffaNav.onclick =
            () => {

                document
                    .querySelectorAll(
                        '.tab-content'
                    )
                    .forEach(
                        el =>
                            el.classList.add(
                                'hidden'
                            )
                    );


                document
                    .querySelectorAll(
                        '.sidebar-btn'
                    )
                    .forEach(
                        btn =>
                            btn.classList.remove(
                                'active'
                            )
                    );


                ffaNav.classList.add(
                    'active'
                );


                ffaTab.classList.remove(
                    'hidden'
                );
            };


        const play =
            document.getElementById(
                'ffaPlayButton'
            );


        const create =
            document.getElementById(
                'ffaCreateButton'
            );


        const publicBtn =
            document.getElementById(
                'ffaPublicLobbyButton'
            );


        if (
            publicBtn
        ) {

            publicBtn.onclick =
                () =>
                    openFindGameModal();
        }


        function requireUser() {

            if (
                AuthSession.getUser()
            ) {
                return true;
            }


            const modal =
                document.getElementById(
                    'authModal'
                );


            if (
                modal
            ) {

                modal.classList.remove(
                    'hidden'
                );
            }


            return false;
        }


        if (
            play
        ) {

            play.onclick =
                () => {

                    if (
                        !requireUser()
                    ) {
                        return;
                    }


                    if (
                        !socket.connected
                    ) {

                        return showToast(
                            'Connecting to the server. Try again in a moment.',
                            'ℹ️'
                        );
                    }


                    socket.emit(
                        'play_ffa'
                    );
                };
        }


        if (
            create
        ) {

            create.onclick =
                () => {

                    if (
                        !requireUser()
                    ) {
                        return;
                    }


                    if (
                        !socket.connected
                    ) {

                        return showToast(
                            'Connecting to the server. Try again in a moment.',
                            'ℹ️'
                        );
                    }


                    socket.emit(
                        'create_ffa_lobby'
                    );
                };
        }
    }


    installFFATab();


    socket.on(
        'ffa_no_lobby',
        data => {

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
        'ffa_lobby_ready',
        room => {

            activeRoomData =
                room;


            renderRoomMessages(
                room.messages ||
                []
            );


            refreshLobbyUI(
                room
            );


            // Show the website lobby first.
            // Do not instantly enter the game.
            openPreGameLobby(
                room
            );
        }
    );


    // =====================================================
    // VALIDATE CODE IN BROWSER BEFORE SENDING
    // =====================================================

    function clientValidRoomCode(
        raw
    ) {

        if (!raw) {
            return null;
        }


        const text =
            String(
                raw
            )
                .trim()
                .replace(
                    /['"]+/g,
                    ''
                );


        function valid(code) {

            return (
                /^[A-Za-z0-9]{6,12}$/.test(
                    code ||
                    ''
                ) &&
                /[A-Za-z]/.test(
                    code
                ) &&
                /\d/.test(
                    code
                )
            );
        }


        if (
            valid(
                text
            )
        ) {
            return text;
        }


        const roomLabel =
            text.match(
                /^Room:\s*([A-Za-z0-9]+)$/i
            );


        if (
            roomLabel &&
            valid(
                roomLabel[1]
            )
        ) {

            return roomLabel[1];
        }


        try {

            const url =
                new URL(
                    text
                );


            const host =
                url.hostname
                    .toLowerCase();


            if (
                host !==
                    'smashkarts.io' &&
                host !==
                    'www.smashkarts.io'
            ) {

                return null;
            }


            const code =
                url.searchParams.get(
                    'room'
                );


            return valid(
                code
            )
                ? code
                : null;

        } catch {

            return null;
        }
    }


    // =====================================================
    // PASTE CODE BUTTON
    // =====================================================

    function promptPasteCode() {

        if (
            !activeRoomData
        ) {

            return showToast(
                'You are not currently in a lobby.',
                '⚠️'
            );
        }


        const pasted =
            window.prompt(
                'Paste a Smash Karts room code or official room link:'
            );


        if (
            pasted ===
            null
        ) {
            return;
        }


        const code =
            clientValidRoomCode(
                pasted
            );


        if (!code) {

            showToast(
                'That does not look like a Smash Karts room code. Nothing was pasted.',
                '❌'
            );


            return;
        }


        socket.emit(
            'update_lobby_game_code',
            {
                roomId:
                    activeRoomData.roomId,

                code
            }
        );
    }


    // =====================================================
    // LOBBY BUTTON
    // =====================================================

    function openCurrentLobby() {

        if (
            !activeRoomData
        ) {

            return showToast(
                'You are not currently in a lobby.',
                '⚠️'
            );
        }


        openPreGameLobby(
            activeRoomData
        );
    }


    // =====================================================
    // GAME TOOLBAR
    //
    // LEFT:
    //
    // 🎮 SMASH KARTS | FFA | 👥 3 IN LOBBY | Player1, Player2
    //
    // RIGHT:
    //
    // 📋 PASTE CODE | 👥 LOBBY | 💬 SHOW CHAT | ⚙️ OPTIONS
    //
    // =====================================================

    function ensureGameToolbarExtras() {

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
            !toolbar ||
            !brand ||
            !chatButton
        ) {
            return;
        }


        // =================================================
        // LEFT-SIDE LOBBY INFO
        // =================================================

        let lobbyInfo =
            document.getElementById(
                'gameLobbyInfo'
            );


        if (
            !lobbyInfo
        ) {

            lobbyInfo =
                document.createElement(
                    'div'
                );


            lobbyInfo.id =
                'gameLobbyInfo';


            lobbyInfo.style.cssText =
                'display:flex;' +
                'align-items:center;' +
                'gap:8px;' +
                'min-width:0;' +
                'max-width:48vw;' +
                'background:#102653;' +
                'border:1px solid #ffffff30;' +
                'border-radius:18px;' +
                'padding:7px 11px;';


            const count =
                document.createElement(
                    'span'
                );


            count.id =
                'gameLobbyPlayerCount';


            count.textContent =
                '👥 0 IN LOBBY';


            count.style.cssText =
                'font:900 12px sans-serif;' +
                'color:#ffe238;' +
                'white-space:nowrap;';


            const names =
                document.createElement(
                    'span'
                );


            names.id =
                'gameLobbyPlayerNames';


            names.textContent =
                'No active players';


            names.style.cssText =
                'font:800 11px sans-serif;' +
                'color:white;' +
                'white-space:nowrap;' +
                'overflow:hidden;' +
                'text-overflow:ellipsis;';


            lobbyInfo.append(
                count,
                names
            );


            brand.appendChild(
                lobbyInfo
            );
        }


        // =================================================
        // PASTE CODE BUTTON
        // =================================================

        let paste =
            document.getElementById(
                'gamePasteCodeButton'
            );


        if (
            !paste
        ) {

            paste =
                document.createElement(
                    'button'
                );


            paste.id =
                'gamePasteCodeButton';


            paste.type =
                'button';


            paste.className =
                'game-control';


            paste.textContent =
                '📋 PASTE CODE';


            paste.onclick =
                promptPasteCode;
        }


        // =================================================
        // LOBBY BUTTON
        // =================================================

        let lobby =
            document.getElementById(
                'gameLobbyButton'
            );


        if (
            !lobby
        ) {

            lobby =
                document.createElement(
                    'button'
                );


            lobby.id =
                'gameLobbyButton';


            lobby.type =
                'button';


            lobby.className =
                'game-control';


            lobby.textContent =
                '👥 LOBBY';


            lobby.onclick =
                openCurrentLobby;
        }


        // =================================================
        // FORCE EXACT BUTTON ORDER
        //
        // PASTE CODE
        // LOBBY
        // SHOW CHAT
        // OPTIONS
        // =================================================

        toolbar.insertBefore(
            paste,
            chatButton
        );


        toolbar.insertBefore(
            lobby,
            chatButton
        );


        // =================================================
        // MOVE SHOW / HIDE MENU A LITTLE LEFT
        // Original = right:22px
        // New = right:32px
        // =================================================

        const menuToggle =
            document.getElementById(
                'gameToolbarToggle'
            );


        if (
            menuToggle
        ) {

            menuToggle.style.right =
                '32px';
        }
    }


    // Install now.
    ensureGameToolbarExtras();


    // Keep forcing the buttons back in if any other code
    // changes/re-renders the blue top toolbar.
    const toolbarObserver =
        new MutationObserver(
            () => {

                ensureGameToolbarExtras();


                if (
                    activeRoomData
                ) {

                    refreshLobbyUI(
                        activeRoomData
                    );
                }
            }
        );


    toolbarObserver.observe(
        document.body,
        {
            childList: true,
            subtree: true
        }
    );


    // =====================================================
    // OPEN LOBBY WHILE PLAYING
    //
    // Clicking LOBBY does not restart the game.
    //
    // When you click BACK TO GAME in the lobby,
    // it simply closes the lobby window.
    // =====================================================

    const originalEnterGame =
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


                ensureGameToolbarExtras();


                if (
                    activeRoomData
                ) {

                    refreshLobbyUI(
                        activeRoomData
                    );
                }


                return;
            }


            const result =
                originalEnterGame.apply(
                    this,
                    args
                );


            ensureGameToolbarExtras();


            if (
                activeRoomData
            ) {

                refreshLobbyUI(
                    activeRoomData
                );
            }


            requestAnimationFrame(
                () => {

                    ensureGameToolbarExtras();


                    if (
                        activeRoomData
                    ) {

                        refreshLobbyUI(
                            activeRoomData
                        );
                    }
                }
            );


            return result;
        };


    // =====================================================
    // LOBBY GAME CODE UPDATED
    // =====================================================

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


            refreshLobbyUI(
                activeRoomData
            );


            const code =
                extractRoomCode(
                    data.smashUrl
                );


            showToast(
                code
                    ? `Lobby code set to ${code}.`
                    : 'Lobby game link updated.',
                '📋'
            );
        }
    );


    // Make floating match chat say Lobby Chat.
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


    restorePreferences();
}