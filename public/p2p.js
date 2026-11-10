/* Pusoy Dos — player-hosted tables. No game server.
 *
 * The host's browser runs the table (the same referee code as solo play) and
 * the other players connect straight to it over WebRTC. Public relays are only
 * used to introduce browsers to each other; the cards never pass through them.
 *
 *   room "lobby"        everyone on the home screen, plus every host of a public table.
 *                       Hosts announce their table here; that is the live-tables list.
 *   room "table-CODE"   the players at one table.
 *
 * If the host leaves or drops, the next player in seat order takes over hosting
 * (the host keeps that one player supplied with a copy of the table for exactly
 * this purpose), and a bot sits in the old host's seat.
 *
 * Worth knowing: whoever hosts holds the whole deck in their browser, so this is
 * for playing with people you trust. A referee server (server.js) fixes that.
 *
 * What is defended, given that anyone can join a room and send anything:
 *   - Only the host a player sat down with, and then only the successor that host
 *     named, is ever accepted as host. A stranger cannot announce "I host this now".
 *   - Everything a host sends is rebuilt field by field before the page sees it
 *     (cleanView / cleanEvents / cleanSnapshot), and so is everything a host receives.
 *   - A player's saved key never leaves their browser. Hosts get a one-table token
 *     derived from it, and the copy of the table kept by the successor holds only
 *     a hash of that token, so neither can be replayed to take someone's seat.
 *   - Message floods are dropped per sender; the lobby lists one row per code.
 */
(function (root) {
  'use strict';
  var P = (root.Pusoy = root.Pusoy || {});

  var APP_ID = 'pusoy-dos-arcade-1';
  var NAMES = ['Neon Room', 'Lucky Sevens', 'High Rollers', 'Bonus Stage', 'Wild Cards', 'Double Down', 'Card Sharks', 'Night Shift', 'Final Round', 'Coin Slot', 'Top Deck', 'Player Two'];
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  var FATAL = { gone: 1, full: 1, idle: 1, replaced: 1, moved: 1 };

  var timing = {
    heartbeat: 2000,     // host -> players: "still here"
    hostLost: 7000,      // no heartbeat for this long: the host is gone
    recover: 12000,      // how long to wait for the new host to appear
    connect: 25000,      // how long to wait to reach a table at all
    announce: 8000,      // hosts repeat their table to the lobby this often
    tableTtl: 20000,     // the lobby forgets tables it hasn't heard from
    searching: 6000,     // how long the home screen says "looking for tables"
    linger: 400,         // keep a room open this long after the last user, in case it is reopened
    pinWait: 6000        // coming from the lobby: how long to hold out for the host that listed the table
  };
  var LIMITS = { tables: 60, perSec: 30, lobbyGap: 400 };

  function now() { return Date.now(); }
  function randomCode() {
    var s = '';
    for (var i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }
  /* ---------- small, strict helpers for data that came off the network ---------- */

  function isInt(v, lo, hi) { return typeof v === 'number' && v === Math.floor(v) && v >= lo && v <= hi; }
  function int(v, lo, hi, d) { return isInt(v, lo, hi) ? v : d; }
  function num(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0; }
  function cardList(a, max) {
    var out = [];
    if (!Array.isArray(a)) return out;
    for (var i = 0; i < a.length && i < 60 && out.length < max; i++) if (isInt(a[i], 0, 51) && out.indexOf(a[i]) < 0) out.push(a[i]);
    return out;
  }
  function four(a, fn) { var out = []; for (var i = 0; i < 4; i++) out.push(fn(Array.isArray(a) ? a[i] : undefined, i)); return out; }
  /* A play on the table, re-derived from its cards so its name and strength can be trusted. */
  function playOf(t) {
    if (!t || typeof t !== 'object') return null;
    var h = P.Engine.evaluate(cardList(t.cards, 5));
    return h ? { cards: h.cards, by: int(t.by, 0, 3, 0), type: h.type, size: h.size, power: h.power, name: h.name, label: h.label } : null;
  }
  var PHASES = { waiting: 1, playing: 1, roundEnd: 1, matchEnd: 1 };
  function levelOf(v) { return v === 'easy' || v === 'hard' ? v : 'normal'; }
  function resultOf(r) {
    if (!r || typeof r !== 'object') return null;
    return {
      winner: int(r.winner, 0, 3, 0), champ: int(r.champ, -1, 3, -1),
      left: four(r.left, function (v) { return int(v, 0, 13, 0); }),
      delta: four(r.delta, function (v) { return int(v, -999, 999, 0); }),
      hands: four(r.hands, function (v) { return cardList(v, 13); })
    };
  }

  /* What a guest shows on screen: a host's "state" message, rebuilt from scratch. */
  function cleanView(s, code) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.seats) || s.seats.length !== 4 || !PHASES[s.phase] || !isInt(s.you, 0, 3)) return null;
    var ended = s.phase === 'roundEnd' || s.phase === 'matchEnd', result = ended ? resultOf(s.result) : null;
    if (ended && !result) return null;
    return {
      code: code, name: P.cleanText(s.name, 28) || 'Table', pub: !!s.pub,
      rounds: int(s.rounds, 1, 20, 5), turnSecs: int(s.turnSecs, 0, 120, 30), passLock: s.passLock !== false, manualNext: false,
      bots: levelOf(s.bots), phase: s.phase, round: int(s.round, 0, 99, 0), you: s.you, seq: int(s.seq, 0, 1e9, 0),
      seats: s.seats.map(function (x) {
        x = x && typeof x === 'object' ? x : {};
        return { name: P.cleanText(x.name, 16) || 'Player', av: int(x.av, 0, 5, 0), bot: !!x.bot, on: !!x.on, n: int(x.n, 0, 13, 0),
          passed: !!x.passed, score: int(x.score, -9999, 9999, 0), wins: int(x.wins, 0, 99, 0) };
      }),
      hand: cardList(s.hand, 13).sort(function (a, b) { return a - b; }),
      turn: int(s.turn, -1, 3, -1), table: playOf(s.table),
      trick: (Array.isArray(s.trick) ? s.trick.slice(-2) : []).map(playOf).filter(Boolean).map(function (t) { return { cards: t.cards, by: t.by }; }),
      mustOpen: !!s.mustOpen, aids: false, seen: [],
      turnAt: num(s.turnAt), nextAt: num(s.nextAt), now: num(s.now) || now(),
      result: result
    };
  }

  /* The little notices that ride along with a state ("Ana played a pair"). */
  function cleanEvents(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < 40; i++) {
      var e = list[i], k = e && e.k;
      if (!e || typeof e !== 'object') continue;
      if (k === 'deal') { out.push({ k: k, round: int(e.round, 0, 99, 0), first: int(e.first, -1, 3, -1) }); continue; }
      if (k === 'roundEnd') { out.push({ k: k, winner: int(e.winner, 0, 3, 0) }); continue; }
      if (k === 'matchEnd') { out.push({ k: k, champ: int(e.champ, 0, 3, 0) }); continue; }
      if (!isInt(e.seat, 0, 3)) continue;
      if (k === 'pass' || k === 'clear' || k === 'away' || k === 'back' || k === 'timeout') out.push({ k: k, seat: e.seat });
      else if (k === 'join' || k === 'leave') out.push({ k: k, seat: e.seat, name: P.cleanText(e.name, 16) || 'Player' });
      else if (k === 'chat') { var text = P.cleanText(typeof e.text === 'string' ? e.text.slice(0, 200) : '', 80); if (text) out.push({ k: k, seat: e.seat, text: text }); }
      else if (k === 'play') {
        var h = P.Engine.evaluate(cardList(e.cards, 5));
        if (h) out.push({ k: k, seat: e.seat, cards: h.cards, name: h.name, type: h.type, left: int(e.left, 0, 13, 0) });
      }
    }
    return out;
  }

  /* The copy of a table that the successor holds. It is rebuilt too: a new host
   * runs the game from it, so nothing in it is taken on trust. Returns null if the
   * cards do not add up. */
  function cleanSnapshot(s, code) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.seats) || s.seats.length !== 4 || !PHASES[s.phase]) return null;
    var o = s.opts && typeof s.opts === 'object' ? s.opts : {};
    var hands = four(s.hands, function (v) { return cardList(v, 13).sort(function (a, b) { return a - b; }); });
    var seenCards = cardList(s.seen, 52), all = hands[0].concat(hands[1], hands[2], hands[3], seenCards), uniq = {}, i;
    for (i = 0; i < all.length; i++) { if (uniq[all[i]]) return null; uniq[all[i]] = 1; }
    var playing = s.phase === 'playing', turn = int(s.turn, -1, 3, -1);
    if (playing && (all.length !== 52 || turn < 0 || !hands[turn].length)) return null;
    var ended = s.phase === 'roundEnd' || s.phase === 'matchEnd', result = ended ? resultOf(s.result) : null;
    if (ended && !result) return null;
    var names = P.BOT_NAMES || ['Bot'];
    return {
      v: 1, code: code, name: P.cleanText(s.name, 28) || 'Table', pub: !!s.pub,
      opts: { rounds: int(o.rounds, 1, 20, 5), turnSecs: int(o.turnSecs, 5, 120, 30), passLock: o.passLock !== false, manualNext: false, aids: false,
        bots: levelOf(o.bots), think: P.Net ? P.Net.THINK_MS : 30,
        botMs: Array.isArray(o.botMs) && isInt(o.botMs[0], 1, 5000) && isInt(o.botMs[1], 1, 5000) ? [o.botMs[0], o.botMs[1]] : [800, 1500] },
      seats: s.seats.map(function (x, k) {
        x = x && typeof x === 'object' ? x : {};
        var bot = !!x.bot || !/^k[0-9a-f]{40}$/.test(x.pid || '');
        var botName = names.indexOf(x.botName) >= 0 ? x.botName : names[k % names.length];
        return { pid: bot ? null : x.pid, name: bot ? botName : (P.cleanText(x.name, 16) || 'Player'), botName: botName, av: int(x.av, 0, 5, 0),
          bot: bot, on: false, awayAt: 0, afk: 0, chatAt: 0 };
      }),
      phase: s.phase, round: int(s.round, 0, 99, 0),
      scores: four(s.scores, function (v) { return int(v, -9999, 9999, 0); }),
      wins: four(s.wins, function (v) { return int(v, 0, 99, 0); }),
      lastWinner: int(s.lastWinner, -1, 3, -1),
      hands: hands, passed: four(s.passed, function (v) { return !!v; }),
      turn: playing ? turn : -1, table: playing ? playOf(s.table) : null,
      trick: (Array.isArray(s.trick) ? s.trick.slice(-3) : []).map(playOf).filter(Boolean).map(function (t) { return { cards: t.cards, by: t.by }; }),
      seen: seenCards, mustOpen: !!s.mustOpen && playing, result: result,
      turnAt: 0, actAt: 0, nextAt: 0, closeAt: 0, outbox: [], seq: int(s.seq, 0, 1e9, 0) + 1, created: now()
    };
  }

  /* What a host accepts from a player's "act" message. The table checks the move itself. */
  function cleanAct(m) {
    if (!m || typeof m !== 'object') return null;
    if (m.t === 'start' || m.t === 'next' || m.t === 'pass') return { t: m.t };
    if (m.t === 'play') return Array.isArray(m.cards) && m.cards.length >= 1 && m.cards.length <= 5 ? { t: 'play', cards: m.cards.slice(0, 5) } : null;
    if (m.t === 'chat') return typeof m.text === 'string' ? { t: 'chat', text: m.text.slice(0, 200) } : null;
    return null;
  }

  /* Drops whatever one sender sends beyond `max` messages a second. */
  function limiter(max) {
    var seen = {};
    return function (peer) {
      var t = now(), r = seen[peer];
      if (!r || t - r.at >= 1000) { seen[peer] = { at: t, n: 1 }; return true; }
      return ++r.n <= max;
    };
  }

  /* ---------- who a player is ---------- */

  /* SHA-256, small and synchronous (the browser's own one is async and missing on plain http). */
  var SHA_K = null, SHA_H = null;
  function sha256(text) {
    var i, n, c;
    if (!SHA_K) {
      SHA_K = []; SHA_H = [];
      var frac = function (x) { return ((x - Math.floor(x)) * 4294967296) | 0; };
      for (n = 2, c = 0; c < 64; n++) {
        var prime = true;
        for (i = 2; i * i <= n; i++) if (n % i === 0) { prime = false; break; }
        if (prime) { if (c < 8) SHA_H[c] = frac(Math.pow(n, 1 / 2)); SHA_K[c++] = frac(Math.pow(n, 1 / 3)); }
      }
    }
    var bytes = [], str = unescape(encodeURIComponent(String(text)));
    for (i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 255);
    var bits = bytes.length * 8;
    bytes.push(128);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bits / 4294967296), lo = bits >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var rr = function (v, a) { return (v >>> a) | (v << (32 - a)); };
    var h = SHA_H.slice(), w = [];
    for (var off = 0; off < bytes.length; off += 64) {
      for (i = 0; i < 16; i++) w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], cc = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (hh + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
        var t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & cc) ^ (b & cc))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + cc) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var hex = '';
    for (i = 0; i < 8; i++) hex += ('00000000' + (h[i] >>> 0).toString(16)).slice(-8);
    return hex;
  }

  /* A player's saved key stays in their browser. What a host is shown is a token
   * good for one table code only, and what the table keeps (and passes to the
   * successor) is a hash of that token. */
  function tokenOf(profile, code) { return sha256('pusoy-seat|' + identOf(profile) + '|' + code); }
  function pidOf(token) { return 'k' + sha256('pusoy-pid|' + token).slice(0, 40); }
  function isToken(v) { return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v); }
  /* Who a player is at a table: their saved key plus this tab's id, so two tabs are two players. */
  function identOf(profile) { return String(profile.key || '') + (profile.tab ? '.' + profile.tab : ''); }

  /* What a host tells the lobby, cleaned up before anyone trusts it. */
  function cleanSummary(s) {
    if (!s || typeof s !== 'object' || !/^[A-Z]{4}$/.test(s.code) || !Array.isArray(s.seats) || s.seats.length !== 4) return null;
    var phases = { waiting: 1, playing: 1, roundEnd: 1, matchEnd: 1 };
    return {
      code: s.code, name: P.cleanText(s.name, 28) || 'Table', pub: true,
      phase: phases[s.phase] ? s.phase : 'waiting',
      round: Math.max(0, Math.min(99, s.round | 0)), rounds: Math.max(1, Math.min(99, s.rounds | 0)),
      bots: s.bots === 'easy' || s.bots === 'hard' ? s.bots : 'normal',
      seats: s.seats.map(function (x) { return x && typeof x === 'object' ? { name: P.cleanText(x.name, 16) || 'Player', av: Math.max(0, Math.min(5, x.av | 0)) } : null; })
    };
  }

  /* ---------- the real transport: Trystero over public Nostr relays ---------- */

  function trysteroTransport(roomId) {
    var T = root.Trystero;
    var cfg = { appId: APP_ID, relayConfig: { warnOnRelayFailure: false } };
    if (root.PUSOY_RELAYS && root.PUSOY_RELAYS.length) cfg.relayConfig.urls = root.PUSOY_RELAYS;   // your own relay list, if you have one
    if (root.PUSOY_TURN && root.PUSOY_TURN.length) cfg.turnConfig = root.PUSOY_TURN;               // a TURN server helps strict networks
    var room = T.joinRoom(cfg, roomId, { onJoinError: function () { /* that one peer couldn't connect; others still can */ } });
    var act = room.makeAction('m');
    return {
      selfId: T.selfId,
      send: function (m, to) {
        try { var p = act.send(m, to ? { target: to } : undefined); if (p && p.catch) p.catch(function () { /* peer went away mid-send */ }); }
        catch (e) { /* not connected yet */ }
      },
      setHandlers: function (h) {
        act.onMessage = function (data, meta) { h.msg(data, meta && meta.peerId); };
        room.onPeerJoin = function (id) { h.join(id); };
        room.onPeerLeave = function (id) { h.leave(id); };
      },
      peers: function () { try { return Object.keys(room.getPeers()); } catch (e) { return []; } },
      leave: function () { try { room.leave(); } catch (e) { /* already left */ } }
    };
  }

  /* ---------- one player's view of the network ---------- */

  function create(transport) {
    var rooms = {};          // roomId -> { raw, users: [handle], timer }
    var pendingHost = {};    // code -> options for a table this player is about to host
    var pins = {};           // code -> the peer that listed that table in the lobby

    /* Rooms are shared and reference-counted, so leaving and immediately
     * rejoining the same room (home screen <-> hosting) never cuts it off. */
    function open(roomId) {
      var r = rooms[roomId];
      if (r) clearTimeout(r.timer);
      else {
        r = rooms[roomId] = { raw: transport(roomId), users: [], timer: 0 };
        var each = function (type) {
          return function (a, b) { r.users.slice().forEach(function (u) { if (u.on[type]) u.on[type](a, b); }); };
        };
        r.raw.setHandlers({ msg: each('msg'), join: each('join'), leave: each('leave') });
      }
      var handle = {
        selfId: r.raw.selfId, on: {},
        send: function (m, to) { r.raw.send(m, to); },
        peers: function () { return r.raw.peers(); },
        close: function () {
          var i = r.users.indexOf(handle);
          if (i < 0) return;
          r.users.splice(i, 1); handle.on = {};
          if (!r.users.length) r.timer = setTimeout(function () { if (!r.users.length && rooms[roomId] === r) { delete rooms[roomId]; r.raw.leave(); } }, timing.linger);
        }
      };
      r.users.push(handle);
      return handle;
    }

    /* ---------- home screen: the list of live tables ---------- */
    function lobby(h) {
      var ch = open('lobby'), tables = {}, started = now(), dead = false;
      function emit() {
        if (dead) return;
        var cutoff = now() - timing.tableTtl, list = [], seated = 0, k;
        for (k in tables) { if (tables[k].at < cutoff) delete tables[k]; else list.push(tables[k].s); }
        var open_ = function (t) { return t.seats.filter(function (x) { return !x; }).length; };
        list.sort(function (a, b) { return (open_(b) > 0) - (open_(a) > 0) || open_(a) - open_(b) || (a.code < b.code ? -1 : 1); });
        list.forEach(function (t) { seated += 4 - open_(t) - 1; });      // the host is already counted as a lobby peer
        h.onLobby({ tables: list, online: ch.peers().length + 1 + Math.max(0, seated), searching: !list.length && now() - started < timing.searching });
      }
      var heard = {}, queued = 0;
      function soon() { if (!queued) queued = setTimeout(function () { queued = 0; emit(); }, 120); }     // many rows at once: one redraw
      ch.on.msg = function (m, peer) {
        if (dead || !m || typeof m !== 'object' || !peer) return;
        if (m.t === 'tbl') {
          var t = now(), s, k;
          if (t - (heard[peer] || 0) < LIMITS.lobbyGap) return;          // a host repeats itself every few seconds, not faster
          heard[peer] = t;
          s = cleanSummary(m.s);
          if (!s) return;
          // One row per code: whoever listed it first keeps it for as long as they are around.
          for (k in tables) if (k !== peer && tables[k].s.code === s.code) { if (t - tables[k].at < timing.tableTtl) return; delete tables[k]; }
          if (!tables[peer] && Object.keys(tables).length >= LIMITS.tables) return;
          tables[peer] = { s: s, at: t }; pins[s.code] = peer; soon();
        } else if (m.t === 'gone' && tables[peer]) { if (pins[tables[peer].s.code] === peer) delete pins[tables[peer].s.code]; delete tables[peer]; soon(); }
      };
      ch.on.join = function (peer) { ch.send({ t: 'who' }, peer); soon(); };
      ch.on.leave = function (peer) { delete tables[peer]; delete heard[peer]; soon(); };
      var tick = setInterval(emit, 2000);
      setTimeout(function () { if (!dead) { h.onStatus('online'); emit(); } }, 0);

      function make(o) {
        o = o || {};
        var used = {}, k, code;
        for (k in tables) used[tables[k].s.code] = 1;
        do { code = randomCode(); } while (used[code]);
        var free = NAMES.filter(function (n) { for (var j in tables) if (tables[j].s.name === n) return false; return true; });
        pendingHost[code] = {
          name: P.cleanText(o.name, 28) || (free.length ? free : NAMES)[Math.floor(Math.random() * (free.length || NAMES.length))],
          pub: o.pub !== false, rounds: o.rounds, turnSecs: o.turnSecs || 30, passLock: o.passLock !== false, botMs: o.botMs, bots: o.bots
        };
        h.onGo(code);
      }
      return {
        send: function (m) {
          if (dead || !m) return false;
          if (m.t === 'create') make(m.o);
          else if (m.t === 'board') h.onBoard([]);
          else if (m.t === 'quick') {
            var best = null, k;
            for (k in tables) {
              var t = tables[k].s, n = t.seats.filter(Boolean).length;
              if (n < 4 && (!best || n > best.n)) best = { code: t.code, n: n };
            }
            if (best) h.onGo(best.code); else make({ pub: true });
          }
          return true;
        },
        close: function () { dead = true; clearInterval(tick); clearTimeout(queued); ch.close(); }
      };
    }

    /* ---------- hosting a table ---------- */
    /* `takeover` is set when a player inherits a table: { ch, s, epoch, oldHostPid } */
    function host(code, opts, profile, h, takeover) {
      var Core = P.TableCore, myPid = pidOf(tokenOf(profile, code));
      var ch = takeover ? takeover.ch : open('table-' + code);
      var core, epoch, peers = {}, seen = {}, backup = null, snapKey = '', timer = 0, dead = false, lastSum = '', lob = null;
      var appointed = {};                     // every peer this host ever named as its successor
      var allow = limiter(LIMITS.perSec), allowWho = limiter(2);

      if (takeover) {
        core = new Core(takeover.s);
        epoch = takeover.epoch + 1;
        var t0 = now();
        if (takeover.oldHostPid && core.seatOf(takeover.oldHostPid) >= 0) core.leave(takeover.oldHostPid, t0);   // a bot takes the old host's seat
        core.s.seats.forEach(function (seat) {             // everyone else has to check in with the new host
          if (!seat.bot && seat.pid !== myPid) { seat.on = false; seat.awayAt = t0; }
          if (seat.pid === myPid) { seat.on = true; seat.awayAt = 0; seat.afk = 0; }
        });
        core.s.closeAt = 0;
        core.drain();
        core.resume(t0);
      } else {
        core = Core.create({ code: code, name: opts.name, pub: opts.pub, rounds: opts.rounds, turnSecs: opts.turnSecs, passLock: opts.passLock, botMs: opts.botMs, aids: false,
          bots: opts.bots, think: P.Net ? P.Net.THINK_MS : 30 }, now());
        core.join(myPid, profile, now());
        epoch = 1;
      }

      function pickBackup() {     // the next connected human after the host, in seat order
        var me = core.seatOf(myPid), found = null;
        for (var i = 1; i < 4 && !found; i++) {
          var seat = core.s.seats[(me + i + 4) % 4];
          if (seat.bot || !seat.on) continue;
          for (var p in peers) if (peers[p] === seat.pid) found = p;
        }
        return found;
      }
      function announce(force) {
        if (!lob || dead) return;
        var sum = core.summary(), key = JSON.stringify(sum);
        if (force || key !== lastSum) { lastSum = key; lob.send({ t: 'tbl', s: sum }); }
      }
      function flush() {
        if (dead) return;
        var t = now(), ev = core.drain(), p, seat;
        for (p in peers) {
          seat = core.seatOf(peers[p]);
          if (seat < 0) { ch.send({ t: 'error', code: 'idle', msg: 'You were away too long, so a bot took your seat.' }, p); delete peers[p]; continue; }
          ch.send({ t: 'state', s: core.view(seat, t), ev: ev }, p);
        }
        core.s.outbox = [];
        seat = core.seatOf(myPid);
        if (seat < 0) {             // the host dozed off and lost the seat: pass the table on
          shutdown(true);
          h.onError('You were away too long, so a bot took your seat.', 'idle');
          return;
        }
        h.onState(core.view(seat, t), ev);
        var b = pickBackup(), key = b + ':' + core.s.seq + ':' + core.s.turnAt + ':' + core.s.nextAt;
        if (b !== backup) { backup = b; if (b) appointed[b] = 1; ch.send({ t: 'hb', epoch: epoch, backup: backup }); }
        if (b && key !== snapKey) { snapKey = key; ch.send({ t: 'snap', epoch: epoch, s: core.s, hostPid: myPid }, b); }
        clearTimeout(timer);
        var wake = core.nextWake();
        if (wake) timer = setTimeout(function () { core.tick(now()); flush(); }, Math.max(0, wake - now()));
        announce(false);
      }

      ch.on.join = function (peer) { ch.send({ t: 'host', epoch: epoch, backup: backup }, peer); };
      function dropped(peer) {               // connection lost: hold the seat, a bot covers their turns
        var pid = peers[peer];
        if (!pid) return;
        delete peers[peer]; delete seen[peer];
        core.setOffline(pid, now()); flush();
      }
      ch.on.leave = dropped;
      ch.on.msg = function (m, peer) {
        if (dead || !m || typeof m !== 'object' || !peer || !allow(peer)) return;
        var pid = peers[peer], r;
        if (pid) seen[peer] = now();
        if (m.t === 'ping') return;
        if (m.t === 'join') {
          if (!isToken(m.key)) return;
          pid = pidOf(m.key);
          if (pid === myPid) { ch.send({ t: 'error', code: 'replaced', msg: 'This table is already open in another tab or device.' }, peer); return; }
          if (peers[peer] && peers[peer] !== pid) return;                  // one seat per connection
          seen[peer] = now();
          for (var other in peers) {
            if (peers[other] === pid && other !== peer) { ch.send({ t: 'error', code: 'replaced', msg: 'This table is open in another tab or device.' }, other); delete peers[other]; }
          }
          r = core.join(pid, { name: typeof m.name === 'string' ? m.name.slice(0, 40) : '', av: m.av }, now());
          if (r.error) { ch.send({ t: 'error', code: 'full', msg: 'That table is full.' }, peer); return; }
          peers[peer] = pid; flush();
        } else if (m.t === 'act' && pid) {
          var move = cleanAct(m.m);
          if (!move) return;
          r = core.act(pid, move, now());
          if (r && r.error) ch.send({ t: 'error', code: 'move', msg: r.error }, peer);
          flush();
        } else if (m.t === 'leave' && pid) {
          delete peers[peer]; core.leave(pid, now()); flush();
        } else if (m.t === 'bye' && pid) {          // tab closed or reloading: hold the seat for a bit
          dropped(peer);
        } else if ((m.t === 'host' || m.t === 'hb') && appointed[peer] && isInt(m.epoch, epoch + 1, 1e6)) {
          // The table carried on under the successor this host named, while this one was out of touch.
          // (Anybody else claiming to host is ignored.)
          shutdown(false);
          h.onError('The table carried on with a new host while you were away. Rejoining…', 'moved');
        }
      };

      var beat = setInterval(function () {
        if (dead) return;
        ch.send({ t: 'hb', epoch: epoch, backup: backup });
        var t = now();                         // a player whose tab died silently stops pinging
        for (var p in peers) if (t - (seen[p] || 0) > timing.hostLost) dropped(p);
      }, timing.heartbeat);
      var again = setInterval(function () { announce(true); }, timing.announce);
      if (core.s.pub) {
        lob = open('lobby');
        lob.on.join = function (peer) { if (!dead) lob.send({ t: 'tbl', s: core.summary() }, peer); };
        lob.on.msg = function (m, peer) { if (!dead && m && m.t === 'who' && allowWho(peer)) lob.send({ t: 'tbl', s: core.summary() }, peer); };
      }

      /* Stop hosting. If `handOver`, give the table to the next player first. */
      function shutdown(handOver) {
        if (dead) return;
        if (handOver) {
          if (core.seatOf(myPid) >= 0) core.leave(myPid, now());
          var b = pickBackup();
          if (b) { appointed[b] = 1; ch.send({ t: 'snap', epoch: epoch, s: core.s, hostPid: null }, b); ch.send({ t: 'handover', epoch: epoch, to: b }); }
        }
        if (lob) lob.send({ t: 'gone' });
        dead = true;
        clearTimeout(timer); clearInterval(beat); clearInterval(again);
        var l = lob; lob = null;
        setTimeout(function () { ch.close(); if (l) l.close(); }, 250);     // let the last messages leave first
      }

      ch.send({ t: 'host', epoch: epoch, backup: null });
      if (takeover) h.onError('The host left, so you’re hosting now. Keep this tab open.', 'note');
      setTimeout(function () { if (!dead) { h.onStatus('online'); flush(); } }, 0);

      return {
        hosting: true,
        send: function (msg) {
          if (dead) return;
          var r = core.act(myPid, msg, now());
          if (r && r.error) h.onError(r.error, 'move');
          flush();
        },
        close: function () { shutdown(true); },
        kill: function () { dead = true; clearTimeout(timer); clearInterval(beat); clearInterval(again); },   // tests: a tab that just vanishes
        others: function () { return Object.keys(peers).length; }
      };
    }

    /* ---------- a seat at someone else's table ---------- */
    function guest(code, profile, h) {
      var ch = open('table-' + code);
      var token = tokenOf(profile, code);
      var pin = pins[code] || null;           // came from the lobby: the peer that listed this table
      var hostId = null, lastHost = null, heir = null, epoch = 0, askedEpoch = -1, lastBeat = 0, backupId = null, snap = null;
      var started = now(), lostAt = 0, dead = false, live = false, role = null;

      function fail(msg, code_) { if (dead) return; stop(); h.onError(msg, code_); }
      function stop() { dead = true; clearInterval(watch); setTimeout(function () { if (!role) ch.close(); }, 250); }

      /* Somebody says they host this table. Who is believed:
       *   - first contact: the peer that listed the table in the lobby if we came from
       *     there (anyone, once that peer has had its chance); otherwise the first to speak
       *   - after that: only the same host again, or, once that host is gone, the one
       *     successor it named. Nobody else, whatever they claim. */
      function hello(peer, m) {
        if (!isInt(m.epoch, 1, 1e6)) return;
        if (peer !== hostId) {
          var ok;
          if (!lastHost) ok = !pin || peer === pin || now() - started > timing.pinWait;
          else if (hostId) ok = false;
          else ok = (peer === lastHost && m.epoch === epoch) || (peer === heir && m.epoch > epoch);
          if (!ok) return;
          if (peer !== lastHost) snap = null;
          hostId = lastHost = peer; epoch = m.epoch; heir = null;
        } else if (m.epoch !== epoch) return;
        var wasLost = !!lostAt;
        lastBeat = now(); lostAt = 0; backupId = typeof m.backup === 'string' ? m.backup : null;
        // sit down with a new host, or check back in after a scare
        if (askedEpoch !== epoch || wasLost) { askedEpoch = epoch; ch.send({ t: 'join', key: token, name: profile.name, av: profile.av }, hostId); }
      }
      function hostLost() {
        if (dead || lostAt) return;
        var mine = backupId === ch.selfId && snap;
        hostId = null; heir = backupId;
        if (mine) return promote(snap.hostPid);
        lostAt = now(); live = false;
        h.onStatus('reconnecting');
      }
      /* This player inherits the table and becomes its host. */
      function promote(oldHostPid) {
        var state = cleanSnapshot(snap.s, code);
        if (!state) return fail('The host left and the table could not be carried on.', 'gone');
        dead = true; clearInterval(watch);
        ch.on = {};
        role = host(code, null, profile, h, { ch: ch, s: state, epoch: epoch, oldHostPid: /^k[0-9a-f]{40}$/.test(oldHostPid || '') ? oldHostPid : null });
      }

      ch.on.msg = function (m, peer) {
        if (dead || !m || typeof m !== 'object' || !peer) return;
        if (m.t === 'host' || m.t === 'hb') return hello(peer, m);
        if (peer !== hostId) return;
        if (m.t === 'state') {
          var v = cleanView(m.s, code);
          if (!v) return;
          if (!live) { live = true; h.onStatus('online'); }
          h.onState(v, cleanEvents(m.ev));
        } else if (m.t === 'snap') snap = m;
        else if (m.t === 'handover') {
          if (m.to === ch.selfId && snap) promote(null);
          else { hostId = null; heir = typeof m.to === 'string' ? m.to : null; lostAt = now(); live = false; h.onStatus('reconnecting'); }
        } else if (m.t === 'error') {
          var text = P.cleanText(typeof m.msg === 'string' ? m.msg.slice(0, 300) : '', 160) || 'Something went wrong at the table.';
          if (FATAL[m.code] === 1) fail(text, m.code);
          else h.onError(text, m.code === 'move' ? 'move' : 'net');
        }
      };
      ch.on.join = function () { /* the host introduces itself */ };
      ch.on.leave = function (peer) { if (peer === hostId) hostLost(); };

      var lastPing = 0;
      var watch = setInterval(function () {
        if (dead) return;
        var t = now();
        if (hostId && t - lastPing >= timing.heartbeat) { lastPing = t; ch.send({ t: 'ping' }, hostId); }
        if (hostId && t - lastBeat > timing.hostLost) hostLost();
        else if (lostAt && t - lostAt > timing.recover) fail('The host left and nobody could take over the table.', 'gone');
        else if (!hostId && !lostAt && t - started > timing.connect) fail('Couldn’t reach that table. It may have closed, or a network in between is blocking direct connections.', 'gone');
      }, Math.min(1000, timing.heartbeat));
      setTimeout(function () { if (!dead) h.onStatus('connecting'); }, 0);

      return {
        get hosting() { return !!role; },
        send: function (msg) {
          if (role) return role.send(msg);
          if (dead) return;
          if (!hostId) return h.onError('Reconnecting… try again in a second.', 'net');
          ch.send({ t: 'act', m: msg }, hostId);
        },
        close: function () {
          if (role) return role.close();
          if (hostId) ch.send({ t: 'leave' }, hostId);
          stop();
        },
        bye: function () { if (!role && hostId && !dead) ch.send({ t: 'bye' }, hostId); },
        kill: function () { if (role) role.kill(); dead = true; clearInterval(watch); },
        others: function () { return role ? role.others() : 0; }
      };
    }

    /* Host a table this player just opened, or join one by its code. */
    function online(code, profile, h) {
      var o = pendingHost[code];
      delete pendingHost[code];
      var s = o ? host(code, o, profile, h) : guest(code, profile, h);
      s.solo = false;
      return s;
    }

    return { lobby: lobby, online: online, host: host, guest: guest };
  }

  var shared = null;
  P.P2P = {
    timing: timing,
    create: create,
    sha256: sha256, tokenOf: tokenOf, cleanView: cleanView, cleanEvents: cleanEvents, cleanSnapshot: cleanSnapshot,
    /* True when this browser can do player-hosted tables at all. */
    available: function () { return !!(root.Trystero && root.RTCPeerConnection && root.WebSocket); },
    get: function () { return shared || (shared = create(trysteroTransport)); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
