const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---- State ----
const clients = new Map();   // ws -> { id, nick, x, y, inDungeon, inBattle }
const stats = new Map();     // nick -> { won, lost }
const pendingEncounters = new Map(); // challengerId -> { cWs, tWs, cNick, tNick }
const activeQTEs = new Map(); // gameId -> { p1ws, p2ws, p1nick, p2nick, p1done, p2done, round, timer }

let idCounter = 0;
const genId = () => ++idCounter;

// ---- Helpers ----
function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data, onlyDungeon = false) {
  const msg = JSON.stringify(data);
  for (const [ws, p] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (onlyDungeon && !p.inDungeon) continue;
    ws.send(msg);
  }
}

function broadcastLobby() {
  const players = [];
  for (const [ws, p] of clients) {
    if (ws.readyState === WebSocket.OPEN)
      players.push({ nick: p.nick, inGame: p.inDungeon || p.inBattle });
  }
  const lb = getLeaderboard();
  broadcast({ type: 'lobby', players, leaderboard: lb });
}

function getLeaderboard() {
  const board = [];
  for (const [nick, s] of stats) {
    const ratio = s.lost === 0 ? (s.won > 0 ? '∞' : '—') : (s.won / s.lost).toFixed(2);
    board.push({ nick, won: s.won, lost: s.lost, ratio });
  }
  board.sort((a, b) => (parseFloat(b.ratio) || 0) - (parseFloat(a.ratio) || 0));
  return board;
}

function broadcastPlayerList() {
  const players = [];
  for (const [ws, p] of clients) {
    if (ws.readyState === WebSocket.OPEN && p.inDungeon)
      players.push({ id: p.id, nick: p.nick, x: p.x, y: p.y });
  }
  broadcast({ type: 'player_list', players }, true);
}

function broadcastLog(text) {
  broadcast({ type: 'log', text });
}

// ---- Connection handler ----
wss.on('connection', (ws) => {
  const id = genId();
  clients.set(ws, { id, nick: null, x: 1, y: 1, inDungeon: false, inBattle: false });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const player = clients.get(ws);
    if (!player) return;

    switch (msg.type) {

      case 'join': {
        const nick = String(msg.nick || '').trim().slice(0, 18);
        if (!nick) return;
        for (const [, p] of clients) {
          if (p.nick === nick) { send(ws, { type: 'error', text: 'Ник занят, братан!' }); return; }
        }
        player.nick = nick;
        if (!stats.has(nick)) stats.set(nick, { won: 0, lost: 0 });
        send(ws, { type: 'joined', nick, id });
        broadcastLobby();
        broadcastLog(`⛓ ${nick} вошёл в данжон`);
        break;
      }

      case 'enter_dungeon': {
        if (!player.nick) return;
        player.inDungeon = true;
        player.x = 1; player.y = 1;
        // Send existing players to newcomer
        const existing = [];
        for (const [w, p] of clients) {
          if (w !== ws && w.readyState === WebSocket.OPEN && p.inDungeon)
            existing.push({ id: p.id, nick: p.nick, x: p.x, y: p.y });
        }
        send(ws, { type: 'player_list', players: existing });
        // Notify others
        broadcast({ type: 'player_move', id: player.id, nick: player.nick, x: player.x, y: player.y }, true);
        broadcastLobby();
        break;
      }

      case 'leave_dungeon': {
        player.inDungeon = false;
        broadcast({ type: 'player_left', id: player.id }, true);
        broadcastLobby();
        break;
      }

      case 'move': {
        if (!player.inDungeon || player.inBattle) return;
        player.x = msg.x; player.y = msg.y;
        broadcast({ type: 'player_move', id: player.id, nick: player.nick, x: player.x, y: player.y }, true);
        break;
      }

      case 'encounter': {
        // Player walked into another
        if (!player.inDungeon || player.inBattle) return;
        let targetWs = null;
        for (const [w, p] of clients) {
          if (p.id === msg.targetId && w.readyState === WebSocket.OPEN) { targetWs = w; break; }
        }
        if (!targetWs) return;
        const target = clients.get(targetWs);
        if (!target || target.inBattle || !target.inDungeon) return;
        // Store pending
        pendingEncounters.set(player.id, { cWs: ws, tWs: targetWs, cNick: player.nick, tNick: target.nick });
        send(targetWs, { type: 'encounter_request', challengerId: player.id, from: player.nick });
        break;
      }

      case 'encounter_accept': {
        const enc = pendingEncounters.get(msg.challengerId);
        if (!enc) return;
        pendingEncounters.delete(msg.challengerId);
        const cPlayer = clients.get(enc.cWs);
        const tPlayer = clients.get(enc.tWs);
        if (!cPlayer || !tPlayer) return;
        cPlayer.inBattle = true;
        tPlayer.inBattle = true;
        const gameId = `${msg.challengerId}_${genId()}`;
        activeQTEs.set(gameId, {
          p1ws: enc.cWs, p2ws: enc.tWs,
          p1nick: enc.cNick, p2nick: enc.tNick,
          p1done: null, p2done: null,
          round: 1,
          timer: null
        });
        send(enc.cWs, { type: 'battle_start', gameId, opponent: enc.tNick, round: 1 });
        send(enc.tWs, { type: 'battle_start', gameId, opponent: enc.cNick, round: 1 });
        broadcastLog(`⚔ ${enc.cNick} vs ${enc.tNick} — СХВАТКА!`);
        // Auto-resolve timer
        const game = activeQTEs.get(gameId);
        game.timer = setTimeout(() => resolveQTE(gameId), 7000);
        break;
      }

      case 'encounter_decline': {
        pendingEncounters.delete(msg.challengerId);
        break;
      }

      case 'qte_result': {
        // Find game this player is in
        let gameId = null, isP1 = false;
        for (const [gid, g] of activeQTEs) {
          if (g.p1ws === ws) { gameId = gid; isP1 = true; break; }
          if (g.p2ws === ws) { gameId = gid; isP1 = false; break; }
        }
        if (!gameId) return;
        const game = activeQTEs.get(gameId);
        const result = msg.result; // 'success' or 'timeout'
        if (isP1) game.p1done = result;
        else game.p2done = result;
        // Check if both done
        if (game.p1done !== null && game.p2done !== null) {
          clearTimeout(game.timer);
          resolveQTE(gameId);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const player = clients.get(ws);
    if (player) {
      if (player.inDungeon) broadcast({ type: 'player_left', id: player.id }, true);
      pendingEncounters.delete(player.id);
      if (player.nick) broadcastLog(`🚪 ${player.nick} покинул данжон`);
    }
    clients.delete(ws);
    broadcastLobby();
  });
});

function resolveQTE(gameId) {
  const game = activeQTEs.get(gameId);
  if (!game) return;
  clearTimeout(game.timer);
  activeQTEs.delete(gameId);

  const p1 = game.p1done === 'success';
  const p2 = game.p2done === 'success';

  if (p1 === p2) {
    // Draw — new round, faster
    const nextRound = game.round + 1;
    if (nextRound > 5) {
      // Force winner randomly after 5 draws
      const coin = Math.random() < 0.5;
      finishBattle(gameId, game, coin ? game.p1nick : game.p2nick, coin ? game.p2nick : game.p1nick, coin ? game.p1ws : game.p2ws, coin ? game.p2ws : game.p1ws);
      return;
    }
    const newGameId = `${gameId}_r${nextRound}`;
    activeQTEs.set(newGameId, {
      p1ws: game.p1ws, p2ws: game.p2ws,
      p1nick: game.p1nick, p2nick: game.p2nick,
      p1done: null, p2done: null,
      round: nextRound, timer: null
    });
    send(game.p1ws, { type: 'qte_draw', opponent: game.p2nick, round: nextRound });
    send(game.p2ws, { type: 'qte_draw', opponent: game.p1nick, round: nextRound });
    const ng = activeQTEs.get(newGameId);
    ng.timer = setTimeout(() => resolveQTE(newGameId), Math.max(3000, 7000 - nextRound * 1000));
  } else if (p1 && !p2) {
    finishBattle(gameId, game, game.p1nick, game.p2nick, game.p1ws, game.p2ws);
  } else {
    finishBattle(gameId, game, game.p2nick, game.p1nick, game.p2ws, game.p1ws);
  }
}

function finishBattle(gameId, game, winnerNick, loserNick, winnerWs, loserWs) {
  // Update stats
  if (!stats.has(winnerNick)) stats.set(winnerNick, { won:0, lost:0 });
  if (!stats.has(loserNick)) stats.set(loserNick, { won:0, lost:0 });
  stats.get(winnerNick).won++;
  stats.get(loserNick).lost++;

  send(winnerWs, { type: 'qte_outcome', outcome: 'win', winner: winnerNick, loser: loserNick });
  send(loserWs, { type: 'qte_outcome', outcome: 'lose', winner: winnerNick, loser: loserNick });

  // Reset inBattle
  const wp = clients.get(winnerWs);
  const lp = clients.get(loserWs);
  if (wp) wp.inBattle = false;
  if (lp) { lp.inBattle = false; lp.x = 1; lp.y = 1; }

  // Notify others of loser's reset
  if (lp) broadcast({ type: 'player_move', id: lp.id, nick: lp.nick, x:1, y:1 }, true);

  broadcastLog(`★ ${winnerNick} захватил ${loserNick}!`);
  broadcastLobby();
}

server.listen(PORT, () => console.log(`HARD DOJO server on port ${PORT}`));
