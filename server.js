const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// State
const clients = new Map(); // ws -> { id, nick, inGame }
const stats = new Map();   // nick -> { won, lost }
const pendingChallenges = new Map(); // challengerId -> { challengerWs, targetWs, targetNick, challengerNick }
const activeGames = new Map(); // gameId -> { p1ws, p2ws, p1nick, p2nick, p1choice, p2choice, timer }

let idCounter = 0;

function genId() { return ++idCounter; }

function getPlayerList() {
  const list = [];
  for (const [ws, p] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      list.push({ nick: p.nick, inGame: p.inGame });
    }
  }
  return list;
}

function getLeaderboard() {
  const board = [];
  for (const [nick, s] of stats) {
    const ratio = s.lost === 0 ? (s.won > 0 ? '∞' : '—') : (s.won / s.lost).toFixed(2);
    board.push({ nick, won: s.won, lost: s.lost, ratio });
  }
  board.sort((a, b) => {
    const av = parseFloat(a.ratio) || 0;
    const bv = parseFloat(b.ratio) || 0;
    return bv - av;
  });
  return board;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastLobby() {
  broadcast({ type: 'lobby', players: getPlayerList(), leaderboard: getLeaderboard() });
}

function rpsResult(a, b) {
  if (a === b) return 'draw';
  if ((a === 'rock' && b === 'scissors') || (a === 'scissors' && b === 'paper') || (a === 'paper' && b === 'rock')) return 'win';
  return 'lose';
}

function finishGame(gameId, p1choice, p2choice) {
  const game = activeGames.get(gameId);
  if (!game) return;
  clearTimeout(game.timer);
  activeGames.delete(gameId);

  const c1 = p1choice || 'forfeit';
  const c2 = p2choice || 'forfeit';

  let winner, loser, winnerWs, loserWs;
  const result = rpsResult(c1, c2);

  if (c1 === 'forfeit' && c2 === 'forfeit') {
    // double forfeit = draw
    send(game.p1ws, { type: 'result', outcome: 'draw', p1: game.p1nick, p2: game.p2nick, c1: 'forfeit', c2: 'forfeit' });
    send(game.p2ws, { type: 'result', outcome: 'draw', p1: game.p1nick, p2: game.p2nick, c1: 'forfeit', c2: 'forfeit' });
  } else if (result === 'draw') {
    send(game.p1ws, { type: 'result', outcome: 'draw', p1: game.p1nick, p2: game.p2nick, c1, c2 });
    send(game.p2ws, { type: 'result', outcome: 'draw', p1: game.p1nick, p2: game.p2nick, c1, c2 });
  } else if (result === 'win') {
    winner = game.p1nick; loser = game.p2nick; winnerWs = game.p1ws; loserWs = game.p2ws;
    send(winnerWs, { type: 'result', outcome: 'win', winner, loser, c1, c2 });
    send(loserWs, { type: 'result', outcome: 'lose', winner, loser, c1, c2 });
    updateStats(winner, loser);
  } else {
    winner = game.p2nick; loser = game.p1nick; winnerWs = game.p2ws; loserWs = game.p1ws;
    send(winnerWs, { type: 'result', outcome: 'win', winner, loser, c1: c2, c2: c1 });
    send(loserWs, { type: 'result', outcome: 'lose', winner, loser, c1: c2, c2: c1 });
    updateStats(winner, loser);
  }

  // reset inGame
  const p1 = clients.get(game.p1ws);
  const p2 = clients.get(game.p2ws);
  if (p1) p1.inGame = false;
  if (p2) p2.inGame = false;

  broadcastLobby();
}

function updateStats(winner, loser) {
  if (!stats.has(winner)) stats.set(winner, { won: 0, lost: 0 });
  if (!stats.has(loser)) stats.set(loser, { won: 0, lost: 0 });
  stats.get(winner).won++;
  stats.get(loser).lost++;
}

wss.on('connection', (ws) => {
  const id = genId();
  clients.set(ws, { id, nick: null, inGame: false });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const player = clients.get(ws);
    if (!player) return;

    switch (msg.type) {
      case 'join': {
        const nick = String(msg.nick || '').trim().slice(0, 20);
        if (!nick) return;
        // Check duplicate
        for (const [, p] of clients) {
          if (p.nick === nick) {
            send(ws, { type: 'error', text: 'Ник уже занят, братан!' });
            return;
          }
        }
        player.nick = nick;
        if (!stats.has(nick)) stats.set(nick, { won: 0, lost: 0 });
        send(ws, { type: 'joined', nick });
        broadcastLobby();
        break;
      }

      case 'challenge': {
        if (!player.nick || player.inGame) return;
        const targetNick = msg.target;
        let targetWs = null;
        for (const [w, p] of clients) {
          if (p.nick === targetNick && w.readyState === WebSocket.OPEN) { targetWs = w; break; }
        }
        if (!targetWs) { send(ws, { type: 'error', text: 'Игрок не найден!' }); return; }
        const targetPlayer = clients.get(targetWs);
        if (targetPlayer.inGame) { send(ws, { type: 'error', text: 'Игрок уже в игре!' }); return; }

        // store pending
        pendingChallenges.set(player.id, { challengerWs: ws, targetWs, targetNick, challengerNick: player.nick });
        send(targetWs, { type: 'challenged', from: player.nick, challengerId: player.id });
        send(ws, { type: 'challenge_sent', to: targetNick });
        break;
      }

      case 'accept': {
        const cid = msg.challengerId;
        const challenge = pendingChallenges.get(cid);
        if (!challenge) { send(ws, { type: 'error', text: 'Вызов устарел!' }); return; }
        pendingChallenges.delete(cid);

        const cPlayer = clients.get(challenge.challengerWs);
        const tPlayer = clients.get(challenge.targetWs);
        if (!cPlayer || !tPlayer) return;

        const gameId = `${cid}_${genId()}`;
        cPlayer.inGame = true;
        tPlayer.inGame = true;

        activeGames.set(gameId, {
          p1ws: challenge.challengerWs, p2ws: challenge.targetWs,
          p1nick: challenge.challengerNick, p2nick: player.nick,
          p1choice: null, p2choice: null, timer: null
        });

        send(challenge.challengerWs, { type: 'game_start', gameId, opponent: player.nick });
        send(challenge.targetWs, { type: 'game_start', gameId, opponent: challenge.challengerNick });

        broadcastLobby();

        // 6 second timer
        const game = activeGames.get(gameId);
        game.timer = setTimeout(() => {
          finishGame(gameId, game.p1choice, game.p2choice);
        }, 6000);
        break;
      }

      case 'decline': {
        const cid = msg.challengerId;
        const challenge = pendingChallenges.get(cid);
        if (!challenge) return;
        pendingChallenges.delete(cid);
        send(challenge.challengerWs, { type: 'declined', by: player.nick });
        break;
      }

      case 'choice': {
        const gameId = msg.gameId;
        const game = activeGames.get(gameId);
        if (!game) return;
        const choice = msg.choice;
        if (!['rock', 'scissors', 'paper'].includes(choice)) return;

        if (ws === game.p1ws && !game.p1choice) game.p1choice = choice;
        if (ws === game.p2ws && !game.p2choice) game.p2choice = choice;

        if (game.p1choice && game.p2choice) {
          finishGame(gameId, game.p1choice, game.p2choice);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const player = clients.get(ws);
    if (player) {
      // cancel any pending challenges from this player
      pendingChallenges.delete(player.id);
    }
    clients.delete(ws);
    broadcastLobby();
  });
});

server.listen(PORT, () => {
  console.log(`GACHI RPS server running on port ${PORT}`);
});
