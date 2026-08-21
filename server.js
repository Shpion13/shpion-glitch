const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;
const rooms = {};

const WORDS = {
  movies: ['Титаник','Аватар','Матрица','Начало','Интерстеллар','Джокер','Форрест Гамп','Бойцовский клуб','Побег из Шоушенка'],
  series: ['Друзья','Ведьмак','Шерлок','Очень странные дела','Игра Престолов','Во все тяжкие','Мандалорец','Пацаны'],
  games: ['Minecraft','Cyberpunk 2077','The Witcher 3','Portal','Among Us','Elden Ring','Terraria','Stardew Valley'],
  nature: ['Лес','Гора','Море','Вулкан','Радуга','Пустыня','Водопад','Пещера'],
  space: ['Марс','Луна','Чёрная дыра','МКС','Солнце','Комета','Туманность','Галактика'],
  items: ['Зонт','Фонарик','Часы','Ключи','Телефон','Очки','Рюкзак','Кошелёк'],
  ecology: ['Переработка','Загрязнение','Вымирание','Наводнение','Засуха','Озон','Парниковый эффект'],
  youtubers: ['MrBeast','PewDiePie','Morgenshtern','FixPrice','EeOneGuy','Братья Наговицыны'],
  minecraft: ['Крипер','Эндермен','Незер','Энд','Алмаз','Зелье','Зачарование','Красная пыль'],
  ai: ['ChatGPT','Midjourney','Нейросеть','Токен','Промт','Diffusion','Transformer']
};

function genCode() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let r = '';
  for (let i = 0; i < 4; i++) r += c[Math.floor(Math.random() * 26)];
  return r;
}

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function findRoom(ws) {
  for (const r of Object.values(rooms)) if (r.conns.has(ws)) return r;
  return null;
}

function findPlayer(ws) {
  for (const r of Object.values(rooms)) {
    for (const [pid, c] of r.conns) {
      if (c === ws) return { room: r, pid };
    }
  }
  return { room: null, pid: null };
}

function plist(r) {
  return r.players.map(p => ({ name: r.names.get(p), id: p }));
}

function broadcast(r, msg, excl) {
  const d = JSON.stringify(msg);
  for (const [pid, c] of r.conns) {
    if (c !== excl && c.readyState === 1) {
      try { c.send(d); } catch (e) {}
    }
  }
}

function resolveVotes(r) {
  const v = {};
  for (const [pid, vi] of Object.entries(r.votes)) v[vi] = (v[vi] || 0) + 1;
  const arr = r.players.map((_, i) => v[i] || 0);
  const mx = Math.max(...Object.values(v), 0);
  const tied = Object.entries(v).filter(([, val]) => val === mx && mx > 0).map(([idx]) => +idx).sort((a, b) => a - b);
  const players = plist(r);
  const si = [...r.spy_indices];
  const w = r.game_word;

  if (tied.length > 1) {
    r.tb_round = (r.tb_round || 0) + 1;
    r.tied_players = tied;
    r.tb_votes = {};
    broadcast(r, { type: 'vote_tiebreaker', tiedPlayers: tied, votes: arr, players, round: r.tb_round });
  } else {
    const mv = tied.length ? tied[0] : 0;
    if (si.includes(mv)) r.civScore++; else r.spyScore++;
    r.game_started = false;
    const p = { votes: arr, mostVoted: mv, spyIndices: si, word: w, players, civScore: r.civScore, spyScore: r.spyScore };
    if (r.civScore >= 3 || r.spyScore >= 3) broadcast(r, { type: 'game_over', ...p });
    else broadcast(r, { type: 'vote_result', ...p, round: r.round });
  }
}

function resolveTB(r, tied) {
  const v = {};
  for (const [pid, vi] of Object.entries(r.tb_votes)) {
    if (tied.includes(+vi)) v[vi] = (v[vi] || 0) + 1;
  }
  const arr = r.players.map((_, i) => v[i] || 0);
  const mx = Math.max(...Object.values(v), 0);
  const nt = Object.entries(v).filter(([, val]) => val === mx && mx > 0).map(([idx]) => +idx).sort((a, b) => a - b);
  const players = plist(r);
  const si = [...r.spy_indices];
  const w = r.game_word;

  if (nt.length > 1) {
    r.tb_round = (r.tb_round || 0) + 1;
    r.tied_players = nt;
    r.tb_votes = {};
    broadcast(r, { type: 'vote_tiebreaker', tiedPlayers: nt, votes: arr, players, round: r.tb_round });
  } else {
    const mv = nt.length ? nt[0] : 0;
    if (si.includes(mv)) r.civScore++; else r.spyScore++;
    r.game_started = false;
    const p = { votes: arr, mostVoted: mv, spyIndices: si, word: w, players, civScore: r.civScore, spyScore: r.spyScore };
    if (r.civScore >= 3 || r.spyScore >= 3) broadcast(r, { type: 'game_over', ...p });
    else broadcast(r, { type: 'vote_result', ...p, round: r.round });
  }
}

function handleDisconnect(ws) {
  const { room: r, pid } = findPlayer(ws);
  if (!r || !pid) return;
  r.players = r.players.filter(p => p !== pid);
  r.names.delete(pid);
  r.conns.delete(pid);
  if (r.players.length > 0) broadcast(r, { type: 'player_left', players: plist(r) });
  else {
    for (const [code, rm] of Object.entries(rooms)) {
      if (rm === r) { delete rooms[code]; break; }
    }
  }
}

function handleMessage(ws, msg) {
  const t = msg.type;

  if (t === 'create_room') {
    let code = genCode();
    while (rooms[code]) code = genCode();
    const me = crypto.randomUUID();
    const pw = (msg.password || '').trim();
    rooms[code] = {
      players: [me], names: new Map([[me, msg.name]]), conns: new Map([[me, ws]]),
      host: me, password: pw, game_started: false, revealed: new Set(),
      round: 1, civScore: 0, spyScore: 0, banned: new Set(),
      votes: {}, tb_votes: {}, tied_players: [], tb_round: 0,
      disc_order: [], disc_idx: 0, game_word: '', game_mode: 'classic', spy_indices: new Set(),
    };
    ws._me = me;
    ws._code = code;
    ws.send(JSON.stringify({ type: 'room_created', playerId: me, roomCode: code, players: plist(rooms[code]) }));
  }

  else if (t === 'join_room') {
    const code = (msg.roomCode || '').toUpperCase();
    const pw = (msg.password || '').trim();
    if (!rooms[code]) { ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' })); return; }
    const r = rooms[code];
    if (r.game_started) { ws.send(JSON.stringify({ type: 'error', message: 'Игра уже идёт' })); return; }
    if (r.players.length >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена' })); return; }
    if (r.password && pw !== r.password) { ws.send(JSON.stringify({ type: 'error', message: 'Неверный пароль' })); return; }
    const me = crypto.randomUUID();
    if (r.banned.has(me)) { ws.send(JSON.stringify({ type: 'error', message: 'Вы заблокированы' })); return; }
    r.players.push(me);
    r.names.set(me, msg.name);
    r.conns.set(me, ws);
    ws._me = me;
    ws._code = code;
    ws.send(JSON.stringify({ type: 'room_joined', playerId: me, roomCode: code, players: plist(r) }));
    broadcast(r, { type: 'player_joined', players: plist(r) }, ws);
  }

  else if (t === 'kick_player') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (!r || pid !== r.host) return;
    const tgt = msg.playerId;
    if (tgt && r.players.includes(tgt) && tgt !== pid) {
      r.players = r.players.filter(p => p !== tgt);
      r.names.delete(tgt);
      const kws = r.conns.get(tgt);
      r.conns.delete(tgt);
      r.banned.add(tgt);
      broadcast(r, { type: 'player_kicked', players: plist(r), kickedName: msg.kickedName || '' });
      if (kws) { try { kws.send(JSON.stringify({ type: 'kicked', message: 'Вы удалены из комнаты' })); kws.close(); } catch (e) {} }
    }
  }

  else if (t === 'start_game') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (!r || pid !== r.host) return;
    if (r.players.length < 3) { ws.send(JSON.stringify({ type: 'error', message: 'Нужно минимум 3 игрока' })); return; }
    r.game_started = true;
    r.revealed = new Set();
    r.votes = {};
    r.tb_votes = {};
    r.tied_players = [];
    r.disc_order = [];
    r.disc_idx = 0;
    r.banned = new Set();
    const themes = (msg.settings && msg.settings.themes) || ['movies'];
    const theme = pick(themes);
    const pool = WORDS[theme] || WORDS.movies;
    const word = pick(pool);
    const similar = pool.length > 1 ? pick(pool.filter(w => w !== word)) : word;
    const mode = (msg.settings && msg.settings.mode) || 'classic';
    const sc = r.players.length <= 5 ? 1 : 2;
    const si = new Set(shuffle(r.players.map((_, i) => i)).slice(0, sc));
    r.game_word = word;
    r.game_mode = mode;
    r.spy_indices = si;
    broadcast(r, { type: 'game_started', themeEmoji: '❓', themeLabel: theme });
    for (let i = 0; i < r.players.length; i++) {
      const p = r.players[i];
      const c = r.conns.get(p);
      if (c && c.readyState === 1) {
        const isSpy = si.has(i);
        const w = (isSpy && mode === 'similar') ? similar : word;
        c.send(JSON.stringify({ type: 'your_role', playerIndex: i, isSpy, word: w, mode, totalPlayers: r.players.length, round: r.round, civScore: r.civScore, spyScore: r.spyScore }));
      }
    }
  }

  else if (t === 'player_revealed') {
    const r = findRoom(ws);
    if (r) {
      r.revealed.add(String(msg.playerIndex));
      if (r.revealed.size >= r.players.length) broadcast(r, { type: 'all_revealed', players: plist(r), round: r.round, civScore: r.civScore, spyScore: r.spyScore });
    }
  }

  else if (t === 'chat') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid) broadcast(r, { type: 'chat', from: r.names.get(pid) || 'Игрок', text: (msg.text || '').slice(0, 500), playerId: pid, time: Date.now() });
  }

  else if (t === 'start_discussion') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid === r.host) {
      const order = shuffle(r.players.map((_, i) => i));
      r.disc_order = order;
      r.disc_idx = 0;
      broadcast(r, { type: 'discussion_started', order, currentIndex: 0, players: plist(r) });
      broadcast(r, { type: 'discussion_turn', playerIndex: order[0], order, pos: 0, isLast: order.length === 1 });
    }
  }

  else if (t === 'next_speaker') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid === r.host) {
      const o = r.disc_order;
      const c = r.disc_idx;
      if (o && c < o.length - 1) {
        const ni = c + 1;
        r.disc_idx = ni;
        broadcast(r, { type: 'discussion_turn', playerIndex: o[ni], order: o, pos: ni, isLast: ni >= o.length - 1 });
      }
    }
  }

  else if (t === 'speaker_done') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r) broadcast(r, { type: 'speaker_done_ack', playerId: pid });
  }

  else if (t === 'start_voting') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid === r.host) {
      r.votes = {};
      r.tb_round = 0;
      broadcast(r, { type: 'voting_started', players: plist(r) });
    }
  }

  else if (t === 'vote') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid && r.players.includes(pid) && msg.voteIndex !== undefined) {
      r.votes[pid] = msg.voteIndex;
      ws.send(JSON.stringify({ type: 'vote_ack' }));
      if (Object.keys(r.votes).length >= r.players.length) resolveVotes(r);
    }
  }

  else if (t === 'tiebreaker_vote') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid && r.players.includes(pid) && msg.voteIndex !== undefined) {
      r.tb_votes[pid] = msg.voteIndex;
      ws.send(JSON.stringify({ type: 'vote_ack' }));
      if (Object.keys(r.tb_votes).length >= r.players.length) resolveTB(r, r.tied_players || []);
    }
  }

  else if (t === 'next_round') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid === r.host) {
      r.game_started = true;
      r.revealed = new Set();
      r.votes = {};
      r.tb_votes = {};
      r.tied_players = [];
      r.disc_order = [];
      r.disc_idx = 0;
      r.round++;
      const theme = pick(Object.keys(WORDS));
      const pool = WORDS[theme];
      const word = pick(pool);
      const similar = pool.length > 1 ? pick(pool.filter(w => w !== word)) : word;
      const sc = r.players.length <= 5 ? 1 : 2;
      const si = new Set(shuffle(r.players.map((_, i) => i)).slice(0, sc));
      r.game_word = word;
      r.spy_indices = si;
      broadcast(r, { type: 'game_started', themeEmoji: '🔄', themeLabel: 'Раунд ' + r.round });
      for (let i = 0; i < r.players.length; i++) {
        const p = r.players[i];
        const c = r.conns.get(p);
        if (c && c.readyState === 1) {
          const isSpy = si.has(i);
          const w = (isSpy && r.game_mode === 'similar') ? similar : word;
          c.send(JSON.stringify({ type: 'your_role', playerIndex: i, isSpy, word: w, mode: r.game_mode, totalPlayers: r.players.length, round: r.round, civScore: r.civScore, spyScore: r.spyScore }));
        }
      }
    }
  }

  else if (t === 'restart_game') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid === r.host) {
      r.game_started = false;
      r.revealed = new Set();
      r.votes = {};
      r.disc_order = [];
      r.disc_idx = 0;
      r.round = 1;
      r.civScore = 0;
      r.spyScore = 0;
      r.tb_round = 0;
      r.tied_players = [];
      r.tb_votes = {};
      r.banned = new Set();
      broadcast(r, { type: 'game_restarted', players: plist(r) });
    }
  }

  else if (t === 'leave_room') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid) {
      r.players = r.players.filter(p => p !== pid);
      r.names.delete(pid);
      r.conns.delete(pid);
      if (r.players.length > 0) broadcast(r, { type: 'player_left', players: plist(r) });
      else {
        for (const [code, rm] of Object.entries(rooms)) {
          if (rm === r) { delete rooms[code]; break; }
        }
      }
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try { handleMessage(ws, JSON.parse(data.toString())); } catch (e) {}
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

server.listen(PORT, () => {
  console.log('=== Shpion Server (Node.js) ===');
  console.log('Port: ' + PORT);
});
