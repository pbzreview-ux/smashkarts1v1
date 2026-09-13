const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*'
    }
});


// =========================================================
// SERVE SCRIPT.JS + EXTRA FEATURES
// =========================================================

app.get('/script.js', (req, res) => {

    const filename = [
        'script.js',
        'script(1).js'
    ].find(name =>
        fs.existsSync(
            path.join(
                __dirname,
                name
            )
        )
    );


    if (!filename) {

        return res
            .status(404)
            .send(
                'Missing script.js'
            );
    }


    res
        .type(
            'application/javascript'
        )
        .send(

            fs.readFileSync(
                path.join(
                    __dirname,
                    filename
                ),
                'utf8'
            )

            +

            '\n;(' +
            installArenaExtras.toString() +
            ')();'
        );
});


// =========================================================
// STATIC FILES
// =========================================================

app.use(
    (req, res, next) => {

        if (
            /^\/data(?:\/|$)/i.test(
                req.path
            )
        ) {

            return res.sendStatus(
                404
            );
        }


        if (
            req.path === '/' ||

            /\.(html|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|mp3|mp4)$/i
                .test(
                    req.path
                )
        ) {

            return next();
        }


        res.sendStatus(
            404
        );
    }
);


app.use(
    express.static(
        __dirname
    )
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

        ?

        JSON.parse(
            fs.readFileSync(
                dataFile,
                'utf8'
            )
        )

        :

        {
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
// SAVE EVERYTHING
// =========================================================

function saveHistory() {

    const temp =
        dataFile +
        '.tmp';


    fs.writeFileSync(
        temp,

        JSON.stringify({
            profiles,
            stats: playerStats,
            directMessages:
                directMessageStore,
            matches:
                matchHistory
        }),

        {
            mode: 0o600
        }
    );


    fs.renameSync(
        temp,
        dataFile
    );
}


// =========================================================
// PROFILE HELPERS
// =========================================================

function profileFor(
    username
) {

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


function savePlayer(
    player
) {

    const profile =
        profileFor(
            player.username
        );


    profile.friends =
        [
            ...player.friends
        ];


    profile.requests =
        [
            ...player.friendRequests
        ];


    profile.isOnline =
        player.isOnline;
}


function syncFriends(
    username
) {

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


        io
            .to(
                player.id
            )
            .emit(
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
// HELPERS
// =========================================================

function escapeHTML(
    str
) {

    return String(
        str || ''
    )

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


function sanitizeUsername(
    name
) {

    const text =
        typeof name ===
        'string'

            ?

            name.trim()

            :

            '';


    if (
        !text ||

        /^(undefined|null)$/i.test(
            text
        )
    ) {

        return 'Player';
    }


    return escapeHTML(
        text.slice(
            0,
            20
        )
    );
}


// =========================================================
// NORMAL ROOM LINK PARSER
// =========================================================

function extractSmashUrl(
    raw
) {

    if (!raw) {

        return null;
    }


    let text =
        String(
            raw
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
            'h' +
            text;
    }


    const link =
        text.match(
            /https?:\/\/(?:www\.)?smashkarts\.io\/link\/\?[^\s]+/i
        );


    if (link) {

        return link[0];
    }


    const roomLabel =
        text.match(
            /Room:\s*([A-Za-z0-9]+)/i
        );


    if (
        roomLabel
    ) {

        return (

            'https://smashkarts.io/link/?room=' +

            encodeURIComponent(
                roomLabel[1]
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
// STRICT PASTE-CODE CHECK
// =========================================================

function strictSmashUrl(
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


    function validCode(
        code
    ) {

        return (

            typeof code ===
                'string'

            &&

            /^[A-Za-z0-9]{6,12}$/.test(
                code
            )

            &&

            /[A-Za-z]/.test(
                code
            )

            &&

            /\d/.test(
                code
            )
        );
    }


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


    try {

        const url =
            new URL(
                text
            );


        const host =
            url.hostname
                .toLowerCase();


        const code =
            url.searchParams
                .get(
                    'room'
                );


        if (
            (
                host ===
                    'smashkarts.io'

                ||

                host ===
                    'www.smashkarts.io'
            )

            &&

            validCode(
                code
            )
        ) {

            return (

                'https://smashkarts.io/link/?room=' +

                encodeURIComponent(
                    code
                )
            );
        }

    } catch {}


    return null;
}


function moderateText(
    text
) {

    let clean =
        String(
            text || ''
        );


    for (
        const word of
        [
            'badword1',
            'badword2',
            'hate',
            'spam'
        ]
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

    const target =
        String(
            username || ''
        ).toLowerCase();


    return Object.values(
        connectedPlayers
    ).find(
        player =>
            player.username
                .toLowerCase() ===
            target
    );
}


// =========================================================
// PUBLIC LOBBIES
// =========================================================

function broadcastPublicRooms() {

    const rooms =
        [
            ...activeRoomsMap
                .values()
        ]

            .map(
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
        rooms
    );
}


// =========================================================
// MATCH HISTORY PARTICIPANTS
// =========================================================

function addParticipant(
    room,
    username
) {

    const history =
        matchHistory[
            room.roomId
        ];


    if (!history) {

        return;
    }


    if (
        !Array.isArray(
            history.participants
        )
    ) {

        history.participants =
            [];
    }


    if (
        !history.participants.includes(
            username
        )
    ) {

        history.participants.push(
            username
        );
    }
}


// =========================================================
// LEAVE A LOBBY
//
// EVERY lobby is deleted as soon as it reaches 0 players.
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

        io
            .to(
                roomId
            )
            .emit(
                'saved_room_update',
                room
            );
    }


    broadcastPublicRooms();
}


function leaveAllRoomsExcept(
    socket,
    keepId = null
) {

    for (
        const roomId of
        [
            ...activeRoomsMap
                .keys()
        ]
    ) {

        if (
            roomId !==
            keepId
        ) {

            leaveLiveRoom(
                socket,
                roomId
            );
        }
    }
}


// =========================================================
// SOCKET SERVER
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


                player.isOnline =
                    profile.isOnline;


                player.friends =
                    new Set(
                        profile.friends
                    );


                player.friendRequests =
                    new Set(
                        profile.requests
                    );


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
                    [
                        ...player.friendRequests
                    ]
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
            online => {

                const player =
                    connectedPlayers[
                        socket.id
                    ];


                if (!player) {

                    return;
                }


                player.isOnline =
                    !!online;


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
                    !target.isAuthenticated ||
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


                io
                    .to(
                        targetSocketId
                    )
                    .emit(
                        'receive_friend_request',
                        {
                            fromSocketId:
                                socket.id,

                            fromUsername:
                                sender.username
                        }
                    );


                io
                    .to(
                        targetSocketId
                    )
                    .emit(
                        'friend_requests_update',
                        [
                            ...target.friendRequests
                        ]
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
                    [
                        ...user.friendRequests
                    ]
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


                    io
                        .to(
                            challenger.id
                        )
                        .emit(
                            'friend_request_accepted',
                            {
                                username:
                                    user.username
                            }
                        );
                }


                socket.emit(
                    'friend_requests_update',
                    [
                        ...user.friendRequests
                    ]
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


                const messageObject = {

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
                    messageObject
                );


                saveHistory();


                const target =
                    findSocketByUsername(
                        targetName
                    );


                if (
                    target
                ) {

                    io
                        .to(
                            target.id
                        )
                        .emit(
                            'receive_direct_message',
                            {
                                senderSocketId:
                                    socket.id,

                                senderUsername:
                                    sender.username,

                                message:
                                    messageObject.message,

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


                socket.emit(
                    'load_dm_history',
                    {
                        targetUsername:
                            targetName,

                        history:
                            directMessageStore[
                                getDMKey(
                                    sender.username,
                                    targetName
                                )
                            ] || []
                    }
                );
            }
        );


        // =================================================
        // RECORD GAME
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
                    !player.isAuthenticated ||
                    [
                        'Player',
                        'Guest'
                    ].includes(
                        player.username
                    )
                ) {

                    return;
                }


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
        );


        // =================================================
        // FRIEND CHALLENGE
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

                        ?

                        connectedPlayers[
                            targetSocketId
                        ]

                        :

                        findSocketByUsername(
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


                io
                    .to(
                        target.id
                    )
                    .emit(
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


                const challenger =
                    connectedPlayers[
                        challengerSocketId
                    ];


                if (
                    !cleanUrl ||
                    !challenger
                ) {

                    return socket.emit(
                        'room_error',
                        {
                            message:
                                'That challenge is no longer valid.'
                        }
                    );
                }


                leaveAllRoomsExcept(
                    socket
                );


                const challengerSocket =
                    io.sockets.sockets.get(
                        challengerSocketId
                    );


                if (
                    challengerSocket
                ) {

                    leaveAllRoomsExcept(
                        challengerSocket
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
                                    player =>
                                        player.name
                                )
                            )
                        ]
                };


                socket.join(
                    roomId
                );


                if (
                    challengerSocket
                ) {

                    challengerSocket.join(
                        roomId
                    );
                }


                saveHistory();


                io
                    .to(
                        roomId
                    )
                    .emit(
                        'challenge_game_start',
                        room
                    );


                broadcastPublicRooms();
            }
        );


        // =================================================
        // CREATE NORMAL 1V1 / 2V2
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
                                'A valid Smash Karts room link or code is required!'
                        }
                    );
                }


                leaveAllRoomsExcept(
                    socket
                );


                const mode =
                    data.mode ===
                    '2v2'

                        ?

                        '2v2'

                        :

                        '1v1';


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

                            ?

                            4

                            :

                            2,

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


                socket.join(
                    roomId
                );


                saveHistory();


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
        // JOIN FFA ROOM
        // =================================================

        function joinFFARoom(
            room,
            player
        ) {

            leaveAllRoomsExcept(
                socket,
                room.roomId
            );


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
                                'That FFA lobby is full.'
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


            addParticipant(
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


            io
                .to(
                    room.roomId
                )
                .emit(
                    'saved_room_update',
                    room
                );


            broadcastPublicRooms();
        }


        // =================================================
        // PLAY FFA
        // =================================================

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
                    [
                        ...activeRoomsMap
                            .values()
                    ].find(
                        room =>
                            room.mode ===
                                'ffa'

                            &&

                            room.players.length <
                                room.maxPlayers
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


        // =================================================
        // CREATE FFA LOBBY
        // =================================================

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


                leaveAllRoomsExcept(
                    socket
                );


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
        // UPDATE / PASTE ROOM CODE
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
                    !room ||
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
                                'You are not inside that lobby.'
                        }
                    );
                }


                const cleanUrl =
                    strictSmashUrl(
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

                    Object.assign(
                        matchHistory[
                            roomId
                        ],
                        {
                            smashUrl:
                                cleanUrl,

                            gameCodeUpdatedBy:
                                player.username,

                            gameCodeUpdatedAt:
                                room.gameCodeUpdatedAt
                        }
                    );
                }


                saveHistory();


                io
                    .to(
                        roomId
                    )
                    .emit(
                        'saved_room_update',
                        room
                    );


                io
                    .to(
                        roomId
                    )
                    .emit(
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
                    ) ||
                    typeof message !==
                        'string' ||
                    !message.trim()
                ) {

                    return;
                }


                const messageObject = {

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
                    messageObject
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


                io
                    .to(
                        roomId
                    )
                    .emit(
                        'receive_match_chat',
                        messageObject
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
                                Array.isArray(
                                    room.participants
                                )

                                &&

                                room.participants.includes(
                                    player.username
                                )
                        )

                        .sort(
                            (a, b) =>
                                (
                                    b.createdAt ||
                                    0
                                )

                                -

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


                leaveAllRoomsExcept(
                    socket,
                    roomId
                );


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


                addParticipant(
                    room,
                    player.username
                );


                socket.join(
                    roomId
                );


                saveHistory();


                socket.emit(

                    room.mode ===
                    'ffa'

                        ?

                        'ffa_lobby_ready'

                        :

                        'room_created',

                    room
                );


                io
                    .to(
                        roomId
                    )
                    .emit(
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
                    [
                        ...activeRoomsMap
                            .keys()
                    ]
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
                        [
                            ...player.friends
                        ]
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
                player =>
                    ![
                        'Player',
                        'Guest'
                    ].includes(
                        player.username
                    )
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
// BROWSER ADDITIONS
// =========================================================

function installArenaExtras() {


    // =====================================================
    // MOST IMPORTANT PART:
    // INSTALL PLAYER COUNT + LOBBY BUTTON FIRST
    //
    // This runs before everything else.
    // =====================================================

    function installCoreLobbyUI() {

        const brand =
            document.querySelector(
                '.game-brand'
            );


        const actions =
            document.querySelector(
                '.game-actions'
            );


        const chatButton =
            document.getElementById(
                'gameChatToggle'
            );


        if (
            !brand ||
            !actions ||
            !chatButton
        ) {

            return false;
        }


        // =================================================
        // PLAYER COUNT ON LEFT SIDE
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
                'background:#102653;' +
                'border:1px solid #ffffff38;' +
                'border-radius:18px;' +
                'padding:7px 11px;' +
                'max-width:46vw;' +
                'min-width:0;';


            const count =
                document.createElement(
                    'span'
                );


            count.id =
                'gameLobbyPlayerCount';


            count.textContent =
                '👥 0 IN LOBBY';


            count.style.cssText =
                'color:#ffe238;' +
                'font:900 12px sans-serif;' +
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
                'color:white;' +
                'font:800 11px sans-serif;' +
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

        let pasteButton =
            document.getElementById(
                'gamePasteCodeButton'
            );


        if (
            !pasteButton
        ) {

            pasteButton =
                document.createElement(
                    'button'
                );


            pasteButton.id =
                'gamePasteCodeButton';


            pasteButton.type =
                'button';


            pasteButton.className =
                'game-control';


            pasteButton.textContent =
                '📋 PASTE CODE';


            pasteButton.onclick =
                () => {

                    if (
                        !activeRoomData
                    ) {

                        return showToast(
                            'You are not currently in a lobby.',
                            '⚠️'
                        );
                    }


                    const raw =
                        window.prompt(
                            'Paste a Smash Karts room code or official room link:'
                        );


                    if (
                        raw ===
                        null
                    ) {

                        return;
                    }


                    const code =
                        clientValidRoomCode(
                            raw
                        );


                    if (!code) {

                        return showToast(
                            'That is not a valid-looking Smash Karts room code. Nothing was pasted.',
                            '❌'
                        );
                    }


                    socket.emit(
                        'update_lobby_game_code',
                        {
                            roomId:
                                activeRoomData.roomId,

                            code
                        }
                    );
                };
        }


        // =================================================
        // LOBBY BUTTON
        // =================================================

        let lobbyButton =
            document.getElementById(
                'gameLobbyButton'
            );


        if (
            !lobbyButton
        ) {

            lobbyButton =
                document.createElement(
                    'button'
                );


            lobbyButton.id =
                'gameLobbyButton';


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

                        return showToast(
                            'You are not currently in a lobby.',
                            '⚠️'
                        );
                    }


                    openPreGameLobby(
                        activeRoomData
                    );
                };
        }


        // =================================================
        // EXACT ORDER
        //
        // PASTE CODE | LOBBY | SHOW CHAT | OPTIONS
        // =================================================

        if (
            pasteButton.parentElement !==
                actions

            ||

            pasteButton.nextElementSibling !==
                lobbyButton

            ||

            lobbyButton.nextElementSibling !==
                chatButton
        ) {

            actions.insertBefore(
                pasteButton,
                chatButton
            );


            actions.insertBefore(
                lobbyButton,
                chatButton
            );
        }


        // Move Show/Hide Menu slightly left.
        const toggle =
            document.getElementById(
                'gameToolbarToggle'
            );


        if (
            toggle
        ) {

            toggle.style.right =
                '32px';
        }


        return true;
    }


    // =====================================================
    // VALIDATE CODE IN BROWSER
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


        function valid(
            code
        ) {

            return (

                /^[A-Za-z0-9]{6,12}$/.test(
                    code || ''
                )

                &&

                /[A-Za-z]/.test(
                    code
                )

                &&

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


            const code =
                url.searchParams.get(
                    'room'
                );


            return (

                (
                    host ===
                        'smashkarts.io'

                    ||

                    host ===
                        'www.smashkarts.io'
                )

                &&

                valid(
                    code
                )
            )

                ?

                code

                :

                null;

        } catch {

            return null;
        }
    }


    function extractRoomCode(
        url
    ) {

        const match =
            String(
                url || ''
            ).match(
                /[?&]room=([A-Za-z0-9]+)/i
            );


        return match

            ?

            match[1]

            :

            '';
    }


    // =====================================================
    // LIVE PLAYER COUNT + PLAYER NAMES
    // =====================================================

    function refreshLobbyUI(
        room
    ) {

        installCoreLobbyUI();


        if (!room) {

            return;
        }


        const players =
            Array.isArray(
                room.players
            )

                ?

                room.players

                :

                [];


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


        const names =
            document.getElementById(
                'gameLobbyPlayerNames'
            );


        if (
            names
        ) {

            const text =
                players.length

                    ?

                    players
                        .map(
                            player =>
                                player.name
                        )
                        .join(
                            ', '
                        )

                    :

                    'No active players';


            names.textContent =
                text;


            names.title =
                text;
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

                        ?

                        'NOT SET'

                        :

                        '------'
                );
        }


        const lobbyModal =
            document.getElementById(
                'preGameLobbyModal'
            );


        if (
            lobbyModal &&
            !lobbyModal.classList.contains(
                'hidden'
            ) &&
            typeof updatePreGameLobbyUI ===
                'function'
        ) {

            updatePreGameLobbyUI(
                room
            );
        }
    }


    // Install the toolbar controls immediately.
    installCoreLobbyUI();


    document.addEventListener(
        'DOMContentLoaded',
        installCoreLobbyUI
    );


    // SAFE CHECK.
    // No MutationObserver.
    setInterval(
        () => {

            const game =
                document.getElementById(
                    'gameScreen'
                );


            if (
                game &&
                !game.classList.contains(
                    'hidden'
                )
            ) {

                installCoreLobbyUI();
            }

        },
        1000
    );


    // =====================================================
    // ROOM UPDATE EVENTS
    // =====================================================

    socket.on(
        'saved_room_update',
        room => {

            if (
                !activeRoomData ||
                activeRoomData.roomId !==
                    room.roomId
            ) {

                return;
            }


            activeRoomData =
                room;


            refreshLobbyUI(
                room
            );


            renderRoomMessages(
                room.messages ||
                []
            );
        }
    );


    socket.on(
        'lobby_deleted',
        ({
            roomId
        }) => {

            if (
                !activeRoomData ||
                activeRoomData.roomId !==
                    roomId
            ) {

                return;
            }


            activeRoomData =
                null;


            const count =
                document.getElementById(
                    'gameLobbyPlayerCount'
                );


            const names =
                document.getElementById(
                    'gameLobbyPlayerNames'
                );


            if (
                count
            ) {

                count.textContent =
                    '👥 0 IN LOBBY';
            }


            if (
                names
            ) {

                names.textContent =
                    'No active players';
            }
        }
    );


    // =====================================================
    // ROOM CHAT
    // =====================================================

    function renderRoomMessages(
        messages
    ) {

        for (
            const id of
            [
                'matchChatMessages',
                'preGameChatMessages'
            ]
        ) {

            const box =
                document.getElementById(
                    id
                );


            if (!box) {

                continue;
            }


            box.replaceChildren();


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
                    `${message.senderName}: ${message.message}`;


                box.appendChild(
                    row
                );
            }


            box.scrollTop =
                box.scrollHeight;
        }
    }


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
    // OPEN THE LOBBY
    // =====================================================

    const originalOpenLobby =
        openPreGameLobby;


    openPreGameLobby =
        function (
            room
        ) {

            originalOpenLobby(
                room
            );


            refreshLobbyUI(
                room
            );


            renderRoomMessages(
                room.messages ||
                []
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

                        ?

                        '👥 FFA LOBBY'

                        :

                        '👥 MATCH LOBBY';
            }


            const headings =
                document.querySelectorAll(
                    '#preGameLobbyModal h4'
                );


            if (
                headings[0]
            ) {

                headings[
                    0
                ].textContent =
                    `👥 ACTIVE PLAYERS (${(room.players || []).length})`;
            }


            if (
                headings[1]
            ) {

                headings[
                    1
                ].textContent =
                    '💬 LOBBY CHAT';
            }


            const joinButton =
                document.querySelector(
                    '#preGameLobbyModal button[onclick="enterGameFromLobby()"]'
                );


            const game =
                document.getElementById(
                    'gameScreen'
                );


            if (
                joinButton
            ) {

                joinButton.textContent =

                    game &&
                    !game.classList.contains(
                        'hidden'
                    )

                        ?

                        '🎮 BACK TO GAME'

                        :

                        '🚀 JOIN GAME';
            }
        };


    // =====================================================
    // ENTER / RETURN TO GAME
    // =====================================================

    const originalEnterGame =
        enterGameFromLobby;


    enterGameFromLobby =
        function (
            ...args
        ) {

            const game =
                document.getElementById(
                    'gameScreen'
                );


            // Already playing.
            // Just close the lobby window.
            if (
                game &&
                !game.classList.contains(
                    'hidden'
                ) &&
                !game.classList.contains(
                    'game-fade-exit'
                )
            ) {

                closePreGameLobbyModal();


                installCoreLobbyUI();


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


            installCoreLobbyUI();


            if (
                activeRoomData
            ) {

                refreshLobbyUI(
                    activeRoomData
                );
            }


            requestAnimationFrame(
                () => {

                    installCoreLobbyUI();


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
    // CODE UPDATED
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


            refreshLobbyUI(
                activeRoomData
            );


            showToast(

                `Lobby code set to ${extractRoomCode(data.smashUrl) || 'new code'}.`,

                '📋'
            );
        }
    );


    // =====================================================
    // FFA PAGE
    // REAL PAGE LIKE 1V1 / 2V2
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
            !setupTab ||
            document.getElementById(
                'btnNavFFA'
            )
        ) {

            return;
        }


        const ffaNav =
            document.createElement(
                'button'
            );


        ffaNav.id =
            'btnNavFFA';


        ffaNav.type =
            'button';


        ffaNav.title =
            'FFA';


        ffaNav.textContent =
            '🔥';


        ffaNav.className =
            'sidebar-btn w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-lg';


        oneVOneButton
            .parentElement
            .insertBefore(
                ffaNav,
                oneVOneButton
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

            <div class="flex justify-between items-center border-b border-white/10 pb-4">

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
                    class="text-xs bg-emerald-500 hover:bg-emerald-400 text-white font-black px-5 py-2.5 rounded-xl uppercase"
                >
                    🔍 Public Lobbies
                </button>

            </div>


            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">

                <button
                    id="ffaPlayButton"
                    class="btn-smash w-full py-4 rounded-2xl font-bungee text-xl text-white"
                >
                    🔥 PLAY FFA
                </button>


                <button
                    id="ffaCreateButton"
                    class="bg-emerald-500 hover:bg-emerald-400 w-full py-4 rounded-2xl font-bungee text-xl text-white shadow-lg"
                >
                    + CREATE LOBBY
                </button>

            </div>
        `;


        setupTab
            .parentElement
            .insertBefore(
                ffaTab,
                setupTab
            );


        ffaNav.onclick =
            () => {

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


                ffaNav.classList.add(
                    'active'
                );


                ffaTab.classList.remove(
                    'hidden'
                );
            };


        ffaTab
            .querySelector(
                '#ffaPublicLobbyButton'
            )
            .onclick =
                () =>
                    openFindGameModal();


        ffaTab
            .querySelector(
                '#ffaPlayButton'
            )
            .onclick =
                () => {

                    if (
                        !AuthSession.getUser()
                    ) {

                        return document
                            .getElementById(
                                'authModal'
                            )
                            ?.classList
                            .remove(
                                'hidden'
                            );
                    }


                    socket.emit(
                        'play_ffa'
                    );
                };


        ffaTab
            .querySelector(
                '#ffaCreateButton'
            )
            .onclick =
                () => {

                    if (
                        !AuthSession.getUser()
                    ) {

                        return document
                            .getElementById(
                                'authModal'
                            )
                            ?.classList
                            .remove(
                                'hidden'
                            );
                    }


                    socket.emit(
                        'create_ffa_lobby'
                    );
                };
    }


    installFFATab();


    document.addEventListener(
        'DOMContentLoaded',
        installFFATab
    );


    socket.on(
        'ffa_no_lobby',
        data => {

            showToast(
                data?.message ||
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


            installCoreLobbyUI();


            refreshLobbyUI(
                room
            );


            renderRoomMessages(
                room.messages ||
                []
            );


            // Open the lobby first.
            // Player presses JOIN GAME themselves.
            openPreGameLobby(
                room
            );
        }
    );


    // =====================================================
    // HISTORY NEXT TO LOGOUT
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
        'overflow:auto;';


    const closeHistory =
        document.createElement(
            'button'
        );


    closeHistory.textContent =
        '✕ Close';


    closeHistory.onclick =
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
        'margin-bottom:20px;';


    const historyList =
        document.createElement(
            'div'
        );


    historyDialog.append(
        closeHistory,
        historyTitle,
        historyList
    );


    document.body.appendChild(
        historyDialog
    );


    function openHistory() {

        historyList.textContent =
            'Loading…';


        if (
            !historyDialog.open
        ) {

            historyDialog.showModal();
        }


        socket.emit(
            'get_saved_match_history'
        );
    }


    function installHistoryButton() {

        if (
            document.getElementById(
                'headerHistoryButton'
            )
        ) {

            return;
        }


        const header =
            document.querySelector(
                '#mainDashboard header'
            );


        if (!header) {

            return;
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


        const logout =
            header.querySelector(
                'button[onclick*="AuthSession.logout"]'
            );


        if (
            logout
        ) {

            header.insertBefore(
                historyButton,
                logout
            );

        } else {

            header.appendChild(
                historyButton
            );
        }
    }


    installHistoryButton();


    document.addEventListener(
        'DOMContentLoaded',
        installHistoryButton
    );


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
                    'border-radius:12px;';


                const summary =
                    document.createElement(
                        'summary'
                    );


                summary.textContent =

                    `${new Date(
                        room.createdAt ||
                        Date.now()
                    ).toLocaleString()}`

                    +

                    ` · ${room.mode}`

                    +

                    ` · ${(room.participants || []).join(', ')}`;


                details.appendChild(
                    summary
                );


                for (
                    const message of
                    room.messages || []
                ) {

                    const paragraph =
                        document.createElement(
                            'p'
                        );


                    paragraph.textContent =
                        `${message.senderName}: ${message.message}`;


                    details.appendChild(
                        paragraph
                    );
                }


                historyList.appendChild(
                    details
                );
            }
        }
    );


    // =====================================================
    // CHANGE CHAT TITLE
    // =====================================================

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