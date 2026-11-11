/* Pusoy Dos — one table: seats, dealing, turns, scoring, timers.
 * The same code referees solo games in the browser and live tables on the
 * server. It never touches the network or the clock itself: the host passes
 * `now` in, calls tick() when nextWake() says so, and broadcasts view().
 */
(function (root) {
  'use strict';
  var P = (root.Pusoy = root.Pusoy || {});
  var E = P.Engine, Bot = P.Bot;

  var BOT_NAMES = ['Ace', 'Blitz', 'Pixel', 'Turbo', 'Nova', 'Dash', 'Jinx', 'Rook'];
  /* Every bot has a way of playing (see bot.js): steady, a rusher who throws big cards
   * early, a hoarder who sits on them, or a trickster who passes early to hide a hand. */
  var BOT_STYLE = { Ace: 'steady', Dash: 'steady', Blitz: 'rusher', Turbo: 'rusher', Rook: 'hoarder', Nova: 'hoarder', Jinx: 'trickster', Pixel: 'trickster' };
  /* The reactions a player can send. Only the number travels, never text. */
  var REACTIONS = ['\uD83D\uDC4D', '\uD83D\uDE02', '\uD83D\uDE31', '\uD83D\uDD25', '\uD83D\uDE2D', '\uD83D\uDC4F', '\uD83D\uDE0E', '\uD83E\uDD14', '\uD83C\uDF45', '\u2764\uFE0F'];
  var R = { up: 0, laugh: 1, shock: 2, fire: 3, cry: 4, clap: 5, cool: 6, hmm: 7, tomato: 8, heart: 9 };
  var READY_MS = 20000;     // once somebody is ready, the rest get this long before the deal goes ahead anyway
  var REACT_GAP_MS = 500;
  var AWAY_MS = 45000;      // a dropped player keeps their seat this long
  var EMPTY_MS = 60000;     // a table with nobody connected closes after this
  var NEXT_ROUND_MS = 11000;
  var DEAL_MS = 1500;
  var CLEAR_MS = 900;
  var CHAT_GAP_MS = 700;

  function clampInt(v, lo, hi, dflt) {
    v = Math.round(Number(v));
    return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
  }
  function cleanText(s, max) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function createState(o, now) {
    o = o || {};
    var pick = E.shuffledDeck().filter(function (n) { return n < BOT_NAMES.length; }).slice(0, 4);
    return {
      v: 1,
      code: String(o.code || 'SOLO'),
      name: cleanText(o.name, 28) || 'Table',
      pub: !!o.pub,
      opts: {
        rounds: clampInt(o.rounds, 1, 20, 5),
        turnSecs: clampInt(o.turnSecs, 0, 120, 30),   // 0 = no clock
        passLock: o.passLock !== false,               // pass = out until the table clears
        manualNext: !!o.manualNext,                   // solo: wait for a tap between rounds
        aids: !!o.aids,                               // solo only: hints, quick picks and the cards-played tracker
        bots: Bot.LEVELS.indexOf(o.bots) >= 0 ? o.bots : 'normal',   // easy | normal | hard
        think: clampInt(o.think, 0, 200, 0),          // ms a hard bot may spend looking ahead on each move
        readyMs: clampInt(o.readyMs, 20, 120000, READY_MS),
        emotes: o.emotes !== false,                   // bots send the odd reaction of their own
        botMs: o.botMs || [800, 1500]
      },
      seats: [0, 1, 2, 3].map(function (i) {
        return { pid: null, name: BOT_NAMES[pick[i]], botName: BOT_NAMES[pick[i]], av: i, bot: true, on: false, awayAt: 0, afk: 0, chatAt: 0, ready: false, reactAt: 0 };
      }),
      series: [0, 0, 0, 0],       // matches won in a row of rematches, by seat
      readyAt: 0,                 // when the deal goes ahead without the players who are not ready
      reacts: [],                 // bot reactions waiting for their moment: { at, seat, e, to }
      phase: 'waiting',           // waiting | playing | roundEnd | matchEnd
      round: 0,
      scores: [0, 0, 0, 0],
      wins: [0, 0, 0, 0],
      lastWinner: -1,
      hands: [[], [], [], []],
      passed: [false, false, false, false],
      turn: -1,
      table: null,                // the hand to beat: { cards, by, type, size, power, name }
      trick: [],                  // earlier plays in this trick, oldest first
      seen: [],                   // every card played this round (public knowledge)
      mustOpen: false,
      result: null,
      turnAt: 0, actAt: 0, nextAt: 0, closeAt: 0,
      outbox: [],                 // finished-match results waiting for the leaderboard
      seq: 0,
      created: now || 0
    };
  }

  function TableCore(state) {
    this.s = state;
    this.ev = [];
    this.closed = false;
  }

  TableCore.create = function (o, now) { return new TableCore(createState(o, now)); };

  var T = TableCore.prototype;

  T.emit = function (e) { this.ev.push(e); };
  T.drain = function () { var e = this.ev; this.ev = []; return e; };
  T.seatOf = function (pid) {
    if (!pid) return -1;
    for (var i = 0; i < 4; i++) if (this.s.seats[i].pid === pid) return i;
    return -1;
  };
  T.humans = function () { return this.s.seats.filter(function (x) { return !x.bot; }).length; };
  T.online = function () { return this.s.seats.filter(function (x) { return !x.bot && x.on; }).length; };

  /* ---------- seats ---------- */

  T.join = function (pid, profile, now) {
    var s = this.s, i = this.seatOf(pid), seat;
    var wasEmpty = !this.online();
    profile = profile || {};
    var name = cleanText(profile.name, 16) || 'Player';
    var av = clampInt(profile.av, 0, 5, 0);
    if (i >= 0) {
      seat = s.seats[i];
      seat.on = true; seat.awayAt = 0; seat.afk = 0;
      this.emit({ k: 'back', seat: i });
    } else {
      for (var k = 0; k < 4 && i < 0; k++) if (s.seats[k].bot) i = k;
      if (i < 0) return { error: 'full' };
      // keep names distinct at the table
      var taken = s.seats.filter(function (x) { return !x.bot; }).map(function (x) { return x.name.toLowerCase(); });
      var base = name, n = 2;
      while (taken.indexOf(name.toLowerCase()) >= 0) name = base.slice(0, 14) + ' ' + n++;
      seat = s.seats[i];
      seat.pid = pid; seat.name = name; seat.av = av; seat.bot = false; seat.on = true; seat.awayAt = 0; seat.afk = 0;
      seat.ready = false; s.series[i] = 0;
      this.emit({ k: 'join', seat: i, name: name });
    }
    s.closeAt = 0;
    if (wasEmpty) this.resume(now);
    else if (s.phase === 'playing' && s.turn === i) this.schedule(now, 0);
    s.seq++;
    return { seat: i };
  };

  T.setOffline = function (pid, now) {
    var s = this.s, i = this.seatOf(pid);
    if (i < 0) return;
    s.seats[i].on = false; s.seats[i].awayAt = now;
    this.emit({ k: 'away', seat: i });
    if (s.phase === 'playing' && s.turn === i) this.schedule(now, 0);
    if (!this.online()) s.closeAt = now + EMPTY_MS;
    this.checkReady(now);
    s.seq++;
  };

  T.leave = function (pid, now) {
    var i = this.seatOf(pid);
    if (i >= 0) this.toBot(i, now);
  };

  T.toBot = function (i, now) {
    var s = this.s, seat = s.seats[i];
    this.emit({ k: 'leave', seat: i, name: seat.name });
    seat.pid = null; seat.name = seat.botName; seat.bot = true; seat.on = false; seat.awayAt = 0; seat.afk = 0;
    seat.ready = false; s.series[i] = 0;
    if (s.phase === 'playing' && s.turn === i) this.schedule(now, 0);
    this.checkReady(now);
    if (!this.humans()) { s.closeAt = now; }
    else if (!this.online()) s.closeAt = now + EMPTY_MS;
    s.seq++;
  };

  /* ---------- messages from players ---------- */

  T.act = function (pid, msg, now) {
    var s = this.s, i = this.seatOf(pid);
    if (i < 0 || !msg) return { error: 'not seated' };
    var seat = s.seats[i];
    switch (msg.t) {
      case 'start':            // alone at the table: deal. With company it counts as "I'm ready".
      case 'ready':
        if (s.phase !== 'waiting' && s.phase !== 'matchEnd') return { error: 'already playing' };
        if (msg.t === 'start' && this.online() <= 1) { this.startMatch(now); return {}; }
        seat.ready = msg.t === 'start' || msg.on !== false;
        this.emit({ k: 'ready', seat: i, on: seat.ready });
        this.checkReady(now);
        s.seq++;
        return {};
      case 'react':
        if (!(msg.e >= 0 && msg.e < REACTIONS.length) || msg.e !== Math.floor(msg.e)) return { error: 'unknown reaction' };
        if (now - seat.reactAt < REACT_GAP_MS) return {};
        seat.reactAt = now;
        var to = msg.to >= 0 && msg.to <= 3 && msg.to === Math.floor(msg.to) && msg.to !== i ? msg.to : -1;
        this.emit({ k: 'react', seat: i, e: msg.e, to: to });
        if (to >= 0 && s.seats[to].bot) this.botReply(to, i, msg.e, now);
        return {};
      case 'next':
        if (s.phase !== 'roundEnd' || !s.opts.manualNext) return { error: 'not now' };
        this.nextRound(now);
        return {};
      case 'play':
        seat.afk = 0;
        return this.play(i, msg.cards, now);
      case 'pass':
        seat.afk = 0;
        return this.pass(i, now);
      case 'chat':
        if (now - seat.chatAt < CHAT_GAP_MS) return { error: 'slow down' };
        var text = cleanText(msg.text, 80);
        if (!text) return {};
        seat.chatAt = now;
        this.emit({ k: 'chat', seat: i, text: text });
        return {};
      default:
        return { error: 'unknown message' };
    }
  };

  /* ---------- the game ---------- */

  /* Ready-up, before the first deal and for a rematch. The cards are dealt as soon as
   * every connected player is ready; once one is, the others get readyMs to catch up. */
  T.checkReady = function (now) {
    var s = this.s;
    if (s.phase !== 'waiting' && s.phase !== 'matchEnd') return;
    var here = 0, ready = 0;
    s.seats.forEach(function (x) { if (!x.bot && x.on) { here++; if (x.ready) ready++; } });
    if (ready && ready === here) return this.startMatch(now);
    if (!ready) s.readyAt = 0;
    else if (!s.readyAt) s.readyAt = now + s.opts.readyMs;
  };

  /* ---------- match awards ----------
   * A little bookkeeping per seat while the match is played, turned into a handful of
   * titles when it ends. Worked out here, not on each screen, so everybody sees the same ones. */
  function blankStats() {
    return [0, 1, 2, 3].map(function () {
      return { twos: 0, tricks: 0, passes: 0, fives: 0, big: 0, run: 0, best: 0, turns: 0, quick: 0, stuck: 0 };
    });
  }
  T.stat = function (i) {
    var s = this.s;
    if (!Array.isArray(s.stats) || s.stats.length !== 4) s.stats = blankStats();      // a table carried over from an older host
    return s.stats[i];
  };
  // id, what is counted, the least that earns it, and whether fewer is better
  var AWARDS = [
    ['dos', 'twos', 3],          // most 2s played
    ['heavy', 'big', 100],       // the biggest five-card hand (kind * 100 + its top rank)
    ['streak', 'best', 3],       // most tricks taken in a row
    ['sprint', 'quick', 1, true],// out in the fewest plays
    ['tricks', 'tricks', 4],     // most tricks taken
    ['combo', 'fives', 3],       // most five-card hands
    ['bag', 'stuck', 9],         // most cards left in hand when a round ended
    ['bench', 'passes', 8]       // most passes
  ];
  function pickAwards(stats) {
    var found = [], out = [], held = [0, 0, 0, 0];
    AWARDS.forEach(function (a) {
      var best = -1, tie = false;
      for (var i = 0; i < 4; i++) {
        var v = stats[i][a[1]];
        if (!v || v < a[2]) continue;
        if (best < 0 || (a[3] ? v < stats[best][a[1]] : v > stats[best][a[1]])) { best = i; tie = false; }
        else if (v === stats[best][a[1]]) tie = true;
      }
      if (best >= 0 && !tie) found.push({ id: a[0], seat: best, n: stats[best][a[1]] });      // a tie is nobody's award
    });
    // spread them around: one each first, then seconds, four at most
    for (var pass = 0; pass < 2; pass++) {
      found.forEach(function (f) {
        if (out.length < 4 && held[f.seat] === pass && out.indexOf(f) < 0) { out.push(f); held[f.seat]++; }
      });
    }
    return out;
  }

  T.startMatch = function (now) {
    var s = this.s;
    s.round = 0; s.scores = [0, 0, 0, 0]; s.wins = [0, 0, 0, 0]; s.lastWinner = -1;
    s.stats = blankStats();
    s.readyAt = 0; s.seats.forEach(function (x) { x.ready = false; });
    this.nextRound(now);
  };

  /* ---------- bots with a bit of life: the odd reaction, in character ---------- */

  T.queueReact = function (seat, e, now, to, wait) {
    var s = this.s, x = s.seats[seat];
    if (!s.opts.emotes || !x.bot || now - x.reactAt < 5000) return;
    x.reactAt = now;
    s.reacts.push({ at: now + (wait || 700) + E.randInt(500), seat: seat, e: e, to: to === undefined ? -1 : to });
  };
  function chance(p) { return E.randInt(1000) < p * 1000; }
  /* Somebody played: who has something to say about it? */
  T.botMoods = function (by, c, now) {
    var s = this.s, style = BOT_STYLE[s.seats[by].botName], twos = c.cards.filter(function (id) { return id >= 48; }).length;
    var big = c.cards.indexOf(51) >= 0, strong = c.size === 5 && c.tier >= 3;
    if (s.seats[by].bot && (twos || strong) && chance(style === 'rusher' ? 0.5 : 0.22)) this.queueReact(by, style === 'rusher' ? R.fire : R.cool, now, -1, 900);
    for (var k = 1; k < 4; k++) {
      var o = (by + k) % 4, st = BOT_STYLE[s.seats[o].botName];
      if (!s.seats[o].bot) continue;
      if (big && chance(0.35)) { this.queueReact(o, R.shock, now, -1, 1700); break; }
      if (strong && chance(0.14)) { this.queueReact(o, st === 'trickster' ? R.laugh : R.clap, now, -1, 900); break; }
      if (s.hands[by].length === 1 && chance(0.2)) { this.queueReact(o, st === 'hoarder' ? R.hmm : R.shock, now, -1, 800); break; }
    }
  };
  /* A player aimed a reaction at a bot. Most of the time it answers. */
  T.botReply = function (bot, from, e, now) {
    var style = BOT_STYLE[this.s.seats[bot].botName];
    if (!chance(0.7)) return;
    var back = e === R.tomato ? (style === 'rusher' ? R.tomato : style === 'trickster' ? R.laugh : R.cry)
      : e === R.heart || e === R.up || e === R.clap ? (style === 'hoarder' ? R.cool : R.heart)
      : e === R.laugh ? (style === 'rusher' ? R.fire : R.laugh) : R.hmm;
    this.s.seats[bot].reactAt = 0;                 // a direct answer is never held back
    this.queueReact(bot, back, now, back === R.tomato ? from : -1, 600);
  };

  T.nextRound = function (now) {
    var s = this.s;
    s.round++;
    s.hands = E.deal();
    s.passed = [false, false, false, false];
    s.table = null; s.trick = []; s.seen = []; s.result = null; s.nextAt = 0;
    for (var q = 0; q < 4; q++) { this.stat(q).turns = 0; this.stat(q).run = 0; }
    s.phase = 'playing';
    // Lowest card always plays first: whoever holds the 3 of clubs opens every round,
    // and their opening play has to include it (alone or inside a hand).
    for (var i = 0; i < 4; i++) if (s.hands[i][0] === E.THREE_OF_CLUBS) s.turn = i;
    s.mustOpen = true;
    this.emit({ k: 'deal', round: s.round, first: s.turn });
    this.schedule(now, DEAL_MS);
    s.seq++;
  };

  /* Set the clock for whoever's turn it is. */
  T.schedule = function (now, extra) {
    var s = this.s;
    s.turnAt = 0; s.actAt = 0;
    if (s.phase !== 'playing' || s.turn < 0) return;
    var seat = s.seats[s.turn];
    if (seat.bot) {
      var b = s.opts.botMs;
      s.actAt = now + extra + b[0] + E.randInt(Math.max(1, b[1] - b[0]));
    } else if (!seat.on || seat.afk >= 2) {
      s.actAt = now + extra + 2500;              // play for someone who dropped or dozed off
    } else if (s.opts.turnSecs > 0) {
      s.turnAt = now + extra + s.opts.turnSecs * 1000;
    }
  };

  T.play = function (i, ids, now) {
    var s = this.s;
    if (s.phase !== 'playing') return { error: 'No round in progress.' };
    if (s.turn !== i) return { error: 'It isn’t your turn.' };
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5) return { error: 'Play 1, 2, 3 or 5 cards.' };
    var hand = s.hands[i];
    for (var k = 0; k < ids.length; k++) {
      if (hand.indexOf(ids[k]) < 0 || ids.indexOf(ids[k]) !== k) return { error: 'Those aren’t your cards.' };
    }
    var res = E.check(ids, s.table, s.mustOpen);
    if (!res.ok) return { error: res.reason };
    var c = res.combo;

    s.hands[i] = hand.filter(function (id) { return ids.indexOf(id) < 0; });
    if (s.table) { s.trick.push({ cards: s.table.cards, by: s.table.by }); if (s.trick.length > 3) s.trick.shift(); }
    s.table = { cards: c.cards, by: i, type: c.type, size: c.size, power: c.power, name: c.name, label: c.label };
    s.mustOpen = false;
    s.seen = (s.seen || []).concat(c.cards);
    if (!s.opts.passLock) s.passed = [false, false, false, false];
    var st = this.stat(i);
    st.turns++;
    st.twos += c.cards.filter(function (id) { return id >= 48; }).length;
    if (c.cards.length === 5) { st.fives++; st.big = Math.max(st.big, E.TIER[c.type] * 100 + (Math.max.apply(null, c.cards) >> 2) + 1); }
    this.emit({ k: 'play', seat: i, cards: c.cards, name: c.name, type: c.type, left: s.hands[i].length });
    this.botMoods(i, c, now);
    s.seq++;

    if (!s.hands[i].length) { this.endRound(i, now); return {}; }
    // Give the big cards a beat before the next player acts: longer for the 2 of diamonds.
    var showtime = c.cards.indexOf(51) >= 0 ? 1500 : c.cards[c.cards.length - 1] >= 48 ? 350 : 0;
    this.advance(now, showtime);
    return {};
  };

  T.pass = function (i, now) {
    var s = this.s;
    if (s.phase !== 'playing') return { error: 'No round in progress.' };
    if (s.turn !== i) return { error: 'It isn’t your turn.' };
    if (!s.table) return { error: 'You have the lead. Play something.' };
    s.passed[i] = true;
    this.stat(i).passes++;
    this.emit({ k: 'pass', seat: i });
    s.seq++;
    this.advance(now);
    return {};
  };

  T.advance = function (now, pause) {
    var s = this.s, extra = pause || 0;
    var n = s.turn;
    for (var step = 0; step < 4; step++) {
      n = (n + 1) % 4;
      if (n === s.table.by || !s.passed[n]) break;
    }
    if (n === s.table.by) {
      // Everyone else passed: the last player to play takes the trick and leads.
      s.table = null; s.trick = []; s.passed = [false, false, false, false];
      for (var j = 0; j < 4; j++) if (j !== n) this.stat(j).run = 0;
      var w = this.stat(n);
      w.tricks++; w.run++; w.best = Math.max(w.best, w.run);
      this.emit({ k: 'clear', seat: n });
      extra += CLEAR_MS;
    }
    s.turn = n;
    this.schedule(now, extra);
  };

  T.endRound = function (winner, now) {
    var s = this.s, pen = [0, 0, 0, 0], delta = [0, 0, 0, 0], left = [0, 0, 0, 0], pot = 0;
    for (var i = 0; i < 4; i++) {
      var n = s.hands[i].length;
      left[i] = n;
      // one point a card; a hand of 10+ counts double, an untouched 13 triple
      pen[i] = n * (n >= 13 ? 3 : n >= 10 ? 2 : 1);
      pot += pen[i];
    }
    for (i = 0; i < 4; i++) {
      delta[i] = i === winner ? pot : -pen[i]; s.scores[i] += delta[i];
      var st = this.stat(i);
      if (i === winner) st.quick = st.quick ? Math.min(st.quick, st.turns) : st.turns;
      else st.stuck = Math.max(st.stuck, left[i]);
    }
    s.wins[winner]++;
    s.lastWinner = winner;
    s.turn = -1; s.turnAt = 0; s.actAt = 0;
    var last = s.round >= s.opts.rounds;
    s.result = { winner: winner, left: left, delta: delta, hands: s.hands.map(function (h) { return h.slice(); }), champ: -1 };
    s.phase = last ? 'matchEnd' : 'roundEnd';
    this.emit({ k: 'roundEnd', winner: winner });
    for (i = 0; i < 4; i++) {
      if (!s.seats[i].bot) continue;
      if (i === winner) { if (chance(0.45)) this.queueReact(i, BOT_STYLE[s.seats[i].botName] === 'trickster' ? R.laugh : R.cool, now, -1, 2200); }
      else if (left[i] >= 10 && chance(0.5)) this.queueReact(i, R.cry, now, -1, 2400);
      else if (!s.seats[winner].bot && chance(0.2)) this.queueReact(i, R.clap, now, -1, 2400);
    }
    if (last) {
      var champ = 0;
      for (i = 1; i < 4; i++) {
        if (s.scores[i] > s.scores[champ] || (s.scores[i] === s.scores[champ] && s.wins[i] > s.wins[champ])) champ = i;
      }
      s.result.champ = champ;
      s.result.awards = pickAwards(s.stats);
      for (i = 0; i < 4; i++) s.series[i] = i === champ ? s.series[i] + 1 : 0;      // a winning streak across rematches
      this.emit({ k: 'matchEnd', champ: champ });
      var humans = this.humans();
      for (i = 0; i < 4; i++) {
        var seat = s.seats[i];
        if (!seat.bot) {
          s.outbox.push({ pid: seat.pid, name: seat.name, av: seat.av, won: i === champ, rounds: s.wins[i], points: s.scores[i], humans: humans });
        }
      }
    } else if (!s.opts.manualNext) {
      s.nextAt = now + NEXT_ROUND_MS;
    }
    s.seq++;
  };

  /* What a player who ran out of time (or a bot) does. */
  T.autoMove = function (i, smart, now) {
    var s = this.s, cards = null;
    if (smart) {
      cards = Bot.choose({
        hand: s.hands[i], table: s.table, seat: i, passed: s.passed, mustOpen: s.mustOpen,
        counts: s.hands.map(function (h) { return h.length; }),
        seen: s.seen || [],                    // public knowledge: a card counter would know it too
        passLock: s.opts.passLock, think: s.opts.think || 0,
        // a bot seat plays at the table's level; covering for a player who stepped away is always "normal"
        level: s.seats[i].bot ? s.opts.bots : 'normal',
        style: s.seats[i].bot ? BOT_STYLE[s.seats[i].botName] : 'steady'
      });
    } else if (!s.table) {
      cards = [s.hands[i][0]];               // on the lead: lowest card (the 3 of clubs when opening)
    }
    var r = cards ? this.play(i, cards, now) : this.pass(i, now);
    if (r.error) {                           // should never happen; keep the game moving regardless
      r = s.table ? this.pass(i, now) : this.play(i, [s.hands[i][0]], now);
    }
    return r;
  };

  /* ---------- time ---------- */

  T.tick = function (now) {
    var s = this.s, i;
    if (s.closeAt && now >= s.closeAt) { this.closed = true; return; }
    for (i = 0; i < 4; i++) {
      var seat = s.seats[i];
      if (!seat.bot && !seat.on && seat.awayAt && now - seat.awayAt >= AWAY_MS) this.toBot(i, now);
    }
    if (s.closeAt && now >= s.closeAt) { this.closed = true; return; }
    if (!this.online()) return;              // nobody watching: freeze until someone is back
    if (s.reacts.length) {                   // bot reactions whose moment has come
      var due = s.reacts.filter(function (r) { return r.at <= now; }), self = this;
      if (due.length) {
        s.reacts = s.reacts.filter(function (r) { return r.at > now; });
        due.forEach(function (r) { if (s.seats[r.seat].bot) self.emit({ k: 'react', seat: r.seat, e: r.e, to: r.to }); });
      }
    }
    if (s.readyAt && now >= s.readyAt && (s.phase === 'waiting' || s.phase === 'matchEnd')) { this.startMatch(now); return; }
    if (s.phase === 'playing' && s.turn >= 0) {
      var guard = 0;
      while (s.phase === 'playing' && guard++ < 8) {
        if (s.actAt && now >= s.actAt) {
          var cur = s.seats[s.turn];
          // someone who keeps letting the clock run out eventually gives up the seat
          if (!cur.bot && cur.on && cur.afk >= 2 && ++cur.afk >= 6) { this.toBot(s.turn, now); continue; }
          this.autoMove(s.turn, true, now);
        } else if (s.turnAt && now >= s.turnAt) {
          var t = s.turn, st = s.seats[t];
          st.afk++;
          this.emit({ k: 'timeout', seat: t });
          if (st.afk >= 4) { this.toBot(t, now); }
          else this.autoMove(t, false, now);
        } else break;
      }
    } else if (s.phase === 'roundEnd' && s.nextAt && now >= s.nextAt) {
      this.nextRound(now);
    }
  };

  T.nextWake = function () {
    var s = this.s, w = [];
    if (s.closeAt) w.push(s.closeAt);
    s.seats.forEach(function (x) { if (!x.bot && !x.on && x.awayAt) w.push(x.awayAt + AWAY_MS); });
    if (this.online()) {
      if (s.actAt) w.push(s.actAt);
      if (s.turnAt) w.push(s.turnAt);
      if (s.nextAt) w.push(s.nextAt);
      if (s.readyAt) w.push(s.readyAt);
      s.reacts.forEach(function (r) { w.push(r.at); });
    }
    return w.length ? Math.min.apply(null, w) : 0;
  };

  /* Called when someone comes back to a frozen table. */
  T.resume = function (now) {
    var s = this.s;
    if (s.phase === 'playing') this.schedule(now, 600);
    else if (s.phase === 'roundEnd' && !s.opts.manualNext) s.nextAt = now + 4000;
  };

  /* ---------- what each player is allowed to see ---------- */

  T.view = function (i, now) {
    var s = this.s;
    return {
      code: s.code, name: s.name, pub: s.pub,
      rounds: s.opts.rounds, turnSecs: s.opts.turnSecs, passLock: s.opts.passLock, manualNext: s.opts.manualNext,
      bots: s.opts.bots || 'normal',
      phase: s.phase, round: s.round, you: i, seq: s.seq,
      seats: s.seats.map(function (x, k) {
        return { name: x.name, av: x.av, bot: x.bot, on: x.bot || x.on, n: s.hands[k].length, passed: s.passed[k], score: s.scores[k], wins: s.wins[k],
          ready: x.bot || !!x.ready, series: s.series[k], style: x.bot ? BOT_STYLE[x.botName] || 'steady' : '' };
      }),
      hand: i >= 0 ? s.hands[i] : [],
      turn: s.turn, table: s.table, trick: s.trick.slice(-2), mustOpen: s.mustOpen,
      aids: !!s.opts.aids, seen: s.opts.aids ? (s.seen || []) : [],     // live tables never send the played-cards list
      turnAt: s.turnAt, nextAt: s.nextAt, readyAt: s.readyAt, now: now,
      result: (s.phase === 'roundEnd' || s.phase === 'matchEnd') ? s.result : null
    };
  };

  /* The row shown in the list of live tables. */
  T.summary = function () {
    var s = this.s;
    return {
      code: s.code, name: s.name, pub: s.pub, phase: s.phase, round: s.round, rounds: s.opts.rounds,
      turnSecs: s.opts.turnSecs, bots: s.opts.bots || 'normal',
      seats: s.seats.map(function (x) { return x.bot ? null : { name: x.name, av: x.av }; })
    };
  };

  P.TableCore = TableCore;
  P.BOT_NAMES = BOT_NAMES;
  P.BOT_STYLE = BOT_STYLE;
  P.REACTIONS = REACTIONS;
  P.cleanText = cleanText;
})(typeof globalThis !== 'undefined' ? globalThis : this);
