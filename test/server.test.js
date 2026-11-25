import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connectSocket } from 'socket.io-client';
import { createGameServer } from '../server.js';
import { evaluateBoard, WINNING_LINES } from '../lib/game.js';

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(2_000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result));
  });
}

function nextState(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('room:state', listener);
      reject(new Error('Timed out waiting for a room update'));
    }, 2_000);
    function listener(state) {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      socket.off('room:state', listener);
      resolve(state);
    }
    socket.on('room:state', listener);
  });
}

async function fixture(t, options = {}) {
  const server = createGameServer(options);
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach((client) => client.disconnect());
    await server.close();
  });
  async function client(extraOptions = {}) {
    const socket = connectSocket(url, { transports: ['websocket'], reconnection: false, forceNew: true, ...extraOptions });
    clients.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }
  async function pair() {
    const x = await client();
    const created = await request(x, 'room:create', { name: 'Alex' });
    assert.equal(created.ok, true);
    const o = await client();
    const joined = await request(o, 'room:join', { code: created.code, name: 'Sam' });
    assert.equal(joined.ok, true);
    return { x, o, created, joined, code: created.code, roundId: created.state.roundId };
  }
  return { server, url, client, pair };
}

async function play(pair, cells) {
  let result;
  for (const [turn, index] of cells.entries()) {
    result = await request(turn % 2 === 0 ? pair.x : pair.o, 'game:move', { index, roundId: pair.roundId });
    assert.equal(result.ok, true, result.message);
  }
  return result.state;
}

test('detects all eight winning lines for X and O, and distinguishes draws', () => {
  for (const mark of ['X', 'O']) {
    for (const line of WINNING_LINES) {
      const board = Array(9).fill(null);
      for (const index of line) board[index] = mark;
      assert.deepEqual(evaluateBoard(board), { status: 'won', winner: mark, winningLine: line });
    }
  }
  assert.equal(evaluateBoard(Array(9).fill(null)).status, 'playing');
  assert.deepEqual(evaluateBoard(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']), {
    status: 'draw', winner: null, winningLine: [],
  });
});

test('health endpoint reports a running game server', async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('create and case-insensitive join synchronize two players and a spectator', async (t) => {
  const { client } = await fixture(t);
  const x = await client();
  const created = await request(x, 'room:create', { name: '  Alex  ' });
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{6}$/u);
  assert.equal(created.role, 'X');
  assert.equal(created.state.status, 'waiting');
  assert.equal(created.state.players.X.name, 'Alex');
  const o = await client();
  const xUpdate = nextState(x, (state) => state.status === 'playing');
  const joined = await request(o, 'room:join', { name: 'Sam', code: created.code.toLowerCase() });
  assert.equal(joined.role, 'O');
  assert.deepEqual(await xUpdate, joined.state);
  const spectator = await client();
  const watched = await request(spectator, 'room:join', { name: 'Taylor', code: created.code });
  assert.equal(watched.role, 'spectator');
  assert.equal(watched.state.spectatorCount, 1);
  const oMove = nextState(o, (state) => state.board[4] === 'X');
  const spectatorMove = nextState(spectator, (state) => state.board[4] === 'X');
  const moved = await request(x, 'game:move', { index: 4, roundId: created.state.roundId });
  assert.deepEqual(await oMove, moved.state);
  assert.deepEqual(await spectatorMove, moved.state);
  assert.equal(moved.state.turn, 'O');
  assert.equal(JSON.stringify(moved.state).includes(created.token), false);
  assert.equal(JSON.stringify(moved.state).includes(joined.token), false);
  assert.equal((await request(spectator, 'game:move', { index: 0, roundId: moved.state.roundId })).error, 'SPECTATOR');
  assert.equal((await request(spectator, 'game:restart', { roundId: moved.state.roundId })).error, 'SPECTATOR');
});

test('server rejects invalid, out-of-turn, duplicate and stale moves', async (t) => {
  const { pair } = await fixture(t);
  const players = await pair();
  assert.equal((await request(players.o, 'game:move', { index: 1, roundId: players.roundId })).error, 'NOT_YOUR_TURN');
  for (const index of [-1, 9, 0.5, '0', null]) {
    assert.equal((await request(players.x, 'game:move', { index, roundId: players.roundId })).error, 'INVALID_MOVE');
  }
  assert.equal((await request(players.x, 'game:move', { index: 0, roundId: players.roundId - 1 })).error, 'STALE_ROUND');
  const concurrent = await Promise.all([
    request(players.x, 'game:move', { index: 0, roundId: players.roundId }),
    request(players.x, 'game:move', { index: 1, roundId: players.roundId }),
  ]);
  assert.equal(concurrent.filter((result) => result.ok).length, 1);
  assert.equal(concurrent.find((result) => !result.ok).error, 'NOT_YOUR_TURN');
  assert.equal((await request(players.o, 'game:move', { index: 0, roundId: players.roundId })).error, 'OCCUPIED');
  const valid = await request(players.o, 'game:move', { index: 2, roundId: players.roundId });
  assert.deepEqual(valid.state.board, ['X', null, 'O', null, null, null, null, null, null]);
});

test('a live winning match ends once, broadcasts the winning line, and stops further moves', async (t) => {
  const { pair } = await fixture(t);
  const players = await pair();
  const state = await play(players, [0, 3, 1, 4, 2]);
  assert.equal(state.status, 'won');
  assert.equal(state.winner, 'X');
  assert.deepEqual(state.winningLine, [0, 1, 2]);
  assert.deepEqual(state.scores, { X: 1, O: 0, draws: 0 });
  assert.equal((await request(players.o, 'game:move', { index: 5, roundId: players.roundId })).error, 'GAME_FINISHED');
  assert.equal((await request(players.x, 'game:move', { index: 6, roundId: players.roundId })).error, 'GAME_FINISHED');
  const vote = await request(players.x, 'game:restart', { roundId: players.roundId });
  assert.deepEqual(vote.state.scores, state.scores);
});

test('a real nine-move match produces a draw', async (t) => {
  const { pair } = await fixture(t);
  const players = await pair();
  const state = await play(players, [0, 1, 2, 4, 3, 5, 7, 6, 8]);
  assert.equal(state.status, 'draw');
  assert.equal(state.winner, null);
  assert.deepEqual(state.scores, { X: 0, O: 0, draws: 1 });
  assert.equal((await request(players.o, 'game:move', { index: 0, roundId: players.roundId })).error, 'GAME_FINISHED');
});

test('restart needs both players, can be cancelled, preserves scores, and alternates the starter', async (t) => {
  const { pair } = await fixture(t);
  const players = await pair();
  const finished = await play(players, [0, 3, 1, 4, 2]);
  const pending = await request(players.x, 'game:restart', { roundId: players.roundId });
  assert.equal(pending.state.roundId, players.roundId);
  assert.deepEqual(pending.state.board, finished.board);
  assert.deepEqual(pending.state.restartVotes, ['X']);
  const duplicate = await request(players.x, 'game:restart', { roundId: players.roundId });
  assert.deepEqual(duplicate.state.restartVotes, ['X']);
  assert.deepEqual((await request(players.x, 'game:restart-cancel', { roundId: players.roundId })).state.restartVotes, []);
  await request(players.x, 'game:restart', { roundId: players.roundId });
  const restarted = await request(players.o, 'game:restart', { roundId: players.roundId });
  assert.equal(restarted.state.roundId, players.roundId + 1);
  assert.equal(restarted.state.roundNumber, 2);
  assert.equal(restarted.state.turn, 'O');
  assert.equal(restarted.state.status, 'playing');
  assert.deepEqual(restarted.state.board, Array(9).fill(null));
  assert.deepEqual(restarted.state.scores, finished.scores);
  assert.deepEqual(restarted.state.restartVotes, []);
  assert.equal((await request(players.x, 'game:move', { index: 4, roundId: restarted.state.roundId })).error, 'NOT_YOUR_TURN');
  assert.equal((await request(players.o, 'game:move', { index: 4, roundId: restarted.state.roundId })).ok, true);
  assert.equal((await request(players.o, 'game:move', { index: 5, roundId: players.roundId })).error, 'STALE_ROUND');
  await request(players.x, 'game:restart', { roundId: restarted.state.roundId });
  const secondRestart = await request(players.o, 'game:restart', { roundId: restarted.state.roundId });
  assert.equal(secondRestart.state.turn, 'X');
});

test('old or missing restart round IDs cannot change consent after replacement or restart', async (t) => {
  const { pair, client } = await fixture(t);
  const players = await pair();
  await request(players.x, 'game:restart', { roundId: players.roundId });
  assert.equal((await request(players.o, 'room:leave')).ok, true);
  const replacement = await client();
  const joined = await request(replacement, 'room:join', { code: players.code, name: 'Replacement' });
  const replacementRound = joined.state.roundId;
  assert.equal(replacementRound, players.roundId + 1);
  assert.deepEqual(joined.state.restartVotes, []);

  assert.equal((await request(players.x, 'game:restart', { roundId: players.roundId })).error, 'STALE_ROUND');
  assert.equal((await request(players.x, 'game:restart')).error, 'STALE_ROUND');
  assert.equal((await request(players.x, 'game:restart', { roundId: String(replacementRound) })).error, 'STALE_ROUND');
  const freshVote = await request(players.x, 'game:restart', { roundId: replacementRound });
  assert.deepEqual(freshVote.state.restartVotes, ['X']);
  assert.equal((await request(players.x, 'game:restart-cancel', { roundId: players.roundId })).error, 'STALE_ROUND');
  assert.equal((await request(players.x, 'game:restart-cancel')).error, 'STALE_ROUND');
  const repeatedVote = await request(players.x, 'game:restart', { roundId: replacementRound });
  assert.deepEqual(repeatedVote.state.restartVotes, ['X']);

  const restarted = await request(replacement, 'game:restart', { roundId: replacementRound });
  assert.equal(restarted.state.roundId, replacementRound + 1);
  assert.deepEqual(restarted.state.restartVotes, []);
  assert.equal((await request(players.x, 'game:restart', { roundId: replacementRound })).error, 'STALE_ROUND');
  const nextVote = await request(players.x, 'game:restart', { roundId: restarted.state.roundId });
  assert.deepEqual(nextVote.state.restartVotes, ['X']);
  assert.equal((await request(players.x, 'game:restart-cancel', { roundId: replacementRound })).error, 'STALE_ROUND');
  const retainedVote = await request(players.x, 'game:restart', { roundId: restarted.state.roundId });
  assert.deepEqual(retainedVote.state.restartVotes, ['X']);
});

test('rooms remain independent and a connected socket cannot enter another room', async (t) => {
  const { pair, client } = await fixture(t);
  const first = await pair();
  const other = await client();
  const second = await request(other, 'room:create', { name: 'Other host' });
  assert.notEqual(first.code, second.code);
  assert.equal((await request(first.x, 'room:join', { code: second.code, name: 'Alex' })).error, 'ALREADY_IN_ROOM');
  let unexpectedUpdates = 0;
  other.on('room:state', () => unexpectedUpdates++);
  await request(first.x, 'game:move', { index: 0, roundId: first.roundId });
  await request(first.o, 'game:move', { index: 4, roundId: first.roundId });
  assert.equal(unexpectedUpdates, 0);
  const visitor = await client();
  const secondJoined = await request(visitor, 'room:join', { code: second.code, name: 'Visitor' });
  assert.deepEqual(secondJoined.state.board, Array(9).fill(null));
});

test('disconnect pauses the match and a valid token restores the same board and seat', async (t) => {
  const { pair, client } = await fixture(t, { disconnectGraceMs: 2_000 });
  const players = await pair();
  await request(players.x, 'game:move', { index: 4, roundId: players.roundId });
  const pausedUpdate = nextState(players.x, (state) => state.status === 'paused');
  players.o.disconnect();
  const paused = await pausedUpdate;
  assert.equal(paused.players.O.connected, false);
  assert.ok(paused.disconnectDeadline > Date.now());
  assert.equal((await request(players.x, 'game:restart', { roundId: players.roundId })).error, 'PLAYER_DISCONNECTED');
  const resumedSocket = await client();
  const resumedUpdate = nextState(players.x, (state) => state.status === 'playing');
  const resumed = await request(resumedSocket, 'room:resume', { code: players.code, token: players.joined.token });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.role, 'O');
  assert.equal(resumed.token, players.joined.token);
  assert.equal(resumed.state.board[4], 'X');
  assert.equal(resumed.state.turn, 'O');
  assert.equal(resumed.state.disconnectDeadline, null);
  assert.deepEqual(await resumedUpdate, resumed.state);
  assert.equal((await request(resumedSocket, 'game:move', { index: 0, roundId: players.roundId })).ok, true);
});

test('tokens cannot reclaim another active seat and expired reservations allow a replacement', async (t) => {
  const { pair, client } = await fixture(t, { disconnectGraceMs: 80 });
  const players = await pair();
  const intruder = await client();
  assert.equal((await request(intruder, 'room:resume', { code: players.code, token: players.created.token })).error, 'SEAT_IN_USE');
  assert.equal((await request(intruder, 'room:resume', { code: players.code, token: 'f'.repeat(64) })).error, 'SESSION_EXPIRED');
  assert.equal((await request(intruder, 'room:resume', { code: players.code, token: 'invalid' })).error, 'INVALID_SESSION');
  await request(players.x, 'game:move', { index: 4, roundId: players.roundId });
  const removedUpdate = nextState(players.x, (state) => !state.players.O);
  players.o.disconnect();
  const reset = await removedUpdate;
  assert.equal(reset.status, 'waiting');
  assert.deepEqual(reset.board, Array(9).fill(null));
  assert.equal(reset.roundId, players.roundId + 1);
  assert.equal((await request(intruder, 'room:resume', { code: players.code, token: players.joined.token })).error, 'SESSION_EXPIRED');
  const replacement = await request(intruder, 'room:join', { code: players.code, name: 'New player' });
  assert.equal(replacement.role, 'O');
  assert.equal(replacement.state.status, 'playing');
});

test('spectator reservations resume and explicit leave releases the seat immediately', async (t) => {
  const { pair, client } = await fixture(t, { disconnectGraceMs: 2_000 });
  const players = await pair();
  const watcher = await client();
  const watched = await request(watcher, 'room:join', { code: players.code, name: 'Watcher' });
  const noWatcher = nextState(players.x, (state) => state.spectatorCount === 0);
  watcher.disconnect();
  await noWatcher;
  const reconnectedWatcher = await client();
  const resumed = await request(reconnectedWatcher, 'room:resume', { code: players.code, token: watched.token });
  assert.equal(resumed.role, 'spectator');
  assert.equal(resumed.state.spectatorCount, 1);
  await request(players.o, 'room:leave');
  const replacement = await client();
  assert.equal((await request(replacement, 'room:join', { code: players.code, name: 'Replacement' })).role, 'O');
  assert.equal((await request(players.o, 'game:restart', { roundId: players.roundId })).error, 'NOT_IN_ROOM');
  assert.equal((await request(players.o, 'room:create', { name: 'Fresh host' })).ok, true);
});

test('spectator disconnect, resume and leave preserve player restart consent', async (t) => {
  const { pair, client } = await fixture(t, { disconnectGraceMs: 2_000 });
  const players = await pair();
  const watcher = await client();
  const watched = await request(watcher, 'room:join', { code: players.code, name: 'Watcher' });
  assert.deepEqual((await request(players.x, 'game:restart', { roundId: players.roundId })).state.restartVotes, ['X']);

  const disconnectedUpdate = nextState(players.x, (state) => state.spectatorCount === 0);
  watcher.disconnect();
  const disconnected = await disconnectedUpdate;
  assert.deepEqual(disconnected.restartVotes, ['X']);
  assert.equal(disconnected.status, 'playing');

  const newWatcherSocket = await client();
  const resumed = await request(newWatcherSocket, 'room:resume', { code: players.code, token: watched.token });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.state.restartVotes, ['X']);

  const leftUpdate = nextState(players.x, (state) => state.spectatorCount === 0);
  assert.equal((await request(newWatcherSocket, 'room:leave')).ok, true);
  assert.deepEqual((await leftUpdate).restartVotes, ['X']);

  const restarted = await request(players.o, 'game:restart', { roundId: players.roundId });
  assert.equal(restarted.state.roundId, players.roundId + 1);
  assert.equal(restarted.state.turn, 'O');
  assert.deepEqual(restarted.state.restartVotes, []);
});

test('invalid room requests and missing players return clear errors', async (t) => {
  const { client } = await fixture(t);
  const socket = await client();
  for (const name of ['', '   ', 'a'.repeat(21), 42, 'a\nname']) {
    assert.equal((await request(socket, 'room:create', { name })).error, 'INVALID_NAME');
  }
  assert.equal((await request(socket, 'room:create', [])).error, 'INVALID_REQUEST');
  assert.equal((await request(socket, 'room:join', { code: '123', name: 'Alex' })).error, 'INVALID_CODE');
  assert.equal((await request(socket, 'room:join', { code: 'AAAAAA', name: 'Alex' })).error, 'ROOM_NOT_FOUND');
  assert.equal((await request(socket, 'game:move', { index: 0, roundId: 1 })).error, 'NOT_IN_ROOM');
  const created = await request(socket, 'room:create', { name: 'Alex' });
  assert.equal((await request(socket, 'game:move', { index: 0, roundId: created.state.roundId })).error, 'WAITING_FOR_PLAYER');
  assert.equal((await request(socket, 'game:restart', { roundId: created.state.roundId })).error, 'WAITING_FOR_PLAYER');
});

test('room and spectator limits prevent unbounded room creation', async (t) => {
  const { pair, client } = await fixture(t, { maxRooms: 1, maxSpectators: 1 });
  const players = await pair();
  const watcher = await client();
  assert.equal((await request(watcher, 'room:join', { code: players.code, name: 'Watcher' })).ok, true);
  const extra = await client();
  assert.equal((await request(extra, 'room:join', { code: players.code, name: 'Extra' })).error, 'ROOM_FULL');
  assert.equal((await request(extra, 'room:create', { name: 'Extra' })).error, 'SERVER_FULL');
});

test('per-socket actions and room creation are rate limited', async (t) => {
  const { client } = await fixture(t, { actionLimit: 3, createLimitPerIp: 1 });
  const socket = await client();
  await request(socket, 'game:restart');
  await request(socket, 'game:restart');
  await request(socket, 'game:restart');
  assert.equal((await request(socket, 'game:restart')).error, 'RATE_LIMITED');
  const first = await client();
  assert.equal((await request(first, 'room:create', { name: 'First' })).ok, true);
  const second = await client();
  assert.equal((await request(second, 'room:create', { name: 'Second' })).error, 'RATE_LIMITED');
});

test('idle expiry notifies connected players and removes the room', async (t) => {
  const { client } = await fixture(t, { roomTtlMs: 70, cleanupIntervalMs: 15 });
  const socket = await client();
  const created = await request(socket, 'room:create', { name: 'Alex' });
  const closed = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Room did not expire')), 2_000);
    socket.once('room:closed', (message) => { clearTimeout(timeout); resolve(message); });
  });
  assert.match(closed.message, /expired/u);
  assert.equal((await request(socket, 'room:join', { code: created.code, name: 'Alex' })).error, 'ROOM_NOT_FOUND');
  assert.equal((await request(socket, 'room:create', { name: 'Alex' })).ok, true);
});

test('room limits distinguish clients only behind an explicitly trusted proxy', async (t) => {
  const untrusted = await fixture(t, { createLimitPerIp: 1, trustProxy: false });
  const spoofOne = await untrusted.client({ extraHeaders: { 'x-forwarded-for': '192.0.2.10' } });
  const spoofTwo = await untrusted.client({ extraHeaders: { 'x-forwarded-for': '192.0.2.11' } });
  assert.equal((await request(spoofOne, 'room:create', { name: 'First' })).ok, true);
  assert.equal((await request(spoofTwo, 'room:create', { name: 'Second' })).error, 'RATE_LIMITED');

  const trusted = await fixture(t, { createLimitPerIp: 1, trustProxy: true });
  const realOne = await trusted.client({ extraHeaders: { 'x-forwarded-for': '192.0.2.10' } });
  const realTwo = await trusted.client({ extraHeaders: { 'x-forwarded-for': '192.0.2.11' } });
  const spoofedPrefix = await trusted.client({ extraHeaders: { 'x-forwarded-for': '203.0.113.1, 192.0.2.10' } });
  assert.equal((await request(realOne, 'room:create', { name: 'First' })).ok, true);
  assert.equal((await request(realTwo, 'room:create', { name: 'Second' })).ok, true);
  assert.equal((await request(spoofedPrefix, 'room:create', { name: 'Prefix' })).error, 'RATE_LIMITED');
});
