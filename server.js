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
  if (r.specs) {
    for (const [c] of r.specs) {
      if (c !== excl && c.readyState === 1) {
        try { c.send(d); } catch (e) {}
      }
    }
  }
}

function resolveVotes(r) {
  r.voting_active = false;
  const v = {};
  for (const [pid, vi] of Object.entries(r.votes)) v[vi] = (v[vi] || 0) + (r.chaos_double ? 2 : 1);
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
    if (r.civScore >= 3) {
      r.final_winner = 'civ';
      broadcast(r, Object.assign({ type: 'game_over', spyGuessed: null }, p));
      onRoomGameOver(r);
    }
    else if (r.spyScore >= 3) {
      r.final_winner = 'spy';
      broadcast(r, Object.assign({ type: 'game_over', spyGuessed: null }, p));
      onRoomGameOver(r);
    }
    else broadcast(r, Object.assign({ type: 'vote_result', round: r.round }, p));
  }
}


function onRoomGameOver(r) {
  try { finishRatedGame(r); } catch (e) {}
  try { if (r.tourn_match) tournReportMatch(r); } catch (e) {}
}

function resolveTB(r, tied) {
  r.voting_active = false;
  const v = {};
  for (const [pid, vi] of Object.entries(r.tb_votes)) {
    if (tied.includes(+vi)) v[vi] = (v[vi] || 0) + (r.chaos_double ? 2 : 1);
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
    const mv = nt.length ? nt[0] : tied[Math.floor(Math.random() * tied.length)];
    if (!Array.isArray(r.vote_history)) r.vote_history = [];
    r.vote_history.push({ votes: Object.assign({}, r.tb_votes), ejected: mv, wasSpy: si.includes(mv) });
    if (si.includes(mv)) r.civScore++; else r.spyScore++;
    r.game_started = false;
    const p = { votes: arr, mostVoted: mv, spyIndices: si, word: w, players, civScore: r.civScore, spyScore: r.spyScore };
    if (r.civScore >= 3) {
      r.final_winner = 'civ';
      broadcast(r, Object.assign({ type: 'game_over', spyGuessed: null }, p));
      onRoomGameOver(r);
    }
    else if (r.spyScore >= 3) {
      r.final_winner = 'spy';
      broadcast(r, Object.assign({ type: 'game_over', spyGuessed: null }, p));
      onRoomGameOver(r);
    }
    else broadcast(r, Object.assign({ type: 'vote_result', round: r.round }, p));
  }
}

const GRACE_MS = 90000;

function removePlayerFinal(r, pid) {
  r.players = r.players.filter(p => p !== pid);
  r.names.delete(pid);
  r.conns.delete(pid);
  if (r.afk) r.afk.delete(pid);
  if (r.grace) { for (const [n, g] of r.grace) if (g.pid === pid) r.grace.delete(n); }
  if (r.players.length > 0) {
    if (r.host === pid) {
      r.host = r.players[0];
      broadcast(r, { type: 'player_left', players: plist(r), newHost: r.host });
    } else {
      broadcast(r, { type: 'player_left', players: plist(r) });
    }
  } else {
    for (const [code, rm] of Object.entries(rooms)) {
      if (rm === r) {
        if (rm.spy_timer) clearTimeout(rm.spy_timer);
        delete rooms[code];
        break;
      }
    }
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
  if (!r || !pid) {
    for (const rm of Object.values(rooms)) {
      if (rm.specs && rm.specs.has(ws)) { rm.specs.delete(ws); broadcast(rm, { type: 'spec_left', specs: [...rm.specs.values()] }); }
    }
    return;
  }
  const wasHost = r.host === pid;
  const inGame = r.game_started || r.spy_pending || r.round_pending;
  r.conns.delete(pid);
  if (inGame) {
    if (!r.afk) r.afk = new Set();
    r.afk.add(pid);
    if (!r.grace) r.grace = new Map();
    r.grace.set(String(r.names.get(pid) || '').toLowerCase(), { pid, until: Date.now() + GRACE_MS });
    broadcast(r, { type: 'player_disconnected', players: plist(r), disconnectedName: r.names.get(pid) || '', reconnectMs: GRACE_MS });
    if (wasHost && r.players.length > 0) {
      const alive = r.players.find(p => !r.afk.has(p)) || r.players[0];
      r.host = alive;
      broadcast(r, { type: 'host_changed', newHost: r.host });
    }
    checkVoteCompletion(r);
    return;
  }
  removePlayerFinal(r, pid);
}

function checkVoteCompletion(r) {
  if (!r.game_started || r.spy_pending) return;
  const pendingVotes = Object.keys(r.votes || {}).length;
  const waiting = r.players.filter(p => !(r.votes && r.votes[p] !== undefined)).length;
  const afkWaiting = r.players.filter(p => r.afk && r.afk.has(p) && r.votes[p] === undefined).length;
  if (waiting - afkWaiting <= 0 && r.players.length > 0 && (pendingVotes + afkWaiting) >= r.players.length && Object.keys(r.votes).length >= Math.max(1, r.players.length - afkWaiting)) resolveVotes(r);
}

const CHAOS_EVENTS = [
  { id: 'mute_random',  emoji: '🤐', name: 'Тишина',     desc: 'Случайный игрок молчит 15 сек' },
  { id: 'fake_word',    emoji: '🎭', name: 'Маскарад',   desc: 'Шпион получит подсказку', apply(r) { if (r.spy_indices) { for (const si of r.spy_indices) { const c = r.conns.get(r.players[si]); if (c && c.readyState === 1) c.send(JSON.stringify({ type: 'chaos_hint', text: '🎭 Шпион может назвать любое слово' })); } } } },
  { id: 'extra_votes',  emoji: '🗳️', name: 'Двойной голос', desc: 'Каждый голос считается x2' },
  { id: 'swap_seats',   emoji: '🪑', name: 'Обмен местами', desc: 'Порядок обсуждения перемешан', apply(r) { r.disc_order = shuffle([...r.disc_order]); r.disc_idx = 0; broadcast(r, { type: 'chaos_swap', order: r.disc_order.map(p => r.names.get(p) || '') }); } },
  { id: 'reveal_random',emoji: '👁️', name: 'Шпионский взгляд', desc: 'Случайный игрок узнаёт роль', apply(r) { const alive = r.players.filter(p => !(r.afk && r.afk.has(p))); if (alive.length > 1) { const victim = pick(alive); const isSpy = r.spy_indices.has(r.players.indexOf(victim)); const c = r.conns.get(victim); if (c && c.readyState === 1) c.send(JSON.stringify({ type: 'chaos_hint', text: isSpy ? '👁️ Ты ШПИОН!' : '👁️ Ты мирный' })); } } },
];

function triggerChaosEvent(r) {
  if (r.chaos_event_active) return;
  const ev = pick(CHAOS_EVENTS);
  r.chaos_event_active = true;
  broadcast(r, { type: 'chaos_event', emoji: ev.emoji, name: ev.name, desc: ev.desc });

  if (ev.id === 'mute_random') {
    const alive = r.players.filter(p => !(r.afk && r.afk.has(p)));
    if (alive.length > 0) {
      const victim = pick(alive);
      if (!r.chaos_muted) r.chaos_muted = new Set();
      r.chaos_muted.add(victim);
      broadcast(r, { type: 'chaos_mute', playerId: victim, name: r.names.get(victim) || '' });
      setTimeout(() => { if (r.chaos_muted) r.chaos_muted.delete(victim); }, 15000);
    }
  }
  else if (ev.id === 'extra_votes') {
    r.chaos_double = true;
    setTimeout(() => { r.chaos_double = false; }, 30000);
  }
  else if (ev.apply) {
    ev.apply(r);
  }

  setTimeout(() => { r.chaos_event_active = false; }, 5000);
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
    for (const c of allRoomConns()) {
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
    tgNotify(target, '📨 ' + info.nickname + ' приглашает тебя в комнату ШПИОН: ' + code + '\nЗаходи: https://shpiongame.ru');
    ws.send(JSON.stringify({ type: 'friend_invite_sent', target }));
    return;
  }

if (t === 'create_room') {
    let code = genCode();
    while (rooms[code]) code = genCode();
    const me = crypto.randomUUID();
    const r = makeRoom(code, me, ws, msg);
    ws.send(JSON.stringify({ type: 'room_created', playerId: me, roomCode: code, players: plist(r) }));
  }

  else if (t === 'quick_play') {
    const joinName = String(msg.name || '').trim();
    if (isBanned(joinName)) { ws.send(JSON.stringify({ type: 'error', message: '🚫 Аккаунт забанен', banned: true })); return; }
    const myRating = parseInt(msg.rating, 10) || 0;
    let candidates = Object.entries(rooms).filter(([, r]) =>
      r.public && !r.password && !r.game_started && r.players.length > 0 && r.players.length < MAX_PLAYERS &&
      !(r.bannedNames && r.bannedNames.has(joinName.toLowerCase())) &&
      [...r.conns.values()].some(c => c.readyState === 1)
    );
    if (candidates.length) {
      candidates.sort((a, b) => {
        const da = Math.min(...a[1].players.map(p => Math.abs((a[1].ratings.get(p) || 0) - myRating)));
        const db = Math.min(...b[1].players.map(p => Math.abs((b[1].ratings.get(p) || 0) - myRating)));
        return da - db || b[1].players.length - a[1].players.length;
      });
      const [code, r] = candidates[0];
      const me = crypto.randomUUID();
      r.players.push(me); r.names.set(me, msg.name); r.conns.set(me, ws); r.ratings.set(me, myRating);
      ws._me = me; ws._code = code;
      ws.send(JSON.stringify({ type: 'quick_found', playerId: me, roomCode: code, players: plist(r) }));
      broadcast(r, { type: 'player_joined', players: plist(r) }, ws);
      return;
    }
    let code = genCode();
    while (rooms[code]) code = genCode();
    const me = crypto.randomUUID();
    msg.public = true; msg.quick = true; msg.password = '';
    const r = makeRoom(code, me, ws, msg);
    ws.send(JSON.stringify({ type: 'quick_found', playerId: me, roomCode: code, players: plist(r), created: true }));
  }

  else if (t === 'join_room') {
    const code = (msg.roomCode || '').toUpperCase();
    const pw = (msg.password || '').trim();
    if (!rooms[code]) { ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' })); return; }
    const r = rooms[code];
    const joinName = String(msg.name || '').trim();
    const isAdminJoin = isAdminNick(joinName.toLowerCase());
    const isFriendJoin = !isAdminJoin && r.players.some(pid => { const n = r.names.get(pid); return n && areFriends(n, joinName); });
    if (isBanned(joinName)) { ws.send(JSON.stringify({ type: 'error', message: '🚫 Аккаунт забанен', banned: true })); return; }
    if (r.bannedNames && r.bannedNames.has(joinName.toLowerCase())) { ws.send(JSON.stringify({ type: 'error', message: 'Вы были исключены из этой комнаты' })); return; }

    // Block duplicate nicknames in room
    if (joinName && r.players.some(pid => { const n = r.names.get(pid); return n && n.toLowerCase() === joinName.toLowerCase() && r.conns.has(pid); })) {
      ws.send(JSON.stringify({ type: 'error', message: 'Игрок с таким ником уже в комнате' }));
      return;
    }

    // Spectator mode
    if (msg.spectate) {
      const canSpec = isAdminJoin || isFriendJoin;
      if (!canSpec) { ws.send(JSON.stringify({ type: 'error', message: 'Наблюдать могут только друзья игроков этой комнаты' })); return; }
      if (!r.specs) r.specs = new Map();
      r.specs.set(ws, joinName);
      ws.send(JSON.stringify({ type: 'spectating', roomCode: code, players: plist(r), specs: [...r.specs.values()], round: r.round, civScore: r.civScore, spyScore: r.spyScore, gameStarted: r.game_started }));
      broadcast(r, { type: 'spec_joined', specs: [...r.specs.values()] }, ws);
      return;
    }

    // Reconnect grace: same nickname returns to their seat
    if (!r.grace) r.grace = new Map();
    const gkey = joinName.toLowerCase();
    // Tournament placeholder seat takeover
    if (r.tourn_placeholders && r.tourn_placeholders.size) {
      let phPid = null;
      for (const pid of r.tourn_placeholders) {
        if (String(r.names.get(pid) || '').toLowerCase() === gkey) { phPid = pid; break; }
      }
      if (phPid) {
        r.tourn_placeholders.delete(phPid);
        r.conns.set(phPid, ws);
        ws._me = phPid;
        ws._code = code;
        const idx2 = r.players.indexOf(phPid);
        ws.send(JSON.stringify({ type: 'room_joined', playerId: phPid, roomCode: code, players: plist(r), tourn: true }));
        broadcast(r, { type: 'player_joined', players: plist(r) }, ws);
        return;
      }
    }
    if (r.grace.has(gkey)) {
      const g = r.grace.get(gkey);
      if (Date.now() < g.until && r.players.includes(g.pid)) {
        const pid = g.pid;
        r.grace.delete(gkey);
        if (r.afk) r.afk.delete(pid);
        r.conns.set(pid, ws);
        ws._me = pid;
        ws._code = code;
        const idx = r.players.indexOf(pid);
        ws.send(JSON.stringify({ type: 'room_reconnected', playerId: pid, roomCode: code, players: plist(r), round: r.round, civScore: r.civScore, spyScore: r.spyScore, gameStarted: r.game_started, isHost: r.host === pid }));
        broadcast(r, { type: 'player_reconnected', players: plist(r), name: joinName }, ws);
        if (r.game_started && !r.spy_pending) {
          const isSpy = r.spy_indices.has(idx);
          ws.send(JSON.stringify({ type: 'your_role', playerIndex: idx, isSpy, word: isSpy && r.game_mode === 'similar' ? r.similar_word : r.game_word, mode: r.game_mode, totalPlayers: r.players.length, round: r.round, civScore: r.civScore, spyScore: r.spyScore, chatMode: r.chat_mode, rated: r.rated, reconnected: true }));
        }
        return;
      }
      r.grace.delete(gkey);
    }

    if (!isAdminJoin && r.game_started) { ws.send(JSON.stringify({ type: 'error', message: 'Игра уже идёт', canSpectate: true, roomCode: code })); return; }
    if (!isAdminJoin && r.players.length >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена', canSpectate: true, roomCode: code })); return; }
    if (r.password && pw !== r.password && !isFriendJoin && !isAdminJoin) { ws.send(JSON.stringify({ type: 'error', message: 'Неверный пароль' })); return; }
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
    if (!r || pid !== r.host || r.game_started) return;
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
    if (msg.settings && Array.isArray(msg.settings.customWords) && msg.settings.customWords.length) {
      r.custom_words = sanitizeCustomWords(msg.settings.customWords);
      r.useCustom = !!(msg.settings.useCustom);
    } else if (msg.settings && msg.settings.useCustom !== undefined) {
      r.useCustom = !!msg.settings.useCustom;
    }
    if (msg.settings && Array.isArray(msg.settings.themes) && msg.settings.themes.length) r.themes = msg.settings.themes;
    if (msg.settings && msg.settings.spyGuess !== undefined) r.spy_guess = !!msg.settings.spyGuess;
    beginRound(r, msg.settings);
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
      if (r.chaos_muted && r.chaos_muted.has(pid)) { try { ws.send(JSON.stringify({ type: 'toast', text: '🤐 Ты замьючен хаос-событием!' })); } catch(e) {} return; }
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
  r.voting_active = true;
    }
  }

  else if (t === 'vote') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid && r.players.includes(pid) && msg.voteIndex !== undefined) {
      if (!r.voting_active) return;
      const vi = parseInt(msg.voteIndex, 10);
      if (isNaN(vi) || vi < 0 || vi >= r.players.length) return;
      r.votes[pid] = vi;
      ws.send(JSON.stringify({ type: 'vote_ack' }));
      checkVoteCompletion(r);
    }
  }

  else if (t === 'tiebreaker_vote') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid && r.players.includes(pid) && r.voting_active && msg.voteIndex !== undefined) {
      const vi = parseInt(msg.voteIndex, 10);
      if (isNaN(vi) || vi < 0 || vi >= r.players.length) return;
      if (!r.tied_players || !r.tied_players.includes(vi)) return;
      r.tb_votes[pid] = vi;
      ws.send(JSON.stringify({ type: 'vote_ack' }));
      const waiting = r.players.filter(p => r.tb_votes[p] === undefined).length;
      const afkWaiting = r.players.filter(p => r.afk && r.afk.has(p) && r.tb_votes[p] === undefined).length;
      if (waiting - afkWaiting <= 0) resolveTB(r, r.tied_players || []);
    }
  }

  
  else if (t === 'emote') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    const ALLOWED = ['😱','🤔','😂','🔥','👍','❤️','😮','😈'];
    if (r && pid && ALLOWED.includes(msg.emoji)) {
      const now = Date.now();
      if (!r.emote_ts) r.emote_ts = {};
      if (now - (r.emote_ts[pid] || 0) < 1200) return;
      r.emote_ts[pid] = now;
      broadcast(r, { type: 'emote', playerId: pid, emoji: msg.emoji });
    }
  }

  else if (t === 'skip_vote') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid && r.voting_active && r.players.includes(pid)) {
      if (!r.skip_votes) r.skip_votes = new Set();
      if (r.skip_votes.has(pid)) return;
      r.skip_votes.add(pid);
      const alive = r.players.filter(p => !(r.afk && r.afk.has(p)));
      const needed = Math.ceil(alive.length / 2);
      broadcast(r, { type: 'skip_update', count: r.skip_votes.size, needed });
      if (r.skip_votes.size >= needed) {
        r.voting_active = false;
        r.game_started = false;
        r.round_pending = true;
        r.round++;
        broadcast(r, { type: 'round_skipped', round: r.round, players: plist(r) });
        setTimeout(() => {
          r.round_pending = false;
          beginRound(r, { mode: r.game_mode, chatMode: r.chat_mode, rated: r.rated, useCustom: r.useCustom });
        }, 2000);
      }
    }
  }

  else if (t === 'set_avatar') {
    const info = onlineClients.get(ws);
    if (!info) return;
    const acc = findAccountByNick(info.nickname);
    if (!acc) return;
    const av = [...String(msg.avatar || '🕵️')].slice(0, 2).join('');
    acc.avatar = av;
    saveAccounts();
    ws.send(JSON.stringify({ type: 'avatar_set', avatar: av }));
  }

  else if (t === 'get_seasons') {
    const acc = findAccountByNick((msg.nickname || '').trim());
    if (!acc) return ws.send(JSON.stringify({ type: 'seasons_data', history: [] }));
    if (checkSeasonReset(acc)) saveAccounts();
    ws.send(JSON.stringify({ type: 'seasons_data', history: acc.seasonHistory || [], currentSeason: seasonKey(), resetDay: SEASON_RESET_DAY }));
  }

  // === CHAOS MINI-GAME ===
  else if (t === 'chaos_event') {
    const r = findRoom(ws);
    if (r && r.game_mode === 'chaos' && r.game_started && !r.chaos_event_active) {
      triggerChaosEvent(r);
    }
  }

  else if (t === 'next_round') {
    const r = findRoom(ws);
    const { pid } = findPlayer(ws);
    if (r && pid === r.host) {
      r.round++;
      beginRound(r, { mode: r.game_mode, chatMode: r.chat_mode, rated: r.rated, useCustom: r.useCustom });
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
      r.afk = new Set();
      r.skip_votes = new Set();
      r.chaos_double = false;
      r.chaos_muted = null;
      r.chaos_event_active = false;
      if (r.grace) r.grace.clear();
      if (r.spy_timer) { clearTimeout(r.spy_timer); r.spy_timer = null; }
      r.spy_pending = false;
      r.final_winner = null;
      r.vote_history = [];
      broadcast(r, { type: 'game_restarted', players: plist(r) });
    }
  }

  else if (t === 'random_join') {
    const rjName = String(msg.name || '').trim();
    if (isBanned(rjName)) { ws.send(JSON.stringify({ type: 'error', message: '🚫 Аккаунт забанен', banned: true })); return; }
    const candidates = Object.entries(rooms).filter(([, r]) =>
      !r.game_started && r.players.length < MAX_PLAYERS && !r.password &&
      [...r.conns.values()].some(c => c.readyState === 1) &&
      !(r.bannedNames && r.bannedNames.has(rjName.toLowerCase())) &&
      !r.players.some(p => (r.names.get(p) || '').toLowerCase() === rjName.toLowerCase())
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
      msg.public = true; msg.password = '';
      const r = makeRoom(code, me, ws, msg);
      ws.send(JSON.stringify({ type: 'room_created', playerId: me, roomCode: code, players: plist(r) }));
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
      removePlayerFinal(r, pid);
    } else {
      for (const rm of Object.values(rooms)) {
        if (rm.specs && rm.specs.has(ws)) {
          rm.specs.delete(ws);
          broadcast(rm, { type: 'spec_left', specs: [...rm.specs.values()] });
          break;
        }
      }
    }
  }

  // === WEEKLY TOP ===
  else if (t === 'get_weekly_top') {
    const wk = isoWeekKey();
    const rows = Object.values(accounts)
      .filter(a => a.weekly && a.weekly.week === wk && a.weekly.rating > 0)
      .sort((x, y) => y.weekly.rating - x.weekly.rating)
      .slice(0, 10)
      .map(a => ({ nickname: a.nickname, frame: a.frame || 'default', rating: a.stats ? a.stats.rating : 0, weekly: a.weekly.rating, wins: a.weekly.wins || 0 }));
    ws.send(JSON.stringify({ type: 'weekly_top', top: rows, week: wk, resetsIn: msUntilWeekEnd() }));
  }

  // === DAILY QUESTS ===
  else if (t === 'get_daily_quests') {
    const nick = (msg.nickname || '').trim();
    const acc = findAccountByNick(nick);
    const empty = { date: todayKey(), quests: [] };
    if (!acc) { ws.send(JSON.stringify({ type: 'daily_quests', ...empty, defs: pubQuestDefs() })); return; }
    ensureDaily(acc); saveAccounts();
    ws.send(JSON.stringify({ type: 'daily_quests', date: acc.daily.date, quests: acc.daily.quests, defs: pubQuestDefs() }));
  }

  else if (t === 'claim_daily_quest') {
    const nick = (msg.nickname || '').trim();
    const idx = parseInt(msg.index, 10);
    const acc = findAccountByNick(nick);
    if (!acc) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Аккаунт не найден' })); return; }
    const daily = ensureDaily(acc);
    const q = daily.quests[idx];
    const def = q ? QUEST_DEFS.find(x => x.id === q.id) : null;
    if (!q || !def) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Задание не найдено' })); return; }
    if (q.claimed) { ws.send(JSON.stringify({ type: 'toast', text: 'Уже получено' })); return; }
    if (q.progress < def.goal) { ws.send(JSON.stringify({ type: 'toast', text: 'Задание ещё не выполнено' })); return; }
    q.claimed = true;
    const bonus = 5;
    acc.stats.rating += bonus;
    if (!acc.coins) acc.coins = 0;
    acc.coins += 8;
    const wk = isoWeekKey();
    if (!acc.weekly || acc.weekly.week !== wk) acc.weekly = { week: wk, rating: 0, wins: 0, games: 0 };
    acc.weekly.rating += bonus;
    saveAccounts();
    ws.send(JSON.stringify({ type: 'quest_claimed', index: idx, bonus, rating: acc.stats.rating, coins: acc.coins }));
    ws.send(JSON.stringify({ type: 'toast', text: '🎁 +' + bonus + ' рейтинга и +8 🪙 за задание!' }));
  }

  // === MATCH HISTORY ===
  else if (t === 'get_history') {
    const acc = findAccountByNick((msg.nickname || '').trim());
    ws.send(JSON.stringify({ type: 'history_data', history: acc && Array.isArray(acc.history) ? acc.history : [] }));
  }

  // === REFERRALS ===
  else if (t === 'get_my_ref') {
    const acc = findAccountByNick((msg.nickname || '').trim());
    if (!acc) { ws.send(JSON.stringify({ type: 'my_ref', code: '', invited: 0 })); return; }
    if (!acc.ref_code) { acc.ref_code = crypto.randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase(); saveAccounts(); }
    const invited = Object.values(accounts).filter(a => a.ref_by === acc.ref_code).length;
    ws.send(JSON.stringify({ type: 'my_ref', code: acc.ref_code, invited }));
  }

  else if (t === 'apply_ref_code') {
    const nick = (msg.nickname || '').trim();
    const rc = String(msg.code || '').trim().toUpperCase();
    const me = findAccountByNick(nick);
    if (!me) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Сначала зарегистрируйся' })); return; }
    if (me.ref_by) { ws.send(JSON.stringify({ type: 'toast', text: 'Код уже применён' })); return; }
    const inviter = Object.values(accounts).find(a => a.ref_code === rc);
    if (!inviter || inviter.nickname.toLowerCase() === nick.toLowerCase()) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Код не найден' })); return; }
    me.ref_by = rc;
    grantAchievement(me, 'invite_friend');
    const acc2 = findAccountByNick(inviter.nickname);
    if (acc2) grantAchievement(acc2, 'invite_friend');
    saveAccounts();
    ws.send(JSON.stringify({ type: 'toast', text: '🤝 Код применён! Рамка «Дружба» разблокирована' }));
    notifyUser(inviter.nickname, { type: 'toast', text: '🤝 ' + nick + ' применил твой код! Рамка «Дружба» твоя' });
    tgNotify(inviter.nickname, '🤝 По твоему реферальному коду зарегистрировался ' + nick + '! Рамка «Дружба» разблокирована.');
  }

  // === FRAME SHOP ===
  else if (t === 'get_shop') {
    const acc = findAccountByNick((msg.nickname || '').trim());
    const owned = acc ? ownedFramesOf(acc) : [];
    const items = SHOP_FRAMES.map(s => {
      const f = FRAMES[s.id] || {};
      return { id: s.id, price: s.price, name: f.name || s.id, border: f.border, shadow: f.shadow, owned: owned.includes(s.id) };
    });
    ws.send(JSON.stringify({ type: 'shop_data', balance: acc ? (acc.coins || 0) : 0, items }));
  }

  else if (t === 'buy_frame') {
    const acc = findAccountByNick((msg.nickname || '').trim());
    const item = SHOP_FRAMES.find(x => x.id === msg.frameId);
    if (!acc) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Сначала зарегистрируйся' })); return; }
    if (!item) { ws.send(JSON.stringify({ type: 'toast', text: '❌ Товар не найден' })); return; }
    if (!Array.isArray(acc.owned_frames)) acc.owned_frames = [];
    if (acc.owned_frames.includes(item.id)) { ws.send(JSON.stringify({ type: 'toast', text: 'Уже куплено' })); return; }
    if ((acc.coins || 0) < item.price) { ws.send(JSON.stringify({ type: 'toast', text: '🪙 Не хватает монет (' + (acc.coins || 0) + '/' + item.price + ')' })); return; }
    acc.coins -= item.price;
    acc.owned_frames.push(item.id);
    saveAccounts();
    ws.send(JSON.stringify({ type: 'shop_bought', frameId: item.id, balance: acc.coins }));
    ws.send(JSON.stringify({ type: 'toast', text: '🛒 Рамка «' + (FRAMES[item.id].name) + '» куплена!' }));
  }

  // === TOURNAMENT ===
  else if (t === 'tourn_join') {
    const info = onlineClients.get(ws);
    const nick = (info && info.nickname) || String(msg.nickname || '').trim();
    if (!nick) return;
    tournJoin(nick, ws);
  }

  else if (t === 'tourn_create' || t === 'tourn_start' || t === 'tourn_cancel') {
    if (!isAdminWs(ws)) return;
    if (t === 'tourn_create') tournCreate(ws);
    if (t === 'tourn_start') tournStartRound(ws);
    if (t === 'tourn_cancel') tournCancel(ws);
  }
}

function sanitizeCustomWords(raw) {
if (!Array.isArray(raw)) return [];
return raw.map(w => String(w || '').trim()).filter(w => w.length >= 2 && w.length <= 60).slice(0, 120);
}

function makeRoom(code, me, ws, msg) {
const r = {
players: [me], names: new Map([[me, msg.name]]), conns: new Map([[me, ws]]),
ratings: new Map([[me, msg.rating || 0]]),
host: me, password: (msg.password || '').trim(), game_started: false, revealed: new Set(),
round: 1, civScore: 0, spyScore: 0, banned: new Set(), bannedNames: new Set(),
votes: {}, tb_votes: {}, tied_players: [], tb_round: 0,
disc_order: [], disc_idx: 0, game_word: '', game_mode: 'classic', spy_indices: new Set(), rated: false,
vote_history: [],
public: !!msg.public, quick: !!msg.quick,
custom_words: sanitizeCustomWords(msg.customWords),
spy_guess: msg.spyGuess !== false,
final_winner: null, spy_pending: false,
specs: new Map(), afk: new Set(), grace: new Map(), emote_ts: {},
};
r.code = code;
rooms[code] = r;
ws._me = me;
ws._code = code;
return r;
}

function pickWordAndOptions(r, settings) {
let pool;
const themes = (settings && settings.themes) || r.themes || ['movies'];
    if (r.custom_words && r.custom_words.length && ((settings && settings.useCustom) || r.useCustom)) {
  pool = r.custom_words;
} else {
  const theme = pick(themes);
  pool = WORDS[theme] || WORDS.movies;
}
const word = pick(pool);
const similar = pool.length > 1 ? pick(pool.filter(w => w !== word)) : word;
let options = [word];
const others = shuffle(pool.filter(w => w.toLowerCase() !== String(word).toLowerCase()));
for (let i = 0; i < Math.min(5, others.length); i++) options.push(others[i]);
return { word, similar, options: shuffle(options) };
}

function beginRound(r, settings) {
// Remove disconnected (ghost) players before starting
r.players = r.players.filter(pid => r.conns.has(pid));
r.spy_indices = new Set([...r.spy_indices].filter(i => i < r.players.length));
r.game_started = true;
r.revealed = new Set();
r.votes = {};
r.tb_votes = {};
r.tied_players = [];
r.disc_order = [];
r.disc_idx = 0;
r.banned = new Set();
r.afk = new Set();
r.skip_votes = new Set();
r.chaos_double = false;
r.chaos_muted = null;
r.chaos_event_active = false;
if (r.grace) r.grace.clear();
if (r.spy_timer) { clearTimeout(r.spy_timer); r.spy_timer = null; }
r.spy_pending = false;
r.final_winner = null;
r.emote_ts = {};
const picked = pickWordAndOptions(r, settings || {});
const mode = (settings && settings.mode) || 'classic';
const sc = r.players.length <= 5 ? 1 : 2;
const si = new Set(shuffle(r.players.map((_, i) => i)).slice(0, sc));
r.game_word = picked.word;
r.similar_word = picked.similar;
r.guess_options = picked.options;
r.game_mode = mode;
r.chat_mode = (settings && settings.chatMode) || 'voice';
  r.rated = !!(settings && settings.rated) && mode !== 'chaos';
r.spy_indices = si;
broadcast(r, { type: 'game_started', themeEmoji: r.round > 1 ? '🔄' : '❓', themeLabel: r.round > 1 ? ('Раунд ' + r.round) : 'ШПИОН', chatMode: r.chat_mode, rated: r.rated, mode: r.game_mode || 'classic' });
for (let i = 0; i < r.players.length; i++) {
  const p = r.players[i];
  const c = r.conns.get(p);
  if (c && c.readyState === 1) {
    const isSpy = si.has(i);
    const w = (isSpy && mode === 'similar') ? picked.similar : picked.word;
    c.send(JSON.stringify({ type: 'your_role', playerIndex: i, isSpy, word: w, mode, totalPlayers: r.players.length, round: r.round, civScore: r.civScore, spyScore: r.spyScore, chatMode: r.chat_mode, rated: r.rated }));
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

const wss = new WebSocketServer({ server, maxPayload: 8192 });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try { handleMessage(ws, JSON.parse(data.toString())); } catch (e) { console.error('handleMessage error:', e && e.stack || e); }
  });
  ws.on('close', () => { try { handleDisconnect(ws); } catch(e) { console.error('handleDisconnect error:', e && e.stack || e); } });
  ws.on('error', () => { try { handleDisconnect(ws); } catch(e) {} });
});

server.listen(PORT, () => {
  console.log('=== Shpion Server (Node.js) ===');
  console.log('Port: ' + PORT);
});

setInterval(() => {
  const now = Date.now();
  for (const [ws, info] of onlineClients) {
    if (now - info.lastPing > 60000) {
      // Broadcast offline before removing
      const offName = info.nickname;
      if (offName) {
        for (const [c] of onlineClients) {
          if (c !== ws) { try { c.send(JSON.stringify({ type: 'user_offline', nickname: offName })); } catch(e) {} }
        }
      }
      try { ws.close(); } catch(e) {}
      onlineClients.delete(ws);
    }
  }
  // Expired reconnect-grace seats leave the room
  for (const [code, r] of Object.entries(rooms)) {
    if (!r.grace) continue;
    let changed = false;
    for (const [nick, g] of [...r.grace]) {
      if (now > g.until && r.players.includes(g.pid)) { removePlayerFinal(r, g.pid); changed = true; }
      else if (now > g.until) r.grace.delete(nick);
    }
    if (changed && r.players.length === 0) { /* removed by removePlayerFinal */ }
  }
}, 30000);

// === NEW FEATURE SUPPORT ===
function msUntilWeekEnd() {
  const now = new Date();
  const end = new Date(now);
  const day = now.getUTCDay() || 7;
  end.setUTCDate(now.getUTCDate() + (8 - day));
  end.setUTCHours(0, 0, 0, 0);
  return Math.max(0, end - now);
}

function pubQuestDefs() {
  return QUEST_DEFS.map(d => ({ id: d.id, icon: d.icon, name: d.name, desc: d.desc, goal: d.goal }));
}

function grantAchievement(acc, achId) {
  if (!acc) return;
  if (!acc.achievements) acc.achievements = [];
  if (!acc.achievements.includes(achId)) acc.achievements.push(achId);
}

function isAdminWs(ws) {
  const info = onlineClients.get(ws);
  return !!(info && info.nickname && isAdminNick(String(info.nickname).toLowerCase()));
}

function tgNotify(nick, text) {
  try {
    const acc = findAccountByNick(nick);
    if (acc && acc.tgId && typeof tgBot !== 'undefined' && tgBot) tgBot.sendMessage(String(acc.tgId), text).catch(() => {});
  } catch (e) {}
}

// === TOURNAMENT STATE MACHINE ===
let tourn = null;

function tournStateMsg() {
  if (!tourn) return { active: false };
  return {
    active: true,
    phase: tourn.phase,
    participants: tourn.participants.length,
    names: tourn.participants.slice(0, 50),
    round: tourn.round,
    advancing: tourn.advancing ? tourn.advancing.length : 0,
  };
}

function broadcastTournState() {
  broadcastAll({ type: 'tourn_state', ...tournStateMsg() });
}

function tournCreate(ws) {
  if (tourn && tourn.phase === 'running') { ws.send(JSON.stringify({ type: 'toast', text: 'Турнир уже идёт' })); return; }
  tourn = { phase: 'signup', participants: [], round: 0, matches: [], advancing: [] };
  broadcastTournState();
  ws.send(JSON.stringify({ type: 'toast', text: '🏆 Турнир создан! Игроки могут записываться' }));
  for (const a of Object.values(accounts)) tgNotify(a.nickname, '🏆 Объявлен турнир ШПИОН! Запись открыта — зайди в игру и нажми «Участвовать».');
}

function tournJoin(nick, ws) {
  if (!tourn || tourn.phase !== 'signup') { ws.send(JSON.stringify({ type: 'toast', text: 'Запись на турнир не открыта' })); return; }
  if (tourn.participants.includes(nick)) { ws.send(JSON.stringify({ type: 'toast', text: 'Ты уже в списке' })); return; }
  tourn.participants.push(nick);
  broadcastTournState();
  ws.send(JSON.stringify({ type: 'toast', text: '✅ Ты записан на турнир!' }));
}

function makeMatchRooms(namesArr, roundNo) {
  const shuffled = shuffle([...namesArr]);
  const groups = [];
  const rest = [...shuffled];
  while (rest.length > 0) {
    if (rest.length <= 8) { groups.push(rest.splice(0, rest.length)); }
    else { groups.push(rest.splice(0, 5)); }
  }
  const matches = [];
  for (const group of groups) {
    if (group.length < 3) { matches.push({ bye: group }); continue; }
    let code = genCode();
    while (rooms[code]) code = genCode();
    const me = crypto.randomUUID();
    const r = makeRoom(code, me, { send: () => {}, readyState: 1 }, { name: group[0], password: '', public: false });
    r.tourn_match = { round: roundNo };
    r.tourn_placeholders = new Set([me]);
    for (let i = 1; i < group.length; i++) {
      const pid = crypto.randomUUID();
      r.players.push(pid);
      r.names.set(pid, group[i]);
      r.ratings.set(pid, 0);
      r.tourn_placeholders.add(pid);
    }
    matches.push({ code, players: [...group], done: false });
  }
  return matches;
}

function tournStartRound(adminWs) {
  if (!tourn) { adminWs.send(JSON.stringify({ type: 'toast', text: 'Сначала создай турнир' })); return; }
  if (tourn.phase === 'running') { adminWs.send(JSON.stringify({ type: 'toast', text: 'Раунд уже идёт' })); return; }
  let pool = tourn.phase === 'signup' ? tourn.participants : tourn.advancing;
  pool = pool.filter(n => isNickOnline(n));
  if (pool.length < 3) { adminWs.send(JSON.stringify({ type: 'toast', text: 'Нужно минимум 3 онлайн-участника' })); return; }
  if (pool.length <= 4) {
    startFinalMatch(pool, adminWs);
    return;
  }
  tourn.round++;
  tourn.matches = makeMatchRooms(pool, tourn.round);
  tourn.nextAdvancing = [];
  tourn.phase = 'running';
  for (const m of tourn.matches) {
    if (m.bye) { m.done = true; tourn.nextAdvancing.push(...m.bye); continue; }
    for (const n of m.players) {
      const c = onlineNickSocket(n);
      if (c) {
        try { c.send(JSON.stringify({ type: 'tourn_assign', roomCode: m.code })); } catch (e) {}
        tgNotify(n, '🏆 Турнир, раунд ' + tourn.round + ': твоя комната ' + m.code + '. Удачи!');
      }
    }
  }
  broadcastTournState();
  adminWs.send(JSON.stringify({ type: 'toast', text: '🏆 Раунд ' + tourn.round + ': комнат создано: ' + tourn.matches.filter(m => !m.bye).length }));
}

function startFinalMatch(pool, adminWs) {
  let code = genCode();
  while (rooms[code]) code = genCode();
  const me = crypto.randomUUID();
  const r = makeRoom(code, me, { send: () => {}, readyState: 1 }, { name: pool[0], password: '' });
  r.tourn_final = true;
  r.tourn_match = { round: 99 };
  r.tourn_placeholders = new Set([me]);
  for (let i = 1; i < pool.length; i++) {
    const pid = crypto.randomUUID();
    r.players.push(pid);
    r.names.set(pid, pool[i]);
    r.ratings.set(pid, 0);
    r.tourn_placeholders.add(pid);
  }
  tourn.round++;
  tourn.matches = [{ code, players: [...pool], done: false }];
  tourn.nextAdvancing = [];
  tourn.phase = 'running';
  tourn.isFinal = true;
  for (const n of pool) {
    const c = onlineNickSocket(n);
    if (c) { try { c.send(JSON.stringify({ type: 'tourn_assign', roomCode: code, final: true })); } catch (e) {} }
  }
  broadcastTournState();
  adminWs.send(JSON.stringify({ type: 'toast', text: '🏆 ФИНАЛ! Комната ' + code }));
}

function tournReportMatch(r) {
  if (!tourn || tourn.phase !== 'running' || !r.tourn_match) return;
  const m = tourn.matches.find(x => !x.done && x.code === r.code);
  if (!m || m.done) return;
  m.done = true;
  const winnerSpy = r.final_winner === 'spy';
  const si = new Set([...(r.spy_indices || [])]);
  const winners = [];
  r.players.forEach((pid, i) => {
    const isOnWinningSide = winnerSpy ? si.has(i) : !si.has(i);
    if (isOnWinningSide) {
      const n = r.names.get(pid);
      if (n) winners.push(n);
    }
  });
  tourn.nextAdvancing = (tourn.nextAdvancing || []).concat(winners);
  broadcast(r, { type: 'toast', text: '🏆 Победившая сторона прошла дальше!' });
  checkTournRoundEnd(r);
}

function checkTournRoundEnd(lastRoom) {
  if (!tourn || tourn.phase !== 'running') return;
  const pending = tourn.matches.filter(m => !m.done && !m.bye).length;
  if (pending > 0) return;
  const adv = [...new Set(tourn.nextAdvancing)].filter(isNickOnline);
  if (adv.length === 0) { tournCancel(lastRoom); return; }
  if (adv.length <= 4 || tourn.isFinal) {
    const champions = adv;
    for (const n of champions) {
      const acc = findAccountByNick(n);
      if (acc) { grantAchievement(acc, 'champion'); saveAccounts(); }
      tgNotify(n, '👑 ТЫ ЧЕМПИОН ТУРНИРА ШПИОН! Рамка «Чемпион» разблокирована!');
      const c = onlineNickSocket(n);
      if (c) { try { c.send(JSON.stringify({ type: 'toast', text: '👑 Ты чемпион турнира! Рамка «Чемпион» разблокирована' })); } catch (e) {} }
    }
    broadcastAll({ type: 'toast', text: '🏆 Турнир завершён! Чемпионы: ' + champions.join(', ') });
    tourn = null;
    broadcastTournState();
  } else {
    tourn.advancing = adv;
    tourn.phase = 'between';
    broadcastAll({ type: 'toast', text: '🏆 Раунд ' + tourn.round + ' завершён. Осталось: ' + adv.length + '. Админ запускает следующий раунд' });
    broadcastTournState();
  }
}

function tournCancel(ws) {
  if (!tourn) { if (ws && ws.send) ws.send(JSON.stringify({ type: 'toast', text: 'Активного турнира нет' })); return; }
  tourn = null;
  broadcastTournState();
  broadcastAll({ type: 'toast', text: 'Турнир отменён админом' });
  if (ws && ws.send) ws.send(JSON.stringify({ type: 'toast', text: 'Турнир отменён' }));
}

function onlineNickSocket(nick) {
  if (!nick) return null;
  const target = String(nick).toLowerCase();
  for (const [c, info] of onlineClients) {
    if (info.nickname && info.nickname.toLowerCase() === target && c.readyState === 1) return c;
  }
  return null;
}

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
  if (!nick || typeof nick !== 'string') return null;
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
  if (/[<>"'&]/.test(nick)) return { ok: false, error: 'Ник содержит запрещённые символы' };
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
  const seasonReset = checkSeasonReset(acc);
  if (seasonReset) saveAccounts();
  return { ok: true, nickname: acc.nickname, stats: acc.stats || {}, seasonReset, seasonHistory: acc.seasonHistory || [], coins: acc.coins || 0, avatar: acc.avatar || '🕵️' };
}

function getAccountStats(nick) {
  const acc = findAccountByNick(nick);
  return acc ? (acc.stats || {}) : null;
}

function isoWeekKey(d) {
  const dt = d || new Date();
  const t = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return t.getUTCFullYear() + '-W' + week;
}

function todayKey(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

function seasonKey(d) {
  const dt = d || new Date();
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  return dt.getFullYear() + '-' + month;
}

const SEASON_RESET_DAY = 15;

function checkSeasonReset(acc) {
  const now = new Date();
  const curSeason = seasonKey(now);
  if (acc.lastSeason === curSeason) return false;
  if (!acc.lastSeason) { acc.lastSeason = curSeason; return false; }
  if (now.getDate() < SEASON_RESET_DAY) return false;
  const prevRating = (acc.stats && acc.stats.rating) || 0;
  if (!Array.isArray(acc.seasonHistory)) acc.seasonHistory = [];
  acc.seasonHistory.unshift({ season: acc.lastSeason, rating: prevRating });
  if (acc.seasonHistory.length > 6) acc.seasonHistory.length = 6;
  const topReward = prevRating >= 2000 ? 's_gold_season' : prevRating >= 1500 ? 's_silver_season' : prevRating >= 1000 ? 's_bronze_season' : null;
  if (topReward) {
    if (!Array.isArray(acc.owned_frames)) acc.owned_frames = [];
    if (!acc.owned_frames.includes(topReward)) acc.owned_frames.push(topReward);
  }
  acc.stats.rating = 100;
  acc.lastSeason = curSeason;
  return true;
}

const QUEST_DEFS = [
  { id: 'play_2',    icon: '🎮', name: 'Разминка',        desc: 'Сыграй 2 игры',                 goal: 2 },
  { id: 'play_3',    icon: '🎯', name: 'Втянулся',        desc: 'Сыграй 3 игры',                 goal: 3 },
  { id: 'win_1',     icon: '⭐', name: 'Победа дня',      desc: 'Победи 1 игру',                 goal: 1 },
  { id: 'win_2',     icon: '🏆', name: 'На волне',        desc: 'Победи 2 игры',                 goal: 2 },
  { id: 'spy_win',   icon: '🕵️', name: 'Тайный агент',   desc: 'Победи как шпион',              goal: 1 },
  { id: 'civ_win',   icon: '👥', name: 'Глазастый',       desc: 'Победи мирным',                 goal: 1 },
];

function ensureDaily(acc) {
  const tk = todayKey();
  if (!acc.daily || acc.daily.date !== tk) {
    const seed = (tk + (acc.nickname || '')).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const idxs = [];
    let s = seed || 7;
    const pool = QUEST_DEFS.map((_, i) => i);
    while (idxs.length < 3 && pool.length) {
      s = (s * 1103515245 + 12345) >>> 0;
      const i = pool.splice(s % pool.length, 1)[0];
      idxs.push(i);
    }
    acc.daily = {
      date: tk,
      quests: idxs.map(i => ({ id: QUEST_DEFS[i].id, progress: 0, claimed: false })),
    };
  }
  return acc.daily;
}

function questProgress(acc, qid, inc) {
  const daily = ensureDaily(acc);
  const q = daily.quests.find(x => x.id === qid);
  if (!q || q.claimed) return;
  q.progress += inc;
  const def = QUEST_DEFS.find(x => x.id === qid);
  if (def && q.progress >= def.goal) q.progress = def.goal;
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

  if (!acc.coins) acc.coins = 0;

  // Win streak
  if (!acc.stats.winStreak) acc.stats.winStreak = 0;
  if (!acc.stats.maxWinStreak) acc.stats.maxWinStreak = 0;
  if (won) {
    acc.stats.winStreak++;
    if (acc.stats.winStreak > acc.stats.maxWinStreak) acc.stats.maxWinStreak = acc.stats.winStreak;
    if (acc.stats.winStreak === 3) { acc.coins += 15; }
    if (acc.stats.winStreak === 5) { acc.coins += 30; }
  } else {
    acc.stats.winStreak = 0;
  }

  const coinsDelta = won ? 12 : 5;
  acc.coins += coinsDelta;

  // Weekly rating tracking
  const wk = isoWeekKey();
  if (!acc.weekly || acc.weekly.week !== wk) acc.weekly = { week: wk, rating: 0, wins: 0, games: 0 };
  acc.weekly.rating += delta;
  acc.weekly.games++;
  if (won) acc.weekly.wins++;

  // Daily quests
  ensureDaily(acc);
  questProgress(acc, 'play_2', 1);
  questProgress(acc, 'play_3', 1);
  if (won) questProgress(acc, gameResult.isSpy ? 'spy_win' : 'civ_win', 1);
  if (won) { questProgress(acc, 'win_1', 1); questProgress(acc, 'win_2', 1); }

  // Match history
  if (!Array.isArray(acc.history)) acc.history = [];
  const opponents = Array.isArray(gameResult.opponents) ? gameResult.opponents : [];
  acc.history.unshift({
    at: new Date().toISOString(),
    word: String(gameResult.word || '').slice(0, 40),
    role: gameResult.isSpy ? 'spy' : 'civ',
    won,
    delta,
    rating: acc.stats.rating,
    players: parseInt(gameResult.playersCount, 10) || 0,
    opponents,
  });
  if (acc.history.length > 20) acc.history.length = 20;

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

  return { nickname: nick, delta, rating: acc.stats.rating, calibrated, placementLeft, perfLabel, placing: placementLeft > 0, frame: acc.frame || 'default', weeklyRating: acc.weekly ? acc.weekly.rating : 0, won, coins: acc.coins, coinsDelta, winStreak: acc.stats.winStreak || 0 };
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
  const spyWon = r.final_winner ? (r.final_winner === 'spy') : (r.spyScore >= 3);
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

    const opponents = r.players.filter(op => op !== pid).map(op => r.names.get(op) || '').filter(Boolean);
    const res = updateAccountStats(name, { isSpy, spyWon, perf, avgOpp, word: r.game_word, playersCount: r.players.length, opponents });
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
  { id: 'invite_friend', icon: '🤝', name: 'Дружелюбный',      desc: 'Пригласи друга по коду',     frame: 'friendship', check: () => false },
  { id: 'champion',      icon: '👑', name: 'Чемпион турнира',   desc: 'Победи в турнире',           frame: 'champion_t', check: () => false },
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
  r_ge:      { border: '3px solid #fff200', shadow: '0 0 30px rgba(255,242,0,.7)', name: 'Глобальная Элита' },
  friendship:{ border: '3px solid #00d4aa', shadow: '0 0 16px rgba(0,212,170,.5)', name: 'Дружба' },
  champion_t:{ border: '4px double #ffd700', shadow: '0 0 24px rgba(255,215,0,.8)', name: 'Чемпион' },
  s_aurora:  { border: '3px solid #7df9ff', shadow: '0 0 18px rgba(125,249,255,.55)', name: 'Полярная' },
  s_rose:    { border: '3px solid #ff7eb3', shadow: '0 0 16px rgba(255,126,179,.5)', name: 'Розовый туман' },
  s_ice:     { border: '3px solid #a8d8ff', shadow: '0 0 20px rgba(168,216,255,.6)', name: 'Ледяная' },
  s_royal:   { border: '4px double #ffd54f', shadow: '0 0 22px rgba(255,213,79,.75)', name: 'Королевское золото' },
  s_void:    { border: '3px solid #9d4edd', shadow: '0 0 26px rgba(157,78,221,.8)', name: 'Пустота' },
  s_bronze_season: { border: '3px solid #cd7f32', shadow: '0 0 14px rgba(205,127,50,.5)', name: 'Бронзовый сезон' },
  s_silver_season: { border: '3px solid #c0c0c0', shadow: '0 0 14px rgba(192,192,192,.5)', name: 'Серебряный сезон' },
  s_gold_season:   { border: '3px solid #ffd700', shadow: '0 0 18px rgba(255,215,0,.6)', name: 'Золотой сезон' },
};

const SHOP_FRAMES = [
  { id: 's_aurora', price: 150 },
  { id: 's_rose',   price: 200 },
  { id: 's_ice',    price: 250 },
  { id: 's_royal',  price: 400 },
  { id: 's_void',   price: 550 },
];

function checkAchievements(acc) {
  if (!acc.achievements) acc.achievements = [];
  const s = acc.stats;
  ACHIEVEMENTS.forEach(a => {
    if (!acc.achievements.includes(a.id) && a.check(s)) {
      acc.achievements.push(a.id);
    }
  });
}

function ownedFramesOf(acc) {
  return Array.isArray(acc.owned_frames) ? acc.owned_frames.slice() : [];
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
  ownedFramesOf(acc).forEach(f => { if (!unlockedFrames.includes(f)) unlockedFrames.push(f); });
  const coins = acc.coins || 0;
  return { achievements: acc.achievements, frames: unlockedFrames, frame: acc.frame, stats: acc.stats, coins };
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
  ownedFramesOf(acc).forEach(f => { if (!unlocked.includes(f)) unlocked.push(f); });
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
  ownedFramesOf(acc).forEach(f => { if (!unlockedFrames.includes(f)) unlockedFrames.push(f); });
  return { nickname: acc.nickname, stats: acc.stats || {}, frame: acc.frame, frames: unlockedFrames, achievements: acc.achievements, tgLinked: !!acc.tgId, coins: acc.coins || 0 };
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
    if (!sc || !msg.text || msg.text.startsWith('/')) return;

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


