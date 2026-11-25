import express from 'express';
import { Server } from 'socket.io';
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { evaluateBoard, otherMark } from './lib/game.js';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MARKS = ['X', 'O'];

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new GameError(code, message);
}

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 20 || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail('INVALID_NAME', 'Enter a name between 1 and 20 characters.');
  }
  return name.trim();
}

function cleanCode(code) {
  if (typeof code !== 'string') fail('INVALID_CODE', 'Enter the six-character room code.');
  const normalized = code.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/u.test(normalized)) {
    fail('INVALID_CODE', 'Enter a valid six-character room code.');
  }
  return normalized;
}

/** One server owns every room, so two simultaneous moves cannot overwrite each other. */
export function createGameServer(options = {}) {
  const settings = {
    disconnectGraceMs: options.disconnectGraceMs ?? 60_000,
    roomTtlMs: options.roomTtlMs ?? 2 * 60 * 60 * 1_000,
    cleanupIntervalMs: options.cleanupIntervalMs ?? 30_000,
    maxRooms: options.maxRooms ?? 500,
    maxSpectators: options.maxSpectators ?? 30,
    actionLimit: options.actionLimit ?? 100,
    createLimitPerIp: options.createLimitPerIp ?? 12,
    trustProxy: options.trustProxy ?? process.env.RENDER === 'true',
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.use(express.static(path.join(projectDirectory, 'public'), { maxAge: 0 }));
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 8_192 });
  const rooms = new Map();
  const creationBuckets = new Map();
  let closed = false;

  function touch(room) {
    room.lastActivity = Date.now();
  }

  function members(room) {
    return [...MARKS.map((mark) => room.players[mark]).filter(Boolean), ...room.spectators.values()];
  }

  function publicState(room) {
    const players = Object.fromEntries(MARKS.map((mark) => {
      const player = room.players[mark];
      return [mark, player ? { name: player.name, connected: Boolean(player.socketId) } : null];
    }));
    let status = room.phase;
    if (status === 'playing') {
      if (!room.players.X || !room.players.O) status = 'waiting';
      else if (!room.players.X.socketId || !room.players.O.socketId) status = 'paused';
    }
    const deadlines = MARKS.map((mark) => room.players[mark]?.deadline).filter((deadline) => deadline != null);
    return {
      code: room.code,
      board: [...room.board],
      turn: room.turn,
      status,
      winner: room.winner,
      winningLine: [...room.winningLine],
      roundId: room.roundId,
      roundNumber: room.roundNumber,
      players,
      spectatorCount: [...room.spectators.values()].filter((spectator) => spectator.socketId).length,
      scores: { ...room.scores },
      restartVotes: [...room.restartVotes],
      disconnectDeadline: deadlines.length ? Math.min(...deadlines) : null,
    };
  }

  function broadcast(room) {
    const state = publicState(room);
    io.to(room.code).emit('room:state', state);
    return state;
  }

  function newRound(room, { alternate = false } = {}) {
    if (alternate) room.startingMark = otherMark(room.startingMark);
    room.board = Array(9).fill(null);
    room.turn = room.startingMark;
    room.phase = 'playing';
    room.winner = null;
    room.winningLine = [];
    room.restartVotes.clear();
    room.roundId += 1;
    room.roundNumber += 1;
  }

  function destroyRoom(room, message) {
    for (const member of members(room)) {
      clearTimeout(member.timer);
      if (member.socketId) {
        const socket = io.sockets.sockets.get(member.socketId);
        if (socket?.data.membership?.code === room.code) {
          socket.data.membership = null;
          socket.leave(room.code);
          if (message) socket.emit('room:closed', { message });
        }
      }
    }
    rooms.delete(room.code);
  }

  function removeMember(room, member) {
    clearTimeout(member.timer);
    const socket = member.socketId && io.sockets.sockets.get(member.socketId);
    if (socket?.data.membership?.token === member.token) {
      socket.data.membership = null;
      socket.leave(room.code);
    }
    if (member.role === 'spectator') room.spectators.delete(member.token);
    else {
      room.players[member.role] = null;
      // A new opponent should never inherit somebody else's unfinished match.
      newRound(room);
    }
    if (members(room).length === 0) destroyRoom(room);
    else broadcast(room);
  }

  function attach(socket, room, member) {
    clearTimeout(member.timer);
    member.timer = null;
    member.deadline = null;
    member.socketId = socket.id;
    socket.data.membership = { code: room.code, token: member.token, role: member.role };
    socket.join(room.code);
    touch(room);
    const state = broadcast(room);
    return { ok: true, code: room.code, token: member.token, role: member.role, state };
  }

  function requireFreeSocket(socket) {
    if (socket.data.membership) fail('ALREADY_IN_ROOM', 'Leave your current room before joining another.');
  }

  function currentMember(socket) {
    const membership = socket.data.membership;
    if (!membership) fail('NOT_IN_ROOM', 'Create or join a room first.');
    const room = rooms.get(membership.code);
    const member = membership.role === 'spectator'
      ? room?.spectators.get(membership.token)
      : room?.players[membership.role];
    if (!room || !member || member.token !== membership.token || member.socketId !== socket.id) {
      socket.data.membership = null;
      fail('NOT_IN_ROOM', 'This room is no longer available.');
    }
    return { room, member };
  }

  function requirePlayer(socket) {
    const result = currentMember(socket);
    if (result.member.role === 'spectator') fail('SPECTATOR', 'Spectators can watch, but only X and O can play.');
    return result;
  }

  function requireConnectedPlayers(room) {
    if (!room.players.X || !room.players.O) fail('WAITING_FOR_PLAYER', 'Wait for another player to join.');
    if (!room.players.X.socketId || !room.players.O.socketId) fail('PLAYER_DISCONNECTED', 'The game is paused while a player reconnects.');
  }

  function requireCurrentRound(room, roundId) {
    if (!Number.isInteger(roundId) || roundId !== room.roundId) {
      fail('STALE_ROUND', 'The round changed. Please try again.');
    }
  }

  function newMember(name, role) {
    return { name, role, token: randomBytes(32).toString('hex'), socketId: null, timer: null, deadline: null };
  }

  function checkCreationRate(socket) {
    let address = socket.handshake.address;
    // Render appends the real client IP. Only trust this header on its managed proxy.
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (settings.trustProxy && typeof forwarded === 'string') {
      const candidate = forwarded.split(',').at(-1).trim();
      if (isIP(candidate)) address = candidate;
    }
    const now = Date.now();
    const recent = (creationBuckets.get(address) ?? []).filter((created) => now - created < 10 * 60_000);
    if (recent.length >= settings.createLimitPerIp) fail('RATE_LIMITED', 'Too many rooms created. Please try again later.');
    recent.push(now);
    creationBuckets.set(address, recent);
  }

  io.on('connection', (socket) => {
    let bucketStart = Date.now();
    let actionCount = 0;

    function on(event, handler) {
      socket.on(event, (payload, acknowledgement) => {
        const acknowledge = typeof acknowledgement === 'function' ? acknowledgement : () => {};
        try {
          const now = Date.now();
          if (now - bucketStart > 60_000) {
            bucketStart = now;
            actionCount = 0;
          }
          if (++actionCount > settings.actionLimit) fail('RATE_LIMITED', 'Please slow down and try again in a moment.');
          if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_REQUEST', 'That request could not be read.');
          acknowledge(handler(payload));
        } catch (error) {
          acknowledge({
            ok: false,
            error: error instanceof GameError ? error.code : 'SERVER_ERROR',
            message: error instanceof GameError ? error.message : 'Something went wrong. Please try again.',
          });
        }
      });
    }

    on('room:create', ({ name }) => {
      requireFreeSocket(socket);
      const safeName = cleanName(name);
      if (rooms.size >= settings.maxRooms) fail('SERVER_FULL', 'All rooms are currently busy. Please try again shortly.');
      checkCreationRate(socket);
      let code;
      do {
        code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      } while (rooms.has(code));
      const room = {
        code, board: Array(9).fill(null), turn: 'X', startingMark: 'X', phase: 'playing',
        winner: null, winningLine: [], roundId: 1, roundNumber: 1,
        players: { X: newMember(safeName, 'X'), O: null }, spectators: new Map(),
        scores: { X: 0, O: 0, draws: 0 }, restartVotes: new Set(), lastActivity: Date.now(),
      };
      rooms.set(code, room);
      return attach(socket, room, room.players.X);
    });

    on('room:join', ({ code, name }) => {
      requireFreeSocket(socket);
      const normalized = cleanCode(code);
      const safeName = cleanName(name);
      const room = rooms.get(normalized);
      if (!room) fail('ROOM_NOT_FOUND', 'Room not found. Check the code or create a new room.');
      const role = MARKS.find((mark) => !room.players[mark]) ?? 'spectator';
      if (role === 'spectator' && room.spectators.size >= settings.maxSpectators) {
        fail('ROOM_FULL', 'This room already has the maximum number of spectators.');
      }
      const member = newMember(safeName, role);
      if (role === 'spectator') room.spectators.set(member.token, member);
      else room.players[role] = member;
      return attach(socket, room, member);
    });

    on('room:resume', ({ code, token }) => {
      requireFreeSocket(socket);
      const room = rooms.get(cleanCode(code));
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) fail('INVALID_SESSION', 'Your saved room session is invalid. Join the room again.');
      if (!room) fail('ROOM_NOT_FOUND', 'This room has expired. Create or join another room.');
      const member = members(room).find((candidate) => candidate.token === token);
      if (!member) fail('SESSION_EXPIRED', 'Your seat reservation has expired. Join the room again.');
      if (member.socketId) fail('SEAT_IN_USE', 'This session is already connected in another tab.');
      if (member.deadline != null && Date.now() >= member.deadline) {
        removeMember(room, member);
        fail('SESSION_EXPIRED', 'Your seat reservation has expired. Join the room again.');
      }
      return attach(socket, room, member);
    });

    on('room:leave', () => {
      const { room, member } = currentMember(socket);
      touch(room);
      removeMember(room, member);
      return { ok: true, state: null };
    });

    on('game:move', ({ index, roundId }) => {
      const { room, member } = requirePlayer(socket);
      requireConnectedPlayers(room);
      if (!Number.isInteger(index) || index < 0 || index > 8) fail('INVALID_MOVE', 'Choose a square on the board.');
      requireCurrentRound(room, roundId);
      if (room.phase !== 'playing') fail('GAME_FINISHED', 'This round has finished. Request a new round to play again.');
      if (room.turn !== member.role) fail('NOT_YOUR_TURN', 'Wait for your turn.');
      if (room.board[index] !== null) fail('OCCUPIED', 'That square is already taken. Choose an empty square.');
      room.board[index] = member.role;
      const result = evaluateBoard(room.board);
      room.phase = result.status;
      room.winner = result.winner;
      room.winningLine = result.winningLine;
      if (result.status === 'won') room.scores[result.winner] += 1;
      else if (result.status === 'draw') room.scores.draws += 1;
      else room.turn = otherMark(room.turn);
      // A pending mid-round restart is withdrawn when play continues.
      room.restartVotes.clear();
      touch(room);
      return { ok: true, state: broadcast(room) };
    });

    on('game:restart', ({ roundId }) => {
      const { room, member } = requirePlayer(socket);
      requireCurrentRound(room, roundId);
      requireConnectedPlayers(room);
      room.restartVotes.add(member.role);
      if (room.restartVotes.size === 2) newRound(room, { alternate: true });
      touch(room);
      return { ok: true, state: broadcast(room) };
    });

    on('game:restart-cancel', ({ roundId }) => {
      const { room, member } = requirePlayer(socket);
      requireCurrentRound(room, roundId);
      room.restartVotes.delete(member.role);
      touch(room);
      return { ok: true, state: broadcast(room) };
    });

    socket.on('disconnect', () => {
      if (!socket.data.membership) return;
      let result;
      try { result = currentMember(socket); } catch { return; }
      const { room, member } = result;
      member.socketId = null;
      member.deadline = Date.now() + settings.disconnectGraceMs;
      if (member.role !== 'spectator') room.restartVotes.clear();
      socket.data.membership = null;
      member.timer = setTimeout(() => {
        if (!closed && rooms.has(room.code) && !member.socketId) removeMember(room, member);
      }, settings.disconnectGraceMs);
      member.timer.unref();
      touch(room);
      broadcast(room);
    });
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (now - room.lastActivity >= settings.roomTtlMs) {
        destroyRoom(room, 'This room expired after being idle. Create a new room to keep playing.');
      }
    }
    for (const [address, timestamps] of creationBuckets) {
      const recent = timestamps.filter((timestamp) => now - timestamp < 10 * 60_000);
      if (recent.length) creationBuckets.set(address, recent);
      else creationBuckets.delete(address);
    }
  }, settings.cleanupIntervalMs);
  cleanupTimer.unref();

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(cleanupTimer);
    for (const room of rooms.values()) destroyRoom(room);
    await new Promise((resolve) => io.close(resolve));
  }

  return { app, io, httpServer, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const game = createGameServer();
  const port = Number(process.env.PORT || 3000);
  game.httpServer.listen(port, '0.0.0.0', () => console.log(`Tic-Tac-Toe server listening on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => game.close().then(() => process.exit(0)));
  }
}
