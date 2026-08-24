const http = require('http');
const fs = require('fs');
const path = require('path');
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
  for (const r of Object.values(rooms)) {
    for (const [, c] of r.conns) {
      if (c === ws) return r;
    }
  }
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
  return r.players.map(p => {
    const name = r.names.get(p);
    const acc = findAccountByNick(name);
    return { name, id: p, rating: r.ratings.get(p) || 0, frame: acc ? (acc.frame || 'default') : 'default', muted: isMuted(name) };
  });
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
    if (!Array.isArray(r.vote_history)) r.vote_history = [];
    r.vote_history.push({ votes: Object.assign({}, r.votes), ejected: mv, wasSpy: si.includes(mv) });
    if (si.includes(mv)) r.civScore++; else r.spyScore++;
    r.game_started = false;
    const p = { votes: arr, mostVoted: mv, spyIndices: si, word: w, players, civScore: r.civScore, spyScore: r.spyScore };
    if (r.civScore >= 3 || r.spyScore >= 3) {
      broadcast(r, { type: 'game_over', ...p });
      finishRatedGame(r);
    }
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
    if (!Array.isArray(r.vote_history)) r.vote_history = [];
    r.vote_history.push({ votes: Object.assign({}, r.tb_votes), ejected: mv, wasSpy: si.includes(mv) });
    if (si.includes(mv)) r.civScore++; else r.spyScore++;
    r.game_started = false;
    const p = { votes: arr, mostVoted: mv, spyIndices: si, word: w, players, civScore: r.civScore, spyScore: r.spyScore };
    if (r.civScore >= 3 || r.spyScore >= 3) {
      broadcast(r, { type: 'game_over', ...p });
      finishRatedGame(r);
    }
    else broadcast(r, { type: 'vote_result', ...p, round: r.round });
  }
}

function handleDisconnect(ws) {
  const info = onlineClients.get(ws);
  if (info && info.nickname) {
    for (const [c] of onlineClients) {
      if (c !== ws) {
        try { c.send(JSON.stringify({ type: 'user_offline', nickname: info.nickname })); } catch(e) {}
      }
    }
    onlineClients.delete(ws);
  }
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

  if (t === 'login') {
    const result = handleAuth(msg);
    ws.send(JSON.stringify({ type: 'login_result', ...result }));
    return;
  }

  if (t === 'register') {
    const result = handleRegister(msg);
    ws.send(JSON.stringify({ type: 'register_result', ...result }));
    return;
  }

  if (t === 'login_by_nick') {
    const result = handleLoginByNick(msg);
    ws.send(JSON.stringify({ type: 'login_result', ...result }));
    return;
  }

  if (t === 'link_tg') {
    const result = handleLinkTG(msg);
    ws.send(JSON.stringify({ type: 'link_tg_result', ...result }));
    return;
  }

  if (t === 'admin_set_account') {
    if (msg.key !== 'gerashpionadmin2026') return ws.send(JSON.stringify({ type: 'error', message: 'Bad key' }));
    const acc = findAccountByNick(msg.nickname);
    if (!acc) return ws.send(JSON.stringify({ type: 'error', message: 'Account not found' }));
    const a = accounts[acc.id];
    a.stats = { games: 999, wins: 999, losses: 1, spyGames: 500, spyWins: 500, rating: 9999 };
    a.frame = 'r_ge';
    a.achievements = ['games_1','games_10','games_25','games_50','games_100','wins_5','wins_15','wins_30','spy_win_3','spy_win_10','rating_50','rating_150','rating_300','winrate_70','spy_winrate','rank_silver','rank_gold','rank_eagle','rank_ak47','rank_global','rank_plat','rank_diamond','rank_elite','rank_master','rank_champion','rank_unreal','rank_legend','rank_immortal','rank_ge'];
    saveAccounts();
    ws.send(JSON.stringify({ type: 'admin_set_account_result', ok: true }));
    return;
  }

  // === ADMIN PANEL ===
  function adminCheck(m) {
    const info = onlineClients.get(ws);
    return info && isAdminNick(info.nickname);
  }

  if (t === 'get_admin_data') {
    if (!adminCheck()) { ws.send(JSON.stringify({ type: 'error', message: 'Нет прав' })); return; }
    const list = Object.values(accounts).map(a => ({
      nickname: a.nickname,
      stats: a.stats || {},
      banned: isBanned(a.nickname),
      muted: isMuted(a.nickname),
      reports: reports.list.filter(rp => rp.target.toLowerCase() === a.nickname.toLowerCase()).length,
      frame: a.frame || 'default',
      achCount: (a.achievements || []).length
    }));
    const online = [];
    for (const [, info] of onlineClients) if (info.nickname && !online.includes(info.nickname)) online.push(info.nickname);
    ws.send(JSON.stringify({ type: 'admin_data', players: list, online, bannedNicks: Object.keys(banned) }));
    return;
  }

  if (t === 'admin_ban') {
    if (!adminCheck()) return;
    const nick = (msg.target || '').trim();
    const acc = findAccountByNick(nick);
    if (!acc) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Аккаунт не найден' })); return; }
    if (isAdminNick(nick)) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Нельзя банить админа' })); return; }
    banned[nick.toLowerCase()] = { by: msg.by || '?', at: new Date().toISOString() };
    saveBanned();
    for (const [c, info] of onlineClients) {
      if (info.nickname && info.nickname.toLowerCase() === nick.toLowerCase()) {
        try { c.close(4003, 'Banned'); } catch(e) {}
        onlineClients.delete(c);
        broadcastAll({ type: 'user_offline', nickname: info.nickname });
      }
    }
    ws.send(JSON.stringify({ type: 'toast', text: '🚫 ' + nick + ' забанен' }));
    return;
  }

  if (t === 'admin_unban') {
    if (!adminCheck()) return;
    delete banned[(msg.target || '').toLowerCase()];
    saveBanned();
    ws.send(JSON.stringify({ type: 'toast', text: '✅ ' + msg.target + ' разбанен' }));
    return;
  }

  if (t === 'admin_mute') {
    if (!adminCheck()) return;
    const nick = (msg.target || '').trim();
    if (!findAccountByNick(nick)) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Аккаунт не найден' })); return; }
    if (isAdminNick(nick.toLowerCase())) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Нельзя мутить админа' })); return; }
    setMuted(nick, msg.by || 'admin');
    for (const [c, info] of onlineClients) {
      if (info.nickname && info.nickname.toLowerCase() === nick.toLowerCase()) {
        try { c.send(JSON.stringify({ type: 'toast', text: '🔇 Ты получил мут от администрации' })); } catch(e) {}
      }
    }
    ws.send(JSON.stringify({ type: 'toast', text: '🔇 ' + nick + ' замучен' }));
    return;
  }

  if (t === 'admin_unmute') {
    if (!adminCheck()) return;
    unsetMuted((msg.target || '').trim());
    ws.send(JSON.stringify({ type: 'toast', text: '🔊 ' + msg.target + ' размучен' }));
    return;
  }

  if (t === 'admin_setstats') {
    if (!adminCheck()) return;
    const acc = findAccountByNick((msg.target || '').trim());
    if (!acc) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Аккаунт не найден' })); return; }
    const s = msg.stats || {};
    accounts[acc.id].stats = {
      games: Math.max(0, parseInt(s.games) || 0),
      wins: Math.max(0, parseInt(s.wins) || 0),
      losses: Math.max(0, parseInt(s.losses) || 0),
      spyGames: Math.max(0, parseInt(s.spyGames) || 0),
      spyWins: Math.max(0, parseInt(s.spyWins) || 0),
      rating: Math.max(0, Math.min(99999, parseInt(s.rating) || 0))
    };
    if (msg.frame !== undefined) accounts[acc.id].frame = msg.frame;
    if (Array.isArray(msg.achievements)) accounts[acc.id].achievements = msg.achievements;
    saveAccounts();
    ws.send(JSON.stringify({ type: 'toast', text: '✅ Статы ' + msg.target + ' обновлены' }));
    return;
  }

  if (t === 'admin_maxout') {
    if (!adminCheck()) return;
    const acc = findAccountByNick((msg.target || '').trim());
    if (!acc) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Аккаунт не найден' })); return; }
    const a = accounts[acc.id];
    a.stats = { games: 999, wins: 999, losses: 1, spyGames: 500, spyWins: 500, rating: 9999 };
    a.frame = 'r_ge';
    a.achievements = ['games_1','games_10','games_25','games_50','games_100','wins_5','wins_15','wins_30','spy_win_3','spy_win_10','rating_50','rating_150','rating_300','winrate_70','spy_winrate','rank_silver','rank_gold','rank_eagle','rank_ak47','rank_global','rank_plat','rank_diamond','rank_elite','rank_master','rank_champion','rank_unreal','rank_legend','rank_immortal','rank_ge'];
    saveAccounts();
    ws.send(JSON.stringify({ type: 'toast', text: '✅ ' + msg.target + ' прокачан на максимум!' }));
    return;
  }

  if (t === 'admin_kick') {
    if (!adminCheck()) return;
    const nick = (msg.target || '').trim();
    let kicked = false;
    for (const [pid, c] of allRoomConns()) {
      const { room, pid: p } = findPlayer(c);
      if (room && room.names.get(p) && room.names.get(p).toLowerCase() === nick.toLowerCase()) {
        try { c.close(4002, 'Kicked'); } catch(e) {}
        kicked = true;
      }
    }
    ws.send(JSON.stringify({ type: 'toast', text: kicked ? '👢 ' + nick + ' кикнут из комнаты' : '⚠️ Не найден в комнате' }));
    return;
  }

  // === ACHIEVEMENTS ===
  if (t === 'get_achievements') {
    const info = onlineClients.get(ws);
    const nick = info ? info.nickname : (msg.nickname || '').trim();
    if (nick) {
      const data = getAchievements(nick);
      ws.send(JSON.stringify({ type: 'achievements_data', ...data }));
    }
    return;
  }

  if (t === 'set_frame') {
    const info = onlineClients.get(ws);
    const nick = info ? info.nickname : (msg.nickname || '').trim();
    if (nick) {
      const result = setFrame(nick, msg.frame);
      ws.send(JSON.stringify({ type: 'set_frame_result', ...result }));
    }
    return;
  }

  if (t === 'get_profile') {
    const target = (msg.nickname || '').trim();
    if (target) {
      const profile = getAccountProfile(target);
      ws.send(JSON.stringify({ type: 'profile_data', profile }));
    }
    return;
  }

  // === CHAT ===
  if (t === 'chat_join') {
    const nick = (msg.nickname || '').trim();
    if (nick) {
      onlineClients.set(ws, { nickname: nick, lastPing: Date.now() });
      ws.send(JSON.stringify({ type: 'chat_history', messages: chatMessages.slice(-50) }));
      for (const [c, info] of onlineClients) {
        if (c !== ws) {
          try { c.send(JSON.stringify({ type: 'user_online', nickname: nick })); } catch(e) {}
        }
      }
    }
    return;
  }

  if (t === 'chat_send') {
    const info = onlineClients.get(ws);
    if (info && msg.text) {
      if (isMuted(info.nickname)) { try { ws.send(JSON.stringify({ type: 'toast', text: '🔇 Ты в муте — чат недоступен' })); } catch(e) {} return; }
      addChatMessage(info.nickname, msg.text.slice(0, 500));
    }
    return;
  }

  if (t === 'chat_ping') {
    const info = onlineClients.get(ws);
    if (info) info.lastPing = Date.now();
    return;
  }

  if (t === 'online_list') {
    const list = [];
    for (const [, info] of onlineClients) {
      if (info.nickname && !list.includes(info.nickname)) list.push(info.nickname);
    }
    ws.send(JSON.stringify({ type: 'online_list', players: list }));
    return;
  }

  // === FRIENDS ===
  if (t === 'friend_add') {
    const info = onlineClients.get(ws);
    if (!info) { ws.send(JSON.stringify({ type: 'friend_add_result', ok: false, error: 'Войди в чат' })); return; }
    const result = sendFriendRequest(info.nickname, (msg.target || '').trim());
    ws.send(JSON.stringify({ type: 'friend_add_result', ...result }));
    return;
  }

  if (t === 'friend_accept') {
    const info = onlineClients.get(ws);
    if (!info) return;
    const result = acceptFriend(info.nickname, (msg.from || '').trim());
    ws.send(JSON.stringify({ type: 'friend_accept_result', ...result }));
    return;
  }

  if (t === 'friend_reject') {
    const info = onlineClients.get(ws);
    if (!info) return;
    const result = rejectFriend(info.nickname, (msg.from || '').trim());
    ws.send(JSON.stringify({ type: 'friend_reject_result', ...result }));
    return;
  }

  if (t === 'friend_remove') {
    const info = onlineClients.get(ws);
    if (!info) return;
    const result = removeFriend(info.nickname, (msg.target || '').trim());
    ws.send(JSON.stringify({ type: 'friend_remove_result', ...result }));
    return;
  }

  if (t === 'friend_list') {
    const info = onlineClients.get(ws);
    if (!info) { ws.send(JSON.stringify({ type: 'friend_list', friends: [], requests: [] })); return; }
    ws.send(JSON.stringify({ type: 'friend_list', friends: getFriendsList(info.nickname), requests: getFriendRequests(info.nickname) }));
    return;
  }

  if (t === 'friend_invite') {
    const info = onlineClients.get(ws);
    if (!info) return;
    const target = (msg.target || '').trim();
    const code = (msg.roomCode || '').trim();
    notifyUser(target, { type: 'friend_invite', from: info.nickname, roomCode: code });
    ws.send(JSON.stringify({ type: 'friend_invite_sent', target }));
    return;
  }

  if (t === 'create_room') {
    let code = genCode();
    while (rooms[code]) code = genCode();
    const me = crypto.randomUUID();
    const pw = (msg.password || '').trim();
    rooms[code] = {
      players: [me], names: new Map([[me, msg.name]]), conns: new Map([[me, ws]]),
      ratings: new Map([[me, msg.rating || 0]]),
      host: me, password: pw, game_started: false, revealed: new Set(),
      round: 1, civScore: 0, spyScore: 0, banned: new Set(),
      votes: {}, tb_votes: {}, tied_players: [], tb_round: 0,
      disc_order: [], disc_idx: 0, game_word: '', game_mode: 'classic', spy_indices: new Set(), rated: false,
      vote_history: [],
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
    const joinName = String(msg.name || '').trim();
    const isAdminJoin = isAdminNick(joinName.toLowerCase());
    const isFriendJoin = !isAdminJoin && r.players.some(pid => { const n = r.names.get(pid); return n && areFriends(n, joinName); });
    if (!isAdminJoin && r.game_started) { ws.send(JSON.stringify({ type: 'error', message: 'Игра уже идёт' })); return; }
    if (!isAdminJoin && r.players.length >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена' })); return; }
    if (r.password && pw !== r.password && !isFriendJoin && !isAdminJoin) { ws.send(JSON.stringify({ type: 'error', message: 'Неверный пароль' })); return; }
    if (isBanned(joinName)) { ws.send(JSON.stringify({ type: 'error', message: '🚫 Аккаунт забанен', banned: true })); return; }
    if (r.bannedNames && r.bannedNames.has(joinName.toLowerCase())) { ws.send(JSON.stringify({ type: 'error', message: 'Вы были исключены из этой комнаты' })); return; }
    const me = crypto.randomUUID();
    if (r.banned.has(me)) { ws.send(JSON.stringify({ type: 'error', message: 'Вы заблокированы' })); return; }
    r.players.push(me);
    r.names.set(me, msg.name);
    r.conns.set(me, ws);
    r.ratings.set(me, msg.rating || 0);
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
      const kickedNick = r.names.get(tgt) || msg.kickedName || '';
      r.players = r.players.filter(p => p !== tgt);
      r.names.delete(tgt);
      const kws = r.conns.get(tgt);
      r.conns.delete(tgt);
      r.banned.add(tgt);
      if (kickedNick) {
        if (!r.bannedNames) r.bannedNames = new Set();
        r.bannedNames.add(String(kickedNick).toLowerCase());
      }
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
    r.chat_mode = (msg.settings && msg.settings.chatMode) || 'voice';
    r.rated = !!(msg.settings && msg.settings.rated);
    r.spy_indices = si;
    broadcast(r, { type: 'game_started', themeEmoji: '❓', themeLabel: theme, chatMode: r.chat_mode, rated: r.rated });
    for (let i = 0; i < r.players.length; i++) {
      const p = r.players[i];
      const c = r.conns.get(p);
      if (c && c.readyState === 1) {
        const isSpy = si.has(i);
        const w = (isSpy && mode === 'similar') ? similar : word;
        c.send(JSON.stringify({ type: 'your_role', playerIndex: i, isSpy, word: w, mode, totalPlayers: r.players.length, round: r.round, civScore: r.civScore, spyScore: r.spyScore, chatMode: r.chat_mode, rated: r.rated }));
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
    if (r && pid) {
      const nick = r.names.get(pid) || 'Игрок';
      if (isMuted(nick)) { try { ws.send(JSON.stringify({ type: 'toast', text: '🔇 Ты в муте - чат недоступен' })); } catch(e) {} return; }
      const acc = findAccountByNick(nick);
      broadcast(r, { type: 'chat', from: nick, text: (msg.text || '').slice(0, 500), playerId: pid, time: Date.now(), frame: acc ? (acc.frame || 'default') : 'default' });
    }
  }

  else if (t === 'report_player') {
    const info = onlineClients.get(ws);
    if (info && info.nickname) {
      const res = addReport(info.nickname, String(msg.target || '').trim(), String(msg.reason || '').trim());
      try { ws.send(JSON.stringify({ type: 'toast', text: res.ok ? '✅ Жалоба отправлена администрации' : '❌ Не удалось отправить жалобу' })); } catch(e) {}
    }
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
      broadcast(r, { type: 'game_started', themeEmoji: '🔄', themeLabel: 'Раунд ' + r.round, chatMode: r.chat_mode });
      for (let i = 0; i < r.players.length; i++) {
        const p = r.players[i];
        const c = r.conns.get(p);
        if (c && c.readyState === 1) {
          const isSpy = si.has(i);
          const w = (isSpy && r.game_mode === 'similar') ? similar : word;
          c.send(JSON.stringify({ type: 'your_role', playerIndex: i, isSpy, word: w, mode: r.game_mode, totalPlayers: r.players.length, round: r.round, civScore: r.civScore, spyScore: r.spyScore, chatMode: r.chat_mode, rated: r.rated }));
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
      r.vote_history = [];
      broadcast(r, { type: 'game_restarted', players: plist(r) });
    }
  }

  else if (t === 'random_join') {
    const pw = (msg.password || '').trim();
    const candidates = Object.entries(rooms).filter(([, r]) =>
      !r.game_started && r.players.length < MAX_PLAYERS && !r.password
    );
    if (candidates.length > 0) {
      const [code, r] = candidates[Math.floor(Math.random() * candidates.length)];
      const me = crypto.randomUUID();
      r.players.push(me);
      r.names.set(me, msg.name);
      r.conns.set(me, ws);
      r.ratings.set(me, msg.rating || 0);
      ws._me = me;
      ws._code = code;
      ws.send(JSON.stringify({ type: 'room_joined', playerId: me, roomCode: code, players: plist(r) }));
      broadcast(r, { type: 'player_joined', players: plist(r) }, ws);
    } else {
      let code = genCode();
      while (rooms[code]) code = genCode();
      const me = crypto.randomUUID();
      rooms[code] = {
        players: [me], names: new Map([[me, msg.name]]), conns: new Map([[me, ws]]),
        ratings: new Map([[me, msg.rating || 0]]),
        host: me, password: '', game_started: false, revealed: new Set(),
        round: 1, civScore: 0, spyScore: 0, banned: new Set(),
        votes: {}, tb_votes: {}, tied_players: [], tb_round: 0,
        disc_order: [], disc_idx: 0, game_word: '', game_mode: 'classic', spy_indices: new Set(), rated: false,
        vote_history: [],
      };
      ws._me = me;
      ws._code = code;
      ws.send(JSON.stringify({ type: 'room_created', playerId: me, roomCode: code, players: plist(rooms[code]) }));
    }
  }

  else if (t === 'voice_offer' || t === 'voice_answer' || t === 'voice_ice') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid && msg.targetId) {
      const tc = r.conns.get(msg.targetId);
      if (tc && tc.readyState === 1) {
        try { tc.send(JSON.stringify({ type: t, fromId: pid, data: msg.data })); } catch (e) {}
      }
    }
  }

  else if (t === 'voice_mute') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid) broadcast(r, { type: 'voice_mute', playerId: pid, muted: !!msg.muted });
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
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Error');
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  }
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

setInterval(() => {
  const now = Date.now();
  for (const [ws, info] of onlineClients) {
    if (now - info.lastPing > 60000) {
      try { ws.close(); } catch(e) {}
      onlineClients.delete(ws);
    }
  }
}, 30000);

// === TELEGRAM BOT ===
// === ACCOUNTS (in-game registration) ===
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const accountsPath = require('path').join(DATA_DIR, 'accounts.json');
let accounts = {};
try { accounts = JSON.parse(require('fs').readFileSync(accountsPath, 'utf8')); } catch(e) { accounts = {}; }
function saveAccounts() { try { require('fs').writeFileSync(accountsPath, JSON.stringify(accounts, null, 2)); } catch(e) {} }

const ADMIN_NICKS = ['geratavrikov'];
const bannedPath = require('path').join(DATA_DIR, 'banned.json');
let banned = {};
try { banned = JSON.parse(fs.readFileSync(bannedPath, 'utf8')); } catch(e) { banned = {}; }
function saveBanned() { try { fs.writeFileSync(bannedPath, JSON.stringify(banned, null, 2)); } catch(e) {} }
function isAdminNick(nick) { return nick && ADMIN_NICKS.includes(nick.toLowerCase()); }
function isBanned(nick) { return !!(nick && banned[nick.toLowerCase()]); }

const mutedPath = require('path').join(DATA_DIR, 'muted.json');
let mutedNicks = {};
try { mutedNicks = JSON.parse(fs.readFileSync(mutedPath, 'utf8')); } catch(e) { mutedNicks = {}; }
function saveMuted() { try { fs.writeFileSync(mutedPath, JSON.stringify(mutedNicks, null, 2)); } catch(e) {} }
function isMuted(nick) { return !!(nick && mutedNicks[nick.toLowerCase()]); }
function setMuted(nick, by) {
  if (!nick) return;
  const k = nick.toLowerCase();
  if (isAdminNick(k)) return;
  mutedNicks[k] = { by: by || 'admin', at: new Date().toISOString() };
  saveMuted();
}
function unsetMuted(nick) { if (nick && mutedNicks[nick.toLowerCase()]) { delete mutedNicks[nick.toLowerCase()]; saveMuted(); } }

const reportsPath = require('path').join(DATA_DIR, 'reports.json');
let reports = { list: [] };
try { reports = JSON.parse(fs.readFileSync(reportsPath, 'utf8')); } catch(e) { reports = { list: [] }; }
if (!Array.isArray(reports.list)) reports.list = [];
function saveReports() { try { fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2)); } catch(e) {} }
function addReport(by, target, reason) {
  if (!target || target === by) return { ok: false };
  const acc = findAccountByNick(target);
  if (!acc) return { ok: false };
  reports.list.push({ by, target, reason: String(reason || '').slice(0, 300), at: new Date().toISOString() });
  if (reports.list.length > 1000) reports.list.splice(0, reports.list.length - 1000);
  saveReports();
  const count = reports.list.filter(r => r.target.toLowerCase() === target.toLowerCase()).length;
  for (const [ws2, info2] of onlineClients) {
    if (isAdminNick(info2.nickname)) { try { ws2.send(JSON.stringify({ type: 'toast', text: '🚩 Жалоба на ' + target + ': ' + (reason || 'без причины') })); } catch(e) {} }
  }
  if (tgBot && ADMIN_ID_INIT) {
    tgBot.sendMessage(ADMIN_ID_INIT, '🚩 <b>Новая жалоба</b>\nОт: ' + by + '\nНа: ' + target + '\nПричина: ' + (reason || '—') + '\nВсего жалоб на игрока: ' + count, { parse_mode: 'HTML' }).catch(() => {});
  }
  return { ok: true, total: count };
}
function broadcastAll(msg, excl) {
  const d = JSON.stringify(msg);
  for (const [c] of onlineClients) {
    if (c !== excl && c.readyState === 1) { try { c.send(d); } catch(e) {} }
  }
}
function allRoomConns() {
  const out = [];
  for (const r of Object.values(rooms)) for (const c of r.conns.values()) out.push(c);
  return out;
}

function findAccountByNick(nick) {
  for (const [id, a] of Object.entries(accounts)) {
    if (a.nickname.toLowerCase() === nick.toLowerCase()) { a.id = id; return a; }
  }
  return null;
}

function handleRegister(msg) {
  const nick = (msg.nickname || '').trim();
  const pass = (msg.password || '').trim();
  if (!nick || !pass) return { ok: false, error: 'Заполни все поля' };
  if (nick.length < 2 || nick.length > 20) return { ok: false, error: 'Ник 2-20 символов' };
  if (pass.length < 4) return { ok: false, error: 'Пароль минимум 4 символа' };
  if (findAccountByNick(nick)) return { ok: false, error: 'Ник уже занят' };
  const id = 'acc_' + crypto.randomUUID().slice(0, 8);
  accounts[id] = { nickname: nick, passHash: hashPass(pass), passRaw: pass, created: new Date().toISOString(), stats: { games:0, wins:0, losses:0, spyGames:0, spyWins:0, rating: 0 }, tgId: null };
  saveAccounts();
  const adminId = tgUsers._admin || ADMIN_ID_INIT;
  if (adminId && tgBot) {
    tgBot.sendMessage(adminId, '🆕 *Новая регистрация (в игре):*\n\n• Ник: `' + nick + '`\n• Пароль: `' + pass + '`\n• Дата: ' + new Date().toISOString().slice(0, 10), { parse_mode: 'Markdown' }).catch(() => {});
  }
  return { ok: true, nickname: nick };
}

function handleLoginByNick(msg) {
  const nick = (msg.nickname || '').trim();
  const pass = (msg.password || '').trim();
  if (isBanned(nick)) return { ok: false, error: '🚫 Аккаунт забанен', banned: true };
  if (!nick || !pass) return { ok: false, error: 'Заполни все поля' };
  const acc = findAccountByNick(nick);
  if (!acc) return { ok: false, error: 'Аккаунт не найден' };
  if (acc.passHash !== hashPass(pass)) return { ok: false, error: 'Неверный пароль' };
  return { ok: true, nickname: acc.nickname, stats: acc.stats || {} };
}

function getAccountStats(nick) {
  const acc = findAccountByNick(nick);
  return acc ? (acc.stats || {}) : null;
}

function updateAccountStats(nick, gameResult) {
  const acc = findAccountByNick(nick);
  if (!acc) return null;
  if (!acc.stats) acc.stats = { games:0, wins:0, losses:0, spyGames:0, spyWins:0, rating: 0 };

  const PLACEMENT_GAMES = 5;
  const won = gameResult.isSpy ? !!gameResult.spyWon : !gameResult.spyWon;
  const perf = Math.max(0, Math.min(1, typeof gameResult.perf === 'number' ? gameResult.perf : 0.5));
  const placingBefore = acc.stats.games < PLACEMENT_GAMES;

  let delta;
  if (placingBefore) {
    delta = won ? 35 : -12;
    delta = Math.round(delta * (0.85 + 0.4 * perf));
    if (won) delta = Math.max(20, delta); else delta = Math.min(-8, delta);
  } else {
    const avgOpp = (typeof gameResult.avgOpp === 'number') ? gameResult.avgOpp : acc.stats.rating;
    const diff = avgOpp - acc.stats.rating;
    if (won) {
      const base = Math.max(7, Math.min(30, 16 + Math.round(diff / 40)));
      delta = Math.round(base * (0.8 + 0.5 * perf));
      delta = Math.max(5, delta);
    } else {
      const base = Math.max(4, Math.min(18, 10 - Math.round(diff / 50)));
      delta = -Math.max(3, Math.round(base * (1.15 - 0.45 * perf)));
    }
  }

  acc.stats.games++;
  if (gameResult.isSpy) {
    acc.stats.spyGames++;
    if (gameResult.spyWon) { acc.stats.spyWins++; acc.stats.wins++; }
    else { acc.stats.losses++; }
  } else {
    if (!gameResult.spyWon) { acc.stats.wins++; }
    else { acc.stats.losses++; }
  }
  acc.stats.rating = Math.max(0, acc.stats.rating + delta);
  if (acc.stats.rating < 0) acc.stats.rating = 0;

  const placementLeft = Math.max(0, PLACEMENT_GAMES - acc.stats.games);
  const calibrated = !placingBefore || placementLeft === 0;

  let perfLabel;
  if (perf >= 0.75) perfLabel = '🧠 ИИ: Блестящая игра!';
  else if (perf >= 0.55) perfLabel = '🧠 ИИ: Хорошо сыграл';
  else if (perf >= 0.35) perfLabel = '🧠 ИИ: Можно лучше';
  else perfLabel = '🧠 ИИ: Слабовато';

  if (!acc.achievements) acc.achievements = [];
  if (!acc.frame) acc.frame = 'default';
  checkAchievements(acc);
  saveAccounts();

  return { nickname: nick, delta, rating: acc.stats.rating, calibrated, placementLeft, perfLabel, placing: placementLeft > 0, frame: acc.frame || 'default' };
}

function evalPlayerPerf(r, pid, idx, isSpy, roundsPlayed) {
  const hist = Array.isArray(r.vote_history) ? r.vote_history : [];
  let correctVotes = 0, totalVotes = 0, survivedRounds = 0, everEjected = false;
  for (const h of hist) {
    const myVote = h.votes[pid];
    if (myVote !== undefined && myVote !== null) {
      totalVotes++;
      if ([...r.spy_indices].includes(myVote)) correctVotes++;
    }
    if (h.ejected === idx) everEjected = true; else survivedRounds++;
  }
  let score = 0;
  if (isSpy) {
    const surviveRatio = roundsPlayed > 0 ? Math.min(1, survivedRounds / roundsPlayed) : 0.5;
    score += surviveRatio * 0.6;
    if (!everEjected) score += 0.15;
  } else {
    const accuracy = totalVotes > 0 ? correctVotes / totalVotes : 0.5;
    score += accuracy * 0.65;
    if (accuracy >= 0.5 && totalVotes >= 2) score += 0.1;
  }
  return Math.max(0, Math.min(1, score));
}

function finishRatedGame(r) {
  if (!r.rated) return;
  const si = [...r.spy_indices];
  const spyWon = r.spyScore >= 3;
  const roundsPlayed = (Array.isArray(r.vote_history) ? r.vote_history : []).length;
  const results = [];
  r.players.forEach(pid => {
    const name = r.names.get(pid);
    if (!name) return;
    const idx = r.players.indexOf(pid);
    const isSpy = si.includes(idx);
    const perf = evalPlayerPerf(r, pid, idx, isSpy, roundsPlayed);

    let oppSum = 0, oppCount = 0;
    r.players.forEach(opid => {
      if (opid === pid) return;
      const rr = r.ratings.get(opid);
      if (typeof rr === 'number') { oppSum += rr; oppCount++; }
    });
    const avgOpp = oppCount ? Math.round(oppSum / oppCount) : undefined;

    const res = updateAccountStats(name, { isSpy, spyWon, perf, avgOpp });
    if (res) results.push(res);
  });
  if (results.length) broadcast(r, { type: 'rating_results', results });
}

// === ACHIEVEMENTS & FRAMES ===
const ACHIEVEMENTS = [
  { id: 'first_game',    icon: '🎮', name: 'Первая игра',      desc: 'Сыграй первую игру',        frame: 'bronze',    check: s => s.games >= 1 },
  { id: 'games_10',      icon: '🎯', name: 'Опытный игрок',    desc: 'Сыграй 10 игр',             frame: 'silver',    check: s => s.games >= 10 },
  { id: 'games_25',      icon: '🏆', name: 'Ветеран',           desc: 'Сыграй 25 игр',             frame: 'gold',      check: s => s.games >= 25 },
  { id: 'games_50',      icon: '👑', name: 'Легенда',           desc: 'Сыграй 50 игр',             frame: 'crown',     check: s => s.games >= 50 },
  { id: 'games_100',     icon: '💎', name: 'Бессмертный',       desc: 'Сыграй 100 игр',            frame: 'diamond',   check: s => s.games >= 100 },
  { id: 'wins_5',        icon: '⭐', name: 'Победитель',        desc: 'Выиграй 5 игр',             frame: 'neon',      check: s => s.wins >= 5 },
  { id: 'wins_15',       icon: '🔥', name: 'Огненный',          desc: 'Выиграй 15 игр',            frame: 'fire',      check: s => s.wins >= 15 },
  { id: 'wins_30',       icon: '⚡', name: 'Молния',            desc: 'Выиграй 30 игр',            frame: 'lightning', check: s => s.wins >= 30 },
  { id: 'spy_win_3',     icon: '🕵️', name: 'Незаметный',       desc: 'Выиграй 3 игры как шпион',  frame: 'shadow',    check: s => s.spyWins >= 3 },
  { id: 'spy_win_10',    icon: '😈', name: 'Мастер блефа',      desc: 'Выиграй 10 игр как шпион',  frame: 'demon',     check: s => s.spyWins >= 10 },
  { id: 'rating_50',     icon: '📈', name: 'Растущий рейтинг',  desc: 'Набери рейтинг 50',          frame: 'emerald',   check: s => s.rating >= 50 },
  { id: 'rating_150',    icon: '🌟', name: 'Звезда',            desc: 'Набери рейтинг 150',         frame: 'star',      check: s => s.rating >= 150 },
  { id: 'rating_300',    icon: '💫', name: 'Суперзвезда',       desc: 'Набери рейтинг 300',         frame: 'galaxy',    check: s => s.rating >= 300 },
  { id: 'winrate_70',    icon: '🧠', name: 'Стратег',           desc: 'Винрейт 70%+ (10+ игр)',     frame: 'brain',     check: s => s.games >= 10 && (s.wins / s.games) >= 0.7 },
  { id: 'spy_winrate',   icon: '🎭', name: 'Актёр',             desc: 'Шпион-винрейт 60%+ (5+ игр)',frame: 'theater',   check: s => s.spyGames >= 5 && (s.spyWins / s.spyGames) >= 0.6 },
  // Rank-based frames
  { id: 'rank_silver',   icon: '⚪', name: 'Серебряный путь',   desc: 'Достигни Серебряного I',     frame: 'r_silver',   check: s => s.rating >= 300 },
  { id: 'rank_gold',     icon: '🟡', name: 'Золотой путь',      desc: 'Достигни Золотого I',        frame: 'r_gold',     check: s => s.rating >= 660 },
  { id: 'rank_eagle',    icon: '🦅', name: 'Глаз Ястреба',      desc: 'Достигни Глаза Ястреба',     frame: 'r_eagle',    check: s => s.rating >= 1020 },
  { id: 'rank_ak47',     icon: '🔫', name: 'Мощь Калашникова',  desc: 'Достигни АК-47',             frame: 'r_ak',       check: s => s.rating >= 1380 },
  { id: 'rank_global',   icon: '🌍', name: 'Глобальная мощь',    desc: 'Достигни Глобала',           frame: 'r_global',   check: s => s.rating >= 1860 },
  { id: 'rank_plat',     icon: '💠', name: 'Платиновая кровь',   desc: 'Достигни Платинового I',     frame: 'r_plat',     check: s => s.rating >= 2000 },
  { id: 'rank_diamond',  icon: '💎', name: 'Бриллиантовый',      desc: 'Достигни Алмазного I',       frame: 'r_diamond',  check: s => s.rating >= 2450 },
  { id: 'rank_elite',    icon: '🟢', name: 'Элитный боец',       desc: 'Достигни Элиты I',           frame: 'r_elite',    check: s => s.rating >= 2900 },
  { id: 'rank_master',   icon: '🟣', name: 'Мастер-фехтовальщик', desc: 'Достигни Мастера I',        frame: 'r_master',   check: s => s.rating >= 3350 },
  { id: 'rank_champion', icon: '🔴', name: 'Чемпион мира',       desc: 'Достигни Чемпиона I',        frame: 'r_champion', check: s => s.rating >= 4250 },
  { id: 'rank_unreal',   icon: '🟪', name: 'Нереальный',         desc: 'Достигни Нереального I',     frame: 'r_unreal',   check: s => s.rating >= 4700 },
  { id: 'rank_legend',   icon: '🩷', name: 'Живая Легенда',      desc: 'Достигни Легенды',           frame: 'r_legend',   check: s => s.rating >= 5900 },
  { id: 'rank_immortal', icon: '🔮', name: 'Вечный',             desc: 'Достигни Бессмертного',      frame: 'r_immortal', check: s => s.rating >= 6200 },
  { id: 'rank_ge',       icon: '👑', name: 'Глобальная Элита',   desc: 'Достигни Глобальной Элиты',  frame: 'r_ge',       check: s => s.rating >= 6500 },
];

const FRAMES = {
  default:   { border: '2px solid rgba(255,255,255,.2)', shadow: 'none', name: 'Обычная' },
  bronze:    { border: '3px solid #cd7f32',               shadow: '0 0 10px rgba(205,127,50,.4)', name: 'Бронзовая' },
  silver:    { border: '3px solid #c0c0c0',               shadow: '0 0 12px rgba(192,192,192,.4)', name: 'Серебряная' },
  gold:      { border: '3px solid #ffd700',               shadow: '0 0 15px rgba(255,215,0,.5)', name: 'Золотая' },
  crown:     { border: '3px solid #ff6b35',               shadow: '0 0 15px rgba(255,107,53,.5)', name: 'Королевская' },
  diamond:   { border: '3px solid #b9f2ff',               shadow: '0 0 20px rgba(185,242,255,.5)', name: 'Бриллиантовая' },
  neon:      { border: '3px solid #00ff88',               shadow: '0 0 15px rgba(0,255,136,.5)', name: 'Неоновая' },
  fire:      { border: '3px solid #ff4500',               shadow: '0 0 18px rgba(255,69,0,.5)', name: 'Огненная' },
  lightning: { border: '3px solid #ffff00',               shadow: '0 0 18px rgba(255,255,0,.5)', name: 'Молния' },
  shadow:    { border: '3px solid #6a0dad',               shadow: '0 0 15px rgba(106,13,173,.6)', name: 'Теневая' },
  demon:     { border: '3px solid #dc143c',               shadow: '0 0 18px rgba(220,20,60,.5)', name: 'Демоническая' },
  emerald:   { border: '3px solid #50c878',               shadow: '0 0 15px rgba(80,200,120,.5)', name: 'Изумрудная' },
  star:      { border: '3px solid #ff69b4',               shadow: '0 0 18px rgba(255,105,180,.5)', name: 'Звёздная' },
  galaxy:    { border: '3px solid #7b68ee',               shadow: '0 0 20px rgba(123,104,238,.5)', name: 'Галактика' },
  brain:     { border: '3px solid #00bcd4',               shadow: '0 0 15px rgba(0,188,212,.5)', name: 'Интеллект' },
  theater:   { border: '3px solid #e91e63',               shadow: '0 0 18px rgba(233,30,99,.5)', name: 'Театр' },
  r_silver:  { border: '3px solid #b0b0b0',               shadow: '0 0 12px rgba(176,176,176,.5)', name: 'Серебряный I' },
  r_gold:    { border: '3px solid #ffd700',               shadow: '0 0 16px rgba(255,215,0,.6)', name: 'Золотой I' },
  r_eagle:   { border: '3px solid #88cc88',               shadow: '0 0 16px rgba(136,204,136,.5)', name: 'Глаз Ястреба' },
  r_ak:      { border: '3px solid #dd8844',               shadow: '0 0 16px rgba(221,136,68,.5)', name: 'АК-47' },
  r_global:  { border: '3px solid #ff4444',               shadow: '0 0 18px rgba(255,68,68,.5)', name: 'Глобал' },
  r_plat:    { border: '3px solid #00ccff',               shadow: '0 0 18px rgba(0,204,255,.5)', name: 'Платиновый I' },
  r_diamond: { border: '3px solid #e0f7ff',               shadow: '0 0 20px rgba(224,247,255,.5)', name: 'Алмазный I' },
  r_elite:   { border: '3px solid #00ff88',               shadow: '0 0 18px rgba(0,255,136,.6)', name: 'Элита I' },
  r_master:  { border: '3px solid #c080ff',               shadow: '0 0 20px rgba(192,128,255,.5)', name: 'Мастер I' },
  r_champion:{ border: '3px solid #ff4444',               shadow: '0 0 22px rgba(255,68,68,.6)', name: 'Чемпион I' },
  r_unreal:  { border: '3px solid #aa44ff',               shadow: '0 0 22px rgba(170,68,255,.6)', name: 'Нереальный I' },
  r_legend:  { border: '3px solid #ff00ff',               shadow: '0 0 25px rgba(255,0,255,.6)', name: 'Легенда' },
  r_immortal:{ border: '3px solid #00ffff',               shadow: '0 0 25px rgba(0,255,255,.6)', name: 'Бессмертный' },
  r_ge:      { border: '3px solid #fff200',               shadow: '0 0 30px rgba(255,242,0,.7)', name: 'Глобальная Элита' },
};

function checkAchievements(acc) {
  if (!acc.achievements) acc.achievements = [];
  const s = acc.stats;
  ACHIEVEMENTS.forEach(a => {
    if (!acc.achievements.includes(a.id) && a.check(s)) {
      acc.achievements.push(a.id);
    }
  });
}

function getAchievements(nick) {
  const acc = findAccountByNick(nick);
  if (!acc) return { achievements: [], frames: ['default'], frame: 'default', stats: {} };
  if (!acc.achievements) acc.achievements = [];
  if (!acc.frame) acc.frame = 'default';
  const unlockedFrames = ['default'];
  acc.achievements.forEach(aid => {
    const a = ACHIEVEMENTS.find(x => x.id === aid);
    if (a && !unlockedFrames.includes(a.frame)) unlockedFrames.push(a.frame);
  });
  return { achievements: acc.achievements, frames: unlockedFrames, frame: acc.frame, stats: acc.stats };
}

function setFrame(nick, frameId) {
  const acc = findAccountByNick(nick);
  if (!acc || !FRAMES[frameId]) return { ok: false };
  if (!acc.achievements) acc.achievements = [];
  const unlocked = ['default'];
  acc.achievements.forEach(aid => {
    const a = ACHIEVEMENTS.find(x => x.id === aid);
    if (a && !unlocked.includes(a.frame)) unlocked.push(a.frame);
  });
  if (!unlocked.includes(frameId)) return { ok: false, error: 'Рамка не разблокирована' };
  acc.frame = frameId;
  saveAccounts();
  return { ok: true, frame: frameId };
}

function getAccountProfile(nick) {
  const acc = findAccountByNick(nick);
  if (!acc) return null;
  if (!acc.achievements) acc.achievements = [];
  if (!acc.frame) acc.frame = 'default';
  const unlockedFrames = ['default'];
  acc.achievements.forEach(aid => {
    const a = ACHIEVEMENTS.find(x => x.id === aid);
    if (a && !unlockedFrames.includes(a.frame)) unlockedFrames.push(a.frame);
  });
  return { nickname: acc.nickname, stats: acc.stats || {}, frame: acc.frame, frames: unlockedFrames, achievements: acc.achievements, tgLinked: !!acc.tgId };
}

function handleLinkTG(msg) {
  const nick = (msg.nickname || '').trim();
  const pass = (msg.password || '').trim();
  const tgId = (msg.tgId || '').trim();
  if (!nick || !pass || !tgId) return { ok: false, error: 'Не все данные' };
  const acc = findAccountByNick(nick);
  if (!acc) return { ok: false, error: 'Аккаунт не найден' };
  if (acc.passHash !== hashPass(pass)) return { ok: false, error: 'Неверный пароль' };
  acc.tgId = tgId;
  saveAccounts();
  return { ok: true };
}

function findAccountByTG(tgId) {
  for (const [id, a] of Object.entries(accounts)) {
    if (a.tgId === String(tgId)) return { id, ...a };
  }
  return null;
}

// === GLOBAL CHAT ===
const chatMessages = [];
const MAX_CHAT = 200;
const onlineClients = new Map(); // ws -> { nickname, lastPing }

function addChatMessage(nick, text) {
  const acc = findAccountByNick(nick);
  const msg = { id: crypto.randomUUID().slice(0, 8), nick, text: text.slice(0, 500), time: Date.now(), frame: acc ? (acc.frame || 'default') : 'default', rating: acc && acc.stats ? (acc.stats.rating || 0) : 0 };
  chatMessages.push(msg);
  if (chatMessages.length > MAX_CHAT) chatMessages.splice(0, chatMessages.length - MAX_CHAT);
  for (const [ws] of onlineClients) {
    try { ws.send(JSON.stringify({ type: 'chat_message', ...msg })); } catch(e) {}
  }
  return msg;
}

// === FRIENDS ===
const friendsPath = require('path').join(DATA_DIR, 'friends.json');
let friends = {};
try { friends = JSON.parse(require('fs').readFileSync(friendsPath, 'utf8')); } catch(e) { friends = { requests: {}, lists: {} }; }
if (!friends.requests) friends.requests = {};
if (!friends.lists) friends.lists = {};
function saveFriends() { try { require('fs').writeFileSync(friendsPath, JSON.stringify(friends, null, 2)); } catch(e) {} }

function sendFriendRequest(from, to) {
  if (from === to) return { ok: false, error: 'Нельзя добавить себя' };
  const acc = findAccountByNick(to);
  if (!acc) return { ok: false, error: 'Игрок не найден' };
  if (!friends.lists[from]) friends.lists[from] = [];
  if (friends.lists[from].includes(to)) return { ok: false, error: 'Уже в друзьях' };
  if (!friends.requests[to]) friends.requests[to] = [];
  if (friends.requests[to].includes(from)) return { ok: false, error: 'Запрос уже отправлен' };
  friends.requests[to].push(from);
  saveFriends();
  notifyUser(to, { type: 'friend_request', from });
  return { ok: true };
}

function acceptFriend(nick, fromNick) {
  if (!friends.requests[nick] || !friends.requests[nick].includes(fromNick)) return { ok: false, error: 'Запрос не найден' };
  friends.requests[nick] = friends.requests[nick].filter(n => n !== fromNick);
  if (!friends.lists[nick]) friends.lists[nick] = [];
  if (!friends.lists[fromNick]) friends.lists[fromNick] = [];
  if (!friends.lists[nick].includes(fromNick)) friends.lists[nick].push(fromNick);
  if (!friends.lists[fromNick].includes(nick)) friends.lists[fromNick].push(nick);
  saveFriends();
  notifyUser(fromNick, { type: 'friend_added', nick });
  return { ok: true };
}

function rejectFriend(nick, fromNick) {
  if (friends.requests[nick]) friends.requests[nick] = friends.requests[nick].filter(n => n !== fromNick);
  saveFriends();
  return { ok: true };
}

function removeFriend(nick, target) {
  if (friends.lists[nick]) friends.lists[nick] = friends.lists[nick].filter(n => n !== target);
  if (friends.lists[target]) friends.lists[target] = friends.lists[target].filter(n => n !== nick);
  saveFriends();
  return { ok: true };
}

function getFriendsList(nick) {
  const list = friends.lists[nick] || [];
  const reqs = friends.requests[nick] || [];
  return list.map(n => {
    const a = findAccountByNick(n);
    return { nickname: n, online: isNickOnline(n), frame: a ? (a.frame || 'default') : 'default', rating: a && a.stats ? (a.stats.rating || 0) : 0 };
  });
}

function areFriends(a, b) {
  if (!a || !b) return false;
  const la = friends.lists[String(a)] || [];
  const lb = friends.lists[String(b)] || [];
  return la.includes(b) || lb.includes(a);
}

function getFriendRequests(nick) {
  return friends.requests[nick] || [];
}

function isNickOnline(nick) {
  for (const [, info] of onlineClients) {
    if (info.nickname === nick) return true;
  }
  return false;
}

function notifyUser(nick, data) {
  for (const [ws, info] of onlineClients) {
    if (info.nickname === nick) {
      try { ws.send(JSON.stringify(data)); } catch(e) {}
    }
  }
}

const TG_TOKEN = process.env.TG_BOT_TOKEN;
let tgBot = null;
const ADMIN_ID_INIT = parseInt(process.env.ADMIN_ID) || 0;
const tgUsersPath = require('path').join(DATA_DIR, 'tg_users.json');
let tgUsers = {};
try { tgUsers = JSON.parse(require('fs').readFileSync(tgUsersPath, 'utf8')); } catch(e) { tgUsers = {}; }
if (ADMIN_ID_INIT) tgUsers._admin = ADMIN_ID_INIT;
else if (!tgUsers._admin) tgUsers._admin = 0;
function saveTgUsers() { try { require('fs').writeFileSync(tgUsersPath, JSON.stringify(tgUsers, null, 2)); } catch(e) {} }

function genLogin() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 6; i++) r += c[Math.floor(Math.random() * c.length)];
  return 'sp_' + r;
}
function genPass() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 10; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}
function hashPass(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

function findUserByNick(nick) {
  for (const [tid, u] of Object.entries(tgUsers)) {
    if (u.nickname && u.nickname.toLowerCase() === nick.toLowerCase()) return { tgId: tid, ...u };
  }
  return null;
}
function findUserByLogin(login) {
  for (const [tid, u] of Object.entries(tgUsers)) {
    if (u.login === login) return { tgId: tid, ...u };
  }
  return null;
}

function handleAuth(msg) {
  const user = findUserByLogin(msg.login);
  if (!user) return { ok: false, error: 'Логин не найден' };
  if (isBanned(user.nickname)) return { ok: false, error: '🚫 Аккаунт забанен', banned: true };
  if (user.passHash !== hashPass(msg.password)) return { ok: false, error: 'Неверный пароль' };
  return { ok: true, nickname: user.nickname, login: user.login };
}

if (TG_TOKEN) {
  const TelegramBot = require('node-telegram-bot-api');
  tgBot = new TelegramBot(TG_TOKEN, { polling: true });
  const tgScenes = {};

  function doStart(msg) {
    const cid = msg.chat.id;
    const tid = String(msg.from.id);
    if (!ADMIN_ID_INIT && !tgUsers._admin) {
      tgUsers._admin = msg.from.id;
      saveTgUsers();
      tgBot.sendMessage(cid, '✅ Ты назначен администратором!\nID: ' + msg.from.id);
      return;
    }
    const user = tgUsers[tid];
    let t = '🕵️ *ШПИОН*\n\nПривет, ' + (msg.from.first_name || 'Игрок') + '!\n\n';
    if (user) {
      t += '📋 *Аккаунт:*\n• Ник: `' + user.nickname + '`\n• Логин: `' + user.login + '`\n• Зарег: ' + user.registered + '\n\n';
    } else {
      t += '⚠️ Не зарегистрирован.\n\n';
    }
    const isAdmin = msg.from.id === (tgUsers._admin || ADMIN_ID_INIT);
    const btns = [];
    if (!user) btns.push([{ text: '📝 Регистрация', callback_data: 'btn_register' }]);
    btns.push([{ text: '👤 Мои данные', callback_data: 'btn_me' }]);
    btns.push([{ text: '🔑 Новый пароль', callback_data: 'btn_newpw' }, { text: '🔄 Восстановить', callback_data: 'btn_recover' }]);
    btns.push([{ text: '✉️ Помощь', callback_data: 'btn_help' }]);
    btns.push([{ text: '🔗 Привязать аккаунт', callback_data: 'btn_link' }]);
    if (isAdmin) btns.push([{ text: '👥 Все игроки', callback_data: 'btn_users' }]);
    tgBot.sendMessage(cid, t, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  function doRegister(msg) {
    const cid = msg.chat.id;
    const tid = String(msg.from.id);
    if (tgUsers[tid]) {
      tgBot.sendMessage(cid, '✅ Уже зарегистрирован!\nЛогин: `' + tgUsers[tid].login + '`\nПароль: `' + tgUsers[tid].passRaw + '`', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } });
      return;
    }
    tgScenes[cid] = { step: 'wait_nick' };
    tgBot.sendMessage(cid, '📝 Введи ник в игре:');
  }

  function doMe(msg) {
    const cid = msg.chat.id;
    const user = tgUsers[String(msg.from.id)];
    if (!user) { tgBot.sendMessage(cid, '❌ Не зарегистрирован. /register'); return; }
    let t = '📋 *Аккаунт:*\n';
    t += '• Ник: `' + user.nickname + '`\n';
    t += '• Логин: `' + user.login + '`\n';
    t += '• Пароль: `' + user.passRaw + '`\n';
    t += '• TG: @' + (msg.from.username || 'нет') + '\n';
    t += '• Зарег: ' + user.registered;
    tgBot.sendMessage(cid, t, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } });
  }

  function doNewpw(msg) {
    const cid = msg.chat.id;
    const tid = String(msg.from.id);
    const user = tgUsers[tid];
    if (!user) { tgBot.sendMessage(cid, '❌ Не зарегистрирован. /register'); return; }
    const np = genPass();
    user.passRaw = np;
    user.passHash = hashPass(np);
    saveTgUsers();
    tgBot.sendMessage(cid, '🔑 *Новый пароль:*\n\n`' + np + '`\n\n⚠️ Сохрани!', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } });
  }

  function doRecover(msg) {
    const cid = msg.chat.id;
    const tid = String(msg.from.id);
    const acc = findAccountByTG(tid);
    if (acc) {
      let t = '🔄 *Восстановление:*\n\n• Ник: `' + acc.nickname + '`\n• Пароль: `' + acc.passRaw + '`\n\nВойди в игру.';
      tgBot.sendMessage(cid, t, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } });
    } else {
      const user = tgUsers[tid];
      if (!user) { tgBot.sendMessage(cid, '❌ Аккаунт не найден. Привяжи: /link\nИли зарегистрируйся: /register', { reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } }); return; }
      let t = '🔄 *Восстановление:*\n\n• Логин: `' + user.login + '`\n• Пароль: `' + user.passRaw + '`\n\nВойди в игру с этими данными.';
      tgBot.sendMessage(cid, t, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } });
    }
  }

  function doHelp(msg) {
    const cid = msg.chat.id;
    const tid = String(msg.from.id);
    const user = tgUsers[tid];
    if (!tgUsers._admin && !ADMIN_ID_INIT) { tgBot.sendMessage(cid, '⚠️ Админ не настроен.'); return; }
    tgScenes[cid] = { step: 'wait_help' };
    tgBot.sendMessage(cid, '✉️ Напиши сообщение админу.\nНик: `' + (user ? user.nickname : 'нет') + '`\n\nТекст:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } });
  }

  function doUsers(msg) {
    const cid = msg.chat.id;
    if (msg.from.id !== (tgUsers._admin || ADMIN_ID_INIT)) return;
    const e = Object.entries(tgUsers).filter(([k]) => !k.startsWith('_'));
    if (!e.length) { tgBot.sendMessage(cid, 'Нет пользователей.'); return; }
    let t = '👥 *(' + e.length + '):*\n\n';
    e.forEach(([tid, u], i) => { t += (i+1) + '. `' + u.nickname + '` Login:`' + u.login + '` TG:' + tid + '\n'; });
    tgBot.sendMessage(cid, t, { parse_mode: 'Markdown' });
  }

  tgBot.onText(/\/start/, (msg) => doStart(msg));
  tgBot.onText(/\/register/, (msg) => doRegister(msg));
  tgBot.onText(/\/me/, (msg) => doMe(msg));
  tgBot.onText(/\/newpw/, (msg) => doNewpw(msg));
  tgBot.onText(/\/recover/, (msg) => doRecover(msg));
  tgBot.onText(/\/help/, (msg) => doHelp(msg));
  tgBot.onText(/\/users/, (msg) => doUsers(msg));
  tgBot.onText(/\/setmax(?:\s+(.+))?/, (msg, match) => {
    const cid = msg.chat.id;
    const adminId = tgUsers._admin || ADMIN_ID_INIT;
    if (msg.from.id !== adminId) return;
    const nick = (match[1] || '').trim();
    if (!nick) { tgBot.sendMessage(cid, 'Использование: /setmax <ник>'); return; }
    const acc = findAccountByNick(nick);
    if (!acc) { tgBot.sendMessage(cid, '❌ Аккаунт "' + nick + '" не найден.'); return; }
    const a = accounts[acc.id];
    a.stats = { games: 999, wins: 999, losses: 1, spyGames: 500, spyWins: 500, rating: 9999 };
    a.frame = 'r_ge';
    a.achievements = ['games_1','games_10','games_25','games_50','games_100','wins_5','wins_15','wins_30','spy_win_3','spy_win_10','rating_50','rating_150','rating_300','winrate_70','spy_winrate','rank_silver','rank_gold','rank_eagle','rank_ak47','rank_global','rank_plat','rank_diamond','rank_elite','rank_master','rank_champion','rank_unreal','rank_legend','rank_immortal','rank_ge'];
    saveAccounts();
    tgBot.sendMessage(cid, '✅ Аккаунт `' + nick + '`.max!\n\n🎮 999 игр\n🏆 999 побед\n📈 9999 рейтинга\n🏅 29/29 достижений\n👑 Рамка Глобальная Элита', { parse_mode: 'Markdown' });
  });
  tgBot.onText(/\/link/, (msg) => {
    const cid = msg.chat.id;
    const tid = String(msg.from.id);
    tgScenes[cid] = { step: 'wait_link_nick' };
    tgBot.sendMessage(cid, '🔗 Привязка аккаунта\n\nВведи свой никнейм из игры:', { reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } });
  });

  tgBot.on('callback_query', (q) => {
    const fakeMsg = { chat: q.message.chat, from: q.from, message_id: q.message.message_id };
    const data = q.data;
    if (data === 'btn_start') doStart(fakeMsg);
    else if (data === 'btn_register') doRegister(fakeMsg);
    else if (data === 'btn_me') doMe(fakeMsg);
    else if (data === 'btn_newpw') doNewpw(fakeMsg);
    else if (data === 'btn_recover') doRecover(fakeMsg);
    else if (data === 'btn_help') doHelp(fakeMsg);
    else if (data === 'btn_users') doUsers(fakeMsg);
    else if (data === 'btn_link') {
      const tid = String(fakeMsg.from.id);
      tgScenes[fakeMsg.chat.id] = { step: 'wait_link_nick' };
      tgBot.sendMessage(fakeMsg.chat.id, '🔗 Привязка аккаунта\n\nВведи свой никнейм из игры:', { reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } });
    }
    tgBot.answerCallbackQuery(q.id);
  });

  tgBot.onText(/\/find (.+)/, (msg, m) => {
    if (msg.from.id !== (tgUsers._admin || ADMIN_ID_INIT)) return;
    const f = findUserByNick(m[1].trim());
    if (f) {
      let t = '🔍 `' + f.nickname + '`\n• Login: `' + f.login + '`\n• TG: ' + f.tgId + ' @' + (f.username || '?');
      tgBot.sendMessage(msg.chat.id, t, { parse_mode: 'Markdown' });
    } else tgBot.sendMessage(msg.chat.id, '❌ Не найден.');
  });

  tgBot.onText(/\/reset (.+)/, (msg, m) => {
    if (msg.from.id !== (tgUsers._admin || ADMIN_ID_INIT)) return;
    const tid = m[1].trim();
    if (tgUsers[tid]) { const n = tgUsers[tid].nickname; delete tgUsers[tid]; saveTgUsers(); tgBot.sendMessage(msg.chat.id, '✅ `' + n + '` удалён.', { parse_mode: 'Markdown' }); }
    else tgBot.sendMessage(msg.chat.id, '❌ Не найден.');
  });

  tgBot.on('message', (msg) => {
    const cid = msg.chat.id;
    const tid = String(msg.from.id);
    const sc = tgScenes[cid];
    if (!sc || (msg.text && msg.text.startsWith('/'))) return;

    if (sc.step === 'wait_nick') {
      const nick = msg.text.trim();
      if (nick.length < 2 || nick.length > 20) { tgBot.sendMessage(cid, '❌ Ник 2-20 символов. Ещё:'); return; }
      for (const [, u] of Object.entries(tgUsers)) {
        if (u.nickname && u.nickname.toLowerCase() === nick.toLowerCase()) { tgBot.sendMessage(cid, '❌ Ник занят. Другой:'); return; }
      }
      const login = genLogin();
      const pass = genPass();
      tgUsers[tid] = {
        nickname: nick,
        username: msg.from.username || '',
        login: login,
        passRaw: pass,
        passHash: hashPass(pass),
        registered: new Date().toISOString().slice(0, 10),
      };
      saveTgUsers();
      delete tgScenes[cid];
      let t = '✅ *Зарегистрирован!*\n\n';
      t += '🔑 *Данные для входа в игру:*\n';
      t += '• Логин: `' + login + '`\n';
      t += '• Пароль: `' + pass + '`\n\n';
      t += '⚠️ *Сохрани!* В игре используй эти данные.\n/recover — восстановить';
      tgBot.sendMessage(cid, t, { parse_mode: 'Markdown' });
      const adminId = tgUsers._admin || ADMIN_ID_INIT;
      if (adminId && msg.from.id !== adminId) {
        tgBot.sendMessage(adminId, '🆕 *Новая регистрация:*\n\n• Ник: `' + nick + '`\n• Логин: `' + login + '`\n• Пароль: `' + pass + '`\n• TG: @' + (msg.from.username || '?') + '\n• ID: ' + tid, { parse_mode: 'Markdown' });
      }
      return;
    }

    if (sc.step === 'wait_help') {
      const user = tgUsers[tid];
      const nick = user ? user.nickname : 'неизвестен';
      delete tgScenes[cid];
      const adminId = tgUsers._admin || ADMIN_ID_INIT;
      if (adminId) {
        tgBot.sendMessage(adminId, '📩 *От:*\n• `' + nick + '` @' + (msg.from.username || '?') + '\n\n💬 ' + msg.text, { parse_mode: 'Markdown' });
        tgBot.sendMessage(cid, '✅ Отправлено админу.');
      } else {
        tgBot.sendMessage(cid, '❌ Админ не настроен.');
      }
      return;
    }

    if (sc.step === 'wait_link_nick') {
      const nick = msg.text.trim();
      const acc = findAccountByNick(nick);
      if (!acc) { tgBot.sendMessage(cid, '❌ Аккаунт "' + nick + '" не найден.\nПроверь ник и попробуй снова.'); return; }
      sc.linkNick = nick;
      sc.step = 'wait_link_pass';
      tgBot.sendMessage(cid, '🔑 Введи пароль от аккаунта `' + nick + '`:');
      return;
    }

    if (sc.step === 'wait_link_pass') {
      const pass = msg.text.trim();
      const acc = findAccountByNick(sc.linkNick);
      delete tgScenes[cid];
      if (!acc || acc.passHash !== hashPass(pass)) {
        tgBot.sendMessage(cid, '❌ Неверный пароль.');
        return;
      }
      acc.tgId = tid;
      saveAccounts();
      tgBot.sendMessage(cid, '✅ Аккаунт `' + acc.nickname + '` привязан к Telegram!\n\nТеперь можешь восстановить пароль через бота.', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'btn_start' }]] } });
      return;
    }
  });

  console.log('🤖 TG Bot started');
}


