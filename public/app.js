(() => {
  'use strict';

  // The server owns the board. This file only displays state and asks to act.
  const $ = (id) => document.getElementById(id);
  const storageKey = 'xo-club-room';
  const nicknameKey = 'xo-club-nickname';
  let mode = 'create';
  let connected = false;
  let busy = false;
  let identity = null;
  let game = null;
  let roomReady = false;
  let operation = 0;
  let toastTimer;
  let coldStartTimer;

  function readStoredIdentity() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey));
      if (saved && /^[A-Z0-9]{6}$/.test(saved.code) &&
          typeof saved.token === 'string' && saved.token.length >= 16 &&
          ['X', 'O', 'spectator'].includes(saved.role)) return saved;
    } catch { /* Private browsers may disable storage; the game still works. */ }
    return null;
  }

  function saveIdentity(value) {
    identity = value;
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch { /* Keep the current room in memory when storage is unavailable. */ }
  }

  function showError(where, message) {
    const element = $(where === 'game' ? 'game-error' : 'lobby-error');
    element.textContent = message || '';
    element.hidden = !message;
  }

  function notify(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
  }

  function setMode(next, focus = false) {
    mode = next;
    for (const name of ['create', 'join']) {
      const active = next === name;
      const tab = $(`${name}-tab`);
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    $('room-form-panel').setAttribute('aria-labelledby', `${next}-tab`);
    $('join-code-field').hidden = next !== 'join';
    $('join-code').required = next === 'join';
    $('room-form-hint').textContent = next === 'create'
      ? 'You’ll get a code to share with your friend.'
      : 'The first two guests play. Extra friends watch live.';
    showError('lobby', '');
    updateControls();
    if (focus) $(`${next}-tab`).focus();
  }

  function connectionStatus() {
    $('connection-pill').classList.toggle('online', connected);
    $('connection-pill').classList.toggle('offline', !connected && !!game);
    $('connection-text').textContent = connected ? 'Connected live' : game ? 'Reconnecting' : 'Connecting';
    if (connected) {
      clearTimeout(coldStartTimer);
      $('connection-help').hidden = true;
    }
    updateControls();
  }

  function updateControls() {
    $('room-submit').disabled = !connected || busy || (!!identity && !roomReady);
    $('room-submit-label').textContent = busy && !game
      ? identity ? 'Rejoining your room…' : mode === 'create' ? 'Creating your room…' : 'Joining your room…'
      : mode === 'create' ? 'Create my room' : 'Join room';
    $('nickname').disabled = busy;
    $('join-code').disabled = busy;
    $('create-tab').disabled = busy;
    $('join-tab').disabled = busy;
    $('leave-button').disabled = !connected || busy || !roomReady;
    if (!game) return;
    const bothPresent = game.players.X?.connected && game.players.O?.connected;
    const canMove = connected && roomReady && !busy && identity && identity.role === game.turn &&
      game.status === 'playing' && bothPresent;
    for (let index = 0; index < 9; index++) {
      const cell = $(`cell-${index}`);
      cell.disabled = !canMove || game.board[index] !== null;
      cell.dataset.preview = game.turn === 'O' ? '○' : '×';
      cell.classList.toggle('preview-o', game.turn === 'O');
    }
    const player = identity && ['X', 'O'].includes(identity.role);
    $('restart-button').disabled = !connected || !roomReady || busy || !player || !bothPresent;
  }

  function setBusy(value) {
    busy = value;
    updateControls();
  }

  // Acknowledgments confirm success. Timeouts release controls without inventing a move.
  function request(event, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!connected) {
        reject(new Error('The connection is returning. Please wait a moment.'));
        return;
      }
      socket.timeout(10000).emit(event, payload, (timeoutError, reply) => {
        if (timeoutError) {
          reject(new Error('The server took too long to reply. Please try again.'));
        } else if (!reply || !reply.ok) {
          const error = new Error(reply?.message || 'That action could not be completed. Please try again.');
          error.code = reply?.error;
          reject(error);
        } else resolve(reply);
      });
    });
  }

  function enterRoom(reply, recovering = false) {
    saveIdentity({ code: reply.code, token: reply.token, role: reply.role });
    roomReady = true;
    $('lobby-view').hidden = true;
    $('game-view').hidden = false;
    showError('game', '');
    renderGame(reply.state);
    const url = new URL(window.location.href);
    url.searchParams.set('room', reply.code);
    history.replaceState(null, '', url);
    if (!recovering) {
      $('game-title').setAttribute('tabindex', '-1');
      $('game-title').focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function returnToLobby(message = '') {
    saveIdentity(null);
    game = null;
    roomReady = false;
    operation++;
    setBusy(false);
    $('game-view').hidden = true;
    $('lobby-view').hidden = false;
    $('join-code').value = '';
    setMode('create');
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    showError('lobby', message);
    $('nickname').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function playerName(mark) {
    return game.players[mark]?.name || `Player ${mark}`;
  }

  function renderGame(state) {
    if (!identity || !state || state.code !== identity.code) return;
    const previous = game;
    game = state;
    $('room-code').textContent = state.code;
    $('round-label').textContent = `ROUND ${String(state.roundNumber).padStart(2, '0')}`;
    $('role-badge').textContent = identity.role === 'spectator' ? 'You’re watching' : `You’re ${identity.role}`;
    $('role-badge').classList.toggle('spectator', identity.role === 'spectator');
    $('score-x').textContent = state.scores.X;
    $('score-o').textContent = state.scores.O;
    $('score-draws').textContent = state.scores.draws;
    $('spectator-count').textContent = `${state.spectatorCount} watching`;

    for (const mark of ['X', 'O']) {
      const player = state.players[mark];
      $(`player-${mark.toLowerCase()}-name`).textContent = player
        ? `${player.name}${identity.role === mark ? ' (you)' : ''}` : 'Open seat';
      $(`player-${mark.toLowerCase()}-status`).textContent = !player
        ? 'Waiting for a player' : player.connected ? 'Online' : 'Reconnecting…';
      $(`player-${mark.toLowerCase()}`).classList.toggle('connected', !!player?.connected);
      $(`player-${mark.toLowerCase()}`).classList.toggle('current', state.status === 'playing' && state.turn === mark);
    }

    for (let index = 0; index < 9; index++) {
      const mark = state.board[index];
      const cell = $(`cell-${index}`);
      cell.textContent = mark === 'X' ? '×' : mark === 'O' ? '○' : '';
      cell.classList.toggle('x', mark === 'X');
      cell.classList.toggle('o', mark === 'O');
      cell.classList.toggle('empty', mark === null);
      cell.classList.toggle('winner', state.winningLine.includes(index));
      const row = Math.floor(index / 3) + 1;
      const column = index % 3 + 1;
      cell.setAttribute('aria-label', `Row ${row}, column ${column}: ${mark || 'empty'}${state.winningLine.includes(index) ? ', winning square' : ''}`);
      if (mark && (!previous || previous.board[index] !== mark || previous.roundId !== state.roundId)) {
        cell.classList.remove('mark-enter');
        void cell.offsetWidth;
        cell.classList.add('mark-enter');
      } else if (!mark) cell.classList.remove('mark-enter');
    }

    renderTurn();
    renderRestart();
    updateControls();
  }

  function renderTurn() {
    let title;
    let detail;
    let symbol;
    let style = '';
    if (!connected) {
      title = 'Getting you back in';
      detail = 'Connection lost. Your board will sync when you reconnect.';
      symbol = '↻';
      style = 'paused';
    } else if (!roomReady) {
      title = 'Restoring your room';
      detail = 'Checking your seat and syncing the latest board.';
      symbol = '↻';
      style = 'paused';
    } else if (game.status === 'waiting') {
      title = 'Waiting for your friend';
      detail = 'Share your room code to fill the open seat.';
      symbol = '…';
    } else if (game.status === 'paused') {
      title = 'A quick connection break';
      detail = 'A player disconnected. Their seat is held briefly while they return.';
      symbol = 'Ⅱ';
      style = 'paused';
    } else if (game.status === 'won') {
      title = `${playerName(game.winner)} wins!`;
      detail = identity.role === game.winner ? 'Nicely played. Ready for another round?' : 'Three in a row. There’s always the next round.';
      symbol = '✦';
      style = 'result';
    } else if (game.status === 'draw') {
      title = 'A perfectly matched draw';
      detail = 'Nine squares, no winner. Settle it with another round.';
      symbol = '=';
      style = 'result';
    } else {
      title = identity.role === game.turn ? 'Your move' : `${playerName(game.turn)}’s move`;
      detail = identity.role === 'spectator' ? 'You have the best seat. Enjoy the game.'
        : identity.role === game.turn ? 'Pick an empty square. Make it a good one.' : 'Your turn is coming. Plan your next move.';
      symbol = game.turn === 'X' ? '×' : '○';
      style = game.turn === 'O' ? 'o' : '';
    }
    $('turn-banner').className = `turn-banner ${style}`;
    $('turn-symbol').textContent = symbol;
    $('turn-title').textContent = title;
    $('turn-detail').textContent = detail;
    $('board-caption').textContent = !connected ? 'Moves are paused until your connection returns.'
      : game.status === 'won' ? `${game.winner} takes this round. Well played.`
      : game.status === 'draw' ? 'Evenly matched. The scoreboard agrees.'
      : game.status === 'paused' ? 'The board is safe while your friend reconnects.'
      : game.status === 'waiting' ? 'Your match starts when both players are here.'
      : identity.role === 'spectator' ? 'Watching live · Only players can place marks.'
      : 'Three in a row. You know the drill.';
  }

  function renderRestart() {
    const ownVote = game.restartVotes.includes(identity.role);
    const otherVote = game.restartVotes.length > 0 && !ownVote;
    $('restart-label').textContent = ownVote ? 'Cancel restart request'
      : otherVote ? 'Accept restart' : ['won', 'draw'].includes(game.status) ? 'Play again' : 'Request restart';
    $('restart-status').hidden = !game.restartVotes.length;
    $('restart-status').textContent = identity.role === 'spectator' && game.restartVotes.length
      ? 'A player requested a new round. Waiting for the other player.'
      : ownVote ? 'Request sent. Waiting for the other player to agree.'
      : otherVote ? 'Your friend wants another round. Accept when you’re ready.' : '';
    $('restart-description').textContent = identity.role === 'spectator'
      ? 'The players decide when to begin a new round. You can keep watching.'
      : 'Both players agree before the board clears. The first move alternates each round.';
  }

  async function mutate(event, payload) {
    if (busy || !game) return;
    const current = ++operation;
    showError('game', '');
    setBusy(true);
    try {
      const reply = await request(event, payload);
      if (current !== operation) return;
      if (event === 'room:leave') returnToLobby();
      else if (reply.state) renderGame(reply.state);
    } catch (error) {
      if (current === operation) {
        if (['NOT_IN_ROOM', 'ROOM_NOT_FOUND', 'SESSION_EXPIRED'].includes(error.code)) {
          returnToLobby(error.message);
        } else {
          showError('game', error.message);
          // A lost leave acknowledgment is reconciled by restoring the session.
          if (!error.code && event === 'room:leave') {
            socket.disconnect();
            socket.connect();
          }
        }
      }
    } finally {
      if (current === operation) setBusy(false);
    }
  }

  async function copyText(value, label) {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard is unavailable.');
      await navigator.clipboard.writeText(value);
      notify(`${label} copied. Send it to a friend!`);
    } catch {
      $('copy-dialog-title').textContent = `Copy your ${label.toLowerCase()}`;
      $('copy-fallback').value = value;
      $('copy-dialog').showModal();
      $('copy-fallback').focus();
      $('copy-fallback').select();
    }
  }

  // Create semantic buttons once; all board updates use safe text content.
  for (let index = 0; index < 9; index++) {
    const cell = document.createElement('button');
    cell.id = `cell-${index}`;
    cell.type = 'button';
    cell.className = 'cell empty';
    cell.disabled = true;
    cell.addEventListener('click', () => {
      if (game) mutate('game:move', { index, roundId: game.roundId });
    });
    $('board').append(cell);
  }

  $('create-tab').addEventListener('click', () => setMode('create'));
  $('join-tab').addEventListener('click', () => setMode('join'));
  for (const tab of [$('create-tab'), $('join-tab')]) {
    tab.addEventListener('keydown', (event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        setMode(event.key === 'Home' ? 'create' : event.key === 'End' ? 'join' : mode === 'create' ? 'join' : 'create', true);
      }
    });
  }
  $('join-code').addEventListener('input', () => {
    $('join-code').value = $('join-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  $('room-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !connected) return;
    const name = $('nickname').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name) { showError('lobby', 'Enter a nickname so your friend knows it’s you.'); $('nickname').focus(); return; }
    if (mode === 'join' && !/^[A-Z0-9]{6}$/.test(code)) {
      showError('lobby', 'Enter the full 6-character room code.');
      $('join-code').focus();
      return;
    }
    const current = ++operation;
    showError('lobby', '');
    setBusy(true);
    try {
      const reply = await request(mode === 'create' ? 'room:create' : 'room:join', { name, ...(mode === 'join' ? { code } : {}) });
      if (current !== operation) return;
      try { sessionStorage.setItem(nicknameKey, name); } catch { /* Optional convenience only. */ }
      enterRoom(reply);
    } catch (error) {
      if (current === operation) {
        showError('lobby', error.message);
        // If creation succeeded but its reply was lost, release that unknown seat.
        if (!error.code) {
          try { await request('room:leave'); } catch { /* There may be no room to leave. */ }
          if (current === operation) {
            socket.disconnect();
            socket.connect();
          }
        }
      }
    } finally {
      if (current === operation) setBusy(false);
    }
  });
  $('leave-button').addEventListener('click', () => mutate('room:leave'));
  $('restart-button').addEventListener('click', () => {
    if (game) mutate(
      game.restartVotes.includes(identity.role) ? 'game:restart-cancel' : 'game:restart',
      { roundId: game.roundId }
    );
  });
  $('copy-code').addEventListener('click', () => { if (game) copyText(game.code, 'Room code'); });
  $('copy-link').addEventListener('click', () => {
    if (!game) return;
    const invite = new URL('/', window.location.origin);
    invite.searchParams.set('room', game.code);
    copyText(invite.toString(), 'Invite link');
  });
  $('copy-fallback').addEventListener('click', () => $('copy-fallback').select());

  identity = readStoredIdentity();
  try { $('nickname').value = sessionStorage.getItem(nicknameKey) || ''; } catch { /* Optional convenience only. */ }
  const invitedRoom = new URLSearchParams(window.location.search).get('room');
  if (invitedRoom) {
    $('join-code').value = invitedRoom.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    setMode('join');
  } else setMode('create');

  if (typeof window.io !== 'function') {
    $('connection-text').textContent = 'Unable to connect';
    $('connection-pill').classList.add('offline');
    showError('lobby', 'The game connection couldn’t load. Refresh this page to try again.');
    updateControls();
    return;
  }

  const socket = window.io({ reconnection: true, reconnectionDelay: 750, reconnectionDelayMax: 4000, timeout: 20000 });
  coldStartTimer = setTimeout(() => { if (!connected) $('connection-help').hidden = false; }, 4500);

  socket.on('connect', async () => {
    connected = true;
    connectionStatus();
    if (!identity) return;
    const current = ++operation;
    setBusy(true);
    try {
      const reply = await request('room:resume', { code: identity.code, token: identity.token });
      if (current !== operation) return;
      enterRoom(reply, true);
      if (game) notify('You’re back. Your room is live.');
    } catch (error) {
      if (current !== operation) return;
      if (error.code) returnToLobby(`Your previous room couldn’t be restored. ${error.message}`);
      else {
        showError(game ? 'game' : 'lobby', 'Still restoring your room. We’ll retry the connection automatically.');
        // The resume may have succeeded with a lost reply. A fresh socket safely
        // releases and restores that same token instead of taking another seat.
        socket.disconnect();
        socket.connect();
      }
    } finally {
      if (current === operation) setBusy(false);
    }
  });
  socket.on('disconnect', () => {
    connected = false;
    roomReady = false;
    operation++;
    setBusy(false);
    connectionStatus();
    if (game) renderTurn();
  });
  socket.on('connect_error', () => {
    connected = false;
    connectionStatus();
    $('connection-help').hidden = false;
    if (game) renderTurn();
  });
  socket.on('room:state', (state) => {
    if (identity && state.code === identity.code) {
      renderGame(state);
      showError('game', '');
    }
  });
  socket.on('room:closed', (payload) => {
    returnToLobby(payload?.message || 'This room has closed. Create a new room to play again.');
  });
})();
