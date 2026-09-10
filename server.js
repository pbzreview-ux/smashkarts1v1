const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

let queue = [];

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Player clicks PLAY 1V1
  socket.on('join_queue', () => {
    // Avoid double joins
    if (!queue.includes(socket)) {
      queue.push(socket);
      console.log(`Player ${socket.id} added to queue. Queue length: ${queue.length}`);
    }

    // Match 2 players when queue reaches 2
    if (queue.length >= 2) {
      const p1 = queue.shift();
      const p2 = queue.shift();
      const matchId = `match_${Date.now()}`;

      p1.join(matchId);
      p2.join(matchId);

      // Assign host and guest roles
      p1.emit('match_found', { role: 'host', matchId });
      p2.emit('match_found', { role: 'guest', matchId });
    }
  });

  // Host submits room link code
  socket.on('send_room_link', ({ matchId, link }) => {
    io.to(matchId).emit('receive_room_link', { link });
  });

  socket.on('disconnect', () => {
    queue = queue.filter(s => s.id !== socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});