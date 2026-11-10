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
        botMs: o.botMs || [800, 1500]
      },
      seats: [0, 1, 2, 3].map(function (i) {
        return { pid: null, name: BOT_NAMES[pick[i]], botName: BOT_NAMES[pick[i]], av: i, bot: true, on: false, awayAt: 0, afk: 0, chatAt: 0 };
      }),
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
    if (s.phase === 'playing' && s.turn === i) this.schedule(now, 0);
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
      case 'start':
        if (s.phase !== 'waiting' && s.phase !== 'matchEnd') return { error: 'already playing' };
        this.startMatch(now);
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

  T.startMatch = function (now) {
    var s = this.s;
    s.round = 0; s.scores = [0, 0, 0, 0]; s.wins = [0, 0, 0, 0]; s.lastWinner = -1;
    this.nextRound(now);
  };

  T.nextRound = function (now) {
    var s = this.s;
    s.round++;
    s.hands = E.deal();
    s.passed = [false, false, false, false];
    s.table = null; s.trick = []; s.seen = []; s.result = null; s.nextAt = 0;
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
    this.emit({ k: 'play', seat: i, cards: c.cards, name: c.name, type: c.type, left: s.hands[i].length });
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
    for (i = 0; i < 4; i++) { delta[i] = i === winner ? pot : -pen[i]; s.scores[i] += delta[i]; }
    s.wins[winner]++;
    s.lastWinner = winner;
    s.turn = -1; s.turnAt = 0; s.actAt = 0;
    var last = s.round >= s.opts.rounds;
    s.result = { winner: winner, left: left, delta: delta, hands: s.hands.map(function (h) { return h.slice(); }), champ: -1 };
    s.phase = last ? 'matchEnd' : 'roundEnd';
    this.emit({ k: 'roundEnd', winner: winner });
    if (last) {
      var champ = 0;
      for (i = 1; i < 4; i++) {
        if (s.scores[i] > s.scores[champ] || (s.scores[i] === s.scores[champ] && s.wins[i] > s.wins[champ])) champ = i;
      }
      s.result.champ = champ;
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
        counts: s.hands.map(function (h) { return h.length; })
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
      phase: s.phase, round: s.round, you: i, seq: s.seq,
      seats: s.seats.map(function (x, k) {
        return { name: x.name, av: x.av, bot: x.bot, on: x.bot || x.on, n: s.hands[k].length, passed: s.passed[k], score: s.scores[k], wins: s.wins[k] };
      }),
      hand: i >= 0 ? s.hands[i] : [],
      turn: s.turn, table: s.table, trick: s.trick.slice(-2), mustOpen: s.mustOpen,
      aids: !!s.opts.aids, seen: s.opts.aids ? (s.seen || []) : [],     // live tables never send the played-cards list
      turnAt: s.turnAt, nextAt: s.nextAt, now: now,
      result: (s.phase === 'roundEnd' || s.phase === 'matchEnd') ? s.result : null
    };
  };

  /* The row shown in the list of live tables. */
  T.summary = function () {
    var s = this.s;
    return {
      code: s.code, name: s.name, pub: s.pub, phase: s.phase, round: s.round, rounds: s.opts.rounds,
      turnSecs: s.opts.turnSecs,
      seats: s.seats.map(function (x) { return x.bot ? null : { name: x.name, av: x.av }; })
    };
  };

  P.TableCore = TableCore;
  P.BOT_NAMES = BOT_NAMES;
  P.cleanText = cleanText;
})(typeof globalThis !== 'undefined' ? globalThis : this);
