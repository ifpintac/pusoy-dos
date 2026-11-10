/* Pusoy Dos — computer players, in three strengths.
 *
 * normal  Splits its hand into the groups it intends to play (its "plan"), then
 *         leads or follows in a way that keeps that plan intact: it sheds weak
 *         cards early, saves 2s and big hands to win the lead back, and stops
 *         holding back once somebody is close to going out.
 * hard    Plays like normal and also counts cards. It knows exactly which of its
 *         groups nobody can beat any more, and takes a guaranteed way out as soon
 *         as one exists. Given a few milliseconds to think (`view.think`), it also
 *         looks ahead: it deals the unseen cards out at random a number of times,
 *         plays each of its options through to the end of the round, and keeps the
 *         one that scores best. It never looks at anybody's actual hand.
 * easy    Plays like a beginner: dumps its lowest cards, breaks up its own hands,
 *         burns 2s early and never notices when somebody is about to go out.
 */
(function (root) {
  'use strict';
  var P = (root.Pusoy = root.Pusoy || {});
  var E = P.Engine;
  var rankOf = E.rankOf, suitOf = E.suitOf;

  function without(hand, cards) {
    return hand.filter(function (id) { return cards.indexOf(id) < 0; });
  }

  /* ---- pulling five-card hands out of a pool of cards ---- */

  function findStraight(pool, flushOnly) {
    var g = E.groupByRank(pool);
    for (var r = 0; r <= 8; r++) {
      if (!(g[r].length && g[r + 1].length && g[r + 2].length && g[r + 3].length && g[r + 4].length)) continue;
      if (flushOnly) {
        for (var s = 0; s < 4; s++) {
          var sf = [];
          for (var k = 0; k < 5; k++) {
            var hit = g[r + k].filter(function (id) { return suitOf(id) === s; })[0];
            if (hit === undefined) break;
            sf.push(hit);
          }
          if (sf.length === 5) return sf;
        }
        continue;
      }
      var out = [];
      for (var j = 0; j < 5; j++) out.push(g[r + j][0]); // lowest suit of each rank
      return out;
    }
    return null;
  }

  function findFlush(pool) {
    for (var s = 0; s < 4; s++) {
      var same = pool.filter(function (id) { return suitOf(id) === s; });
      if (same.length >= 5) return same.slice(0, 5); // the five lowest, keep the big ones
    }
    return null;
  }

  /* Split `hand` into groups following a recipe (`order`). */
  function decompose(hand, order) {
    var pool = hand.slice().sort(function (a, b) { return a - b; });
    var fives = [], trips = [], quads = [], g, r, hit;
    var take = function (cards) { pool = without(pool, cards); };

    order.forEach(function (step) {
      if (step === 'sf') {
        while ((hit = findStraight(pool, true))) { fives.push(hit); take(hit); }
      } else if (step === 'straight') {
        while ((hit = findStraight(pool, false))) { fives.push(hit); take(hit); }
      } else if (step === 'flush') {
        while ((hit = findFlush(pool))) { fives.push(hit); take(hit); }
      } else if (step === 'quads') {
        g = E.groupByRank(pool);
        for (r = 0; r < 13; r++) if (g[r].length === 4) { quads.push(g[r]); take(g[r]); }
      } else if (step === 'trips') {
        g = E.groupByRank(pool);
        for (r = 0; r < 13; r++) if (g[r].length === 3) { trips.push(g[r]); take(g[r]); }
      }
    });

    var pairs = [], singles = [];
    g = E.groupByRank(pool);
    for (r = 0; r < 13; r++) {
      if (g[r].length === 4) { pairs.push(g[r].slice(0, 2)); pairs.push(g[r].slice(2)); }
      else if (g[r].length === 3) trips.push(g[r]);
      else if (g[r].length === 2) pairs.push(g[r]);
      else if (g[r].length === 1) singles.push(g[r]);
    }

    // four of a kind needs a kicker: use the weakest single, or split into two pairs
    quads.forEach(function (q) {
      if (singles.length && rankOf(singles[0][0]) < 11) fives.push(q.concat(singles.shift()));
      else { pairs.push(q.slice(0, 2)); pairs.push(q.slice(2)); }
    });
    // full houses: marry the lowest triple to the lowest pair (but never burn aces or 2s as the pair)
    if (order.indexOf('fh') >= 0) {
      trips.sort(function (a, b) { return a[0] - b[0]; });
      pairs.sort(function (a, b) { return a[0] - b[0]; });
      while (trips.length && pairs.length && rankOf(pairs[0][0]) < 11) {
        fives.push(trips.shift().concat(pairs.shift()));
      }
    }
    var groups = [];
    fives.concat(trips, pairs, singles).forEach(function (c) { groups.push(E.evaluate(c)); });
    return groups;
  }

  var RECIPES = [
    ['sf', 'quads', 'flush', 'straight', 'fh'],
    ['sf', 'quads', 'straight', 'flush', 'fh'],
    ['sf', 'quads', 'trips', 'straight', 'flush', 'fh'],
    ['sf', 'quads', 'fh'],
    ['quads'],
    []
  ];

  /* How bad is this split? Roughly "turns needed to go out", nudged up for
   * weak cards that are hard to get rid of and down for cards that win tricks. */
  function cost(groups, k) {
    var total = 0;
    for (var i = 0; i < groups.length; i++) {
      var h = groups[i], c = 1;
      if (k && unbeatable(h, k)) c -= h.size === 5 ? 0.6 : SURE[h.size];   // a card counter knows this one wins
      else if (h.size === 5) c -= [0, 0.05, 0.1, 0.25, 0.5, 0.6][h.tier];
      else {
        var r = rankOf(h.cards[0]);
        var weak = Math.max(0, (10 - r) / 10);
        if (h.size === 1) c += 0.35 * weak - (r === 12 ? 0.55 : r === 11 ? 0.15 : 0);
        else if (h.size === 2) c += 0.15 * weak - (r >= 11 ? 0.4 : 0);
        else c += 0.05 * weak - (r >= 11 ? 0.3 : 0);
      }
      total += c;
    }
    return total;
  }

  function plan(hand, k) {
    var best = null;
    for (var i = 0; i < RECIPES.length; i++) {
      var groups = decompose(hand, RECIPES[i]);
      var c = cost(groups, k);
      if (!best || c < best.cost - 1e-9) best = { groups: groups, cost: c };
    }
    return best;
  }

  /* ---- card counting (hard bots) ---- */

  var SURE = [0, 0.6, 0.5, 0.4];

  /* What a card counter knows: every card that is still out there, pooled. */
  function knowledge(view) {
    var gone = {}, pool = [], id, i, maxOpp = 0;
    (view.seen || []).forEach(function (c) { gone[c] = 1; });
    view.hand.forEach(function (c) { gone[c] = 1; });
    for (id = 0; id < 52; id++) if (!gone[id]) pool.push(id);
    for (i = 0; i < 4; i++) if (i !== view.seat && view.counts[i] > maxOpp) maxOpp = view.counts[i];
    var g = E.groupByRank(pool), suits = [[], [], [], []];
    pool.forEach(function (c) { suits[suitOf(c)].push(c); });
    return { pool: pool, g: g, suits: suits, maxOpp: maxOpp, top: pool.length ? pool[pool.length - 1] : -1, memo: {} };
  }

  /* True when no opponent can possibly beat `h`, whoever holds what.
   * It pools every unseen card, so a "yes" is a guarantee. */
  function unbeatable(h, k) {
    var key = h.size + ':' + h.power;
    if (k.memo[key] === undefined) k.memo[key] = !beatable(h, k);
    return k.memo[key];
  }
  function beatable(h, k) {
    var g = k.g, r, s, i;
    if (k.maxOpp < h.size) return false;
    if (h.size === 1) return k.top > h.power;
    if (h.size === 2) {
      for (r = rankOf(h.power); r < 13; r++) if (g[r].length >= 2 && g[r][g[r].length - 1] > h.power) return true;
      return false;
    }
    if (h.size === 3) {
      for (r = h.power + 1; r < 13; r++) if (g[r].length >= 3) return true;
      return false;
    }
    var tier = h.tier, keyOf = h.power - tier * 100;
    // straight flush
    for (s = 0; s < 4; s++) {
      var has = {}; k.suits[s].forEach(function (c) { has[rankOf(c)] = 1; });
      for (r = 0; r <= 8; r++) {
        if (has[r] && has[r + 1] && has[r + 2] && has[r + 3] && has[r + 4] && (tier < 5 || (r + 4) * 4 + s > keyOf)) return true;
      }
    }
    if (tier === 5) return false;
    // four of a kind
    for (r = 0; r < 13; r++) if (g[r].length === 4 && (tier < 4 || r > keyOf)) return true;
    if (tier === 4) return false;
    // full house
    var pairRanks = 0;
    for (r = 0; r < 13; r++) if (g[r].length >= 2) pairRanks++;
    for (r = 0; r < 13; r++) if (g[r].length >= 3 && pairRanks >= 2 && (tier < 3 || r > keyOf)) return true;
    if (tier === 3) return false;
    // flush
    for (s = 0; s < 4; s++) {
      var same = k.suits[s];
      if (same.length >= 5 && (tier < 2 || same[same.length - 1] > keyOf)) return true;
    }
    if (tier === 2) return false;
    // straight
    for (r = 0; r <= 8; r++) {
      if (g[r].length && g[r + 1].length && g[r + 2].length && g[r + 3].length && g[r + 4].length) {
        var hi = g[r + 4];
        if (hi[hi.length - 1] > keyOf) return true;
      }
    }
    return false;
  }

  /* A way to go out that nobody can stop: every group but (at most) one is
   * unbeatable. Returns the groups, sure winners first, or null. */
  function sureWin(hand, k) {
    for (var i = 0; i < RECIPES.length; i++) {
      var groups = decompose(hand, RECIPES[i]), sure = [], loose = [];
      groups.forEach(function (h) { (unbeatable(h, k) ? sure : loose).push(h); });
      if (loose.length <= 1) return sure.concat(loose);
    }
    return null;
  }

  /* A group that will very likely win the trick it is played in. */
  function isControl(h) {
    if (h.size === 5) return h.tier >= 4;
    var r = rankOf(h.cards[h.cards.length - 1]);
    if (h.size === 1) return h.cards[0] >= 50;      // 2 of hearts / diamonds
    return r >= 12 || (h.size === 3 && r >= 10);
  }

  function lowestBy(list, fn) {
    var best = null, bv = Infinity;
    list.forEach(function (x) { var v = fn(x); if (v < bv) { bv = v; best = x; } });
    return best;
  }

  /* view: { hand, table, counts[4], seat, passed[4], mustOpen, seen[], level }
   * `seen` is every card played so far this round (only hard bots use it).
   * Returns an array of card ids to play, or null to pass. */
  function choose(view) {
    var hand = view.hand, seat = view.seat, counts = view.counts;
    if (!hand || !hand.length) return null;
    var level = LEVELS.indexOf(view.level) >= 0 ? view.level : 'normal';
    if (level === 'easy') return easy(view);
    if (level === 'hard') {
      var k = knowledge(view), first = basic(view, k);
      return view.think > 0 ? lookAhead(view, k, first) : first;
    }
    return basic(view, null);
  }

  /* The planner. `k` is what a card counter knows, or null for a normal bot. */
  function basic(view, k) {
    var hand = view.hand, seat = view.seat, counts = view.counts;
    var others = [], i;
    for (i = 1; i < 4; i++) {
      var s = (seat + i) % 4;
      if (counts[s] > 0) others.push({ seat: s, n: counts[s], passed: !!(view.passed && view.passed[s]) });
    }
    var minOpp = 13, next = null;
    others.forEach(function (o) { if (o.n < minOpp) minOpp = o.n; if (!next && !o.passed) next = o; });
    var nextN = next ? next.n : 13;
    var myPlan = plan(hand, k);
    return view.table ? follow(view, myPlan, minOpp, nextN, k) : lead(view, myPlan, minOpp, nextN, k);
  }

  /* ---- looking ahead (hard bots with time to think) ---- */

  function penalty(n) { return n * (n >= 13 ? 3 : n >= 10 ? 2 : 1); }
  function clock() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }

  /* Whose turn after `turn`; clears the table when the trick is over. */
  function step(st) {
    var n = st.turn;
    for (var i = 0; i < 4; i++) { n = (n + 1) % 4; if (n === st.table.by || !st.passed[n]) break; }
    if (n === st.table.by) { st.table = null; st.passed = [false, false, false, false]; }
    st.turn = n;
  }
  /* Put `cards` (or a pass) down for whoever's turn it is. Returns true if they went out. */
  function apply(st, cards) {
    var t = st.turn;
    if (cards) {
      st.hands[t] = without(st.hands[t], cards);
      st.table = E.evaluate(cards); st.table.by = t;
      if (!st.passLock) st.passed = [false, false, false, false];
      if (!st.hands[t].length) return true;
    } else st.passed[t] = true;
    step(st);
    return false;
  }
  /* Everybody plays a normal game from here; returns the round score for `hero`. */
  function playOut(st, hero) {
    var done = false;
    for (var guard = 0; guard < 300 && !done; guard++) {
      var t = st.turn, hand = st.hands[t];
      var cards = basic({ hand: hand, table: st.table, seat: t, passed: st.passed, mustOpen: false,
        counts: [st.hands[0].length, st.hands[1].length, st.hands[2].length, st.hands[3].length] }, null);
      if (!cards && !st.table) cards = [hand[0]];
      done = apply(st, cards);
    }
    var pot = 0, won = false;
    for (var i = 0; i < 4; i++) { if (!st.hands[i].length) won = i === hero; pot += penalty(st.hands[i].length); }
    return won ? pot : -penalty(st.hands[hero].length);
  }

  /* The handful of options worth playing out. `first` is what the planner would do. */
  function options(view, k, first) {
    var hand = view.hand, out = [], seen = {};
    var add = function (cards) {
      var key = cards ? cards.slice().sort(function (a, b) { return a - b; }).join(',') : 'pass';
      if (!seen[key] && out.length < 7) { seen[key] = 1; out.push(cards); }
    };
    add(first);
    if (view.table) {
      add(null);
      E.legalPlays(hand, view.table, false).slice(0, 5).forEach(function (h) { add(h.cards); });
    } else if (view.mustOpen) {
      E.legalPlays(hand, null, true).slice(0, 6).forEach(function (h) { add(h.cards); });
    } else {
      plan(hand, k).groups.slice().sort(function (a, b) { return a.cards[0] - b.cards[0]; }).forEach(function (h) { add(h.cards); });
    }
    return out.filter(function (c) { return c || view.table; });
  }

  function lookAhead(view, k, first) {
    var hand = view.hand, seat = view.seat, counts = view.counts, i, w;
    var opts = options(view, k, first);
    if (opts.length < 2 || (first && first.length === hand.length)) return first;
    if (!view.table && !view.mustOpen && sureWin(hand, k)) return first;     // already counted out
    var pool = k.pool.slice(), total = opts.map(function () { return 0; });
    var budget = Math.min(200, view.think), t0 = clock(), worlds = 0;
    var passLock = view.passLock !== false;
    for (w = 0; w < 24; w++) {
      var spent = clock() - t0;
      if (w >= 2 && spent >= budget) break;
      if (w >= 4 && spent <= 0) break;               // no working clock here (some servers freeze it): stay cheap
      for (i = pool.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
      var hands = [], at = 0;
      for (i = 0; i < 4; i++) {
        if (i === seat) hands.push(hand);
        else { hands.push(pool.slice(at, at + counts[i]).sort(function (a, b) { return a - b; })); at += counts[i]; }
      }
      for (i = 0; i < opts.length; i++) {
        var st = { hands: hands.slice(), table: view.table, passed: (view.passed || [false, false, false, false]).slice(), turn: seat, passLock: passLock };
        if (apply(st, opts[i])) { var pot = 0; for (var s = 0; s < 4; s++) pot += penalty(st.hands[s].length); total[i] += pot; }
        else total[i] += playOut(st, seat);
      }
      worlds++;
    }
    // Trust the planner unless something else is clearly better: few deals means a noisy answer.
    var best = 0, margin = (worlds < 4 ? 1.5 : worlds < 8 ? 0.75 : 0.25) * worlds;
    for (i = 1; i < opts.length; i++) if (total[i] > total[best]) best = i;
    return best && total[best] - total[0] > margin ? opts[best] : opts[0];
  }

  /* ---- the beginner ---- */

  function easy(view) {
    var hand = view.hand, table = view.table;
    if (table) {
      var legal = E.legalPlays(hand, table, false);
      if (!legal.length) return null;
      if (legal[0].cards.length === hand.length) return legal[0].cards;
      // loses its nerve now and then, more often when it would cost a big card
      var big = rankOf(legal[0].cards[legal[0].cards.length - 1]) >= 10;
      if (hand.length > 3 && Math.random() < (big ? 0.3 : 0.12)) return null;
      return legal[0].cards;                       // otherwise the cheapest thing that beats the table
    }
    // On the lead: get rid of the lowest card, with whatever obviously goes with it.
    var fives = Math.random() < 0.5;                // only spots a five-card hand half the time
    var groups = decompose(hand, fives ? RECIPES[1] : []);
    if (view.mustOpen) {
      var open = groups.filter(function (h) { return h.cards.indexOf(E.THREE_OF_CLUBS) >= 0; })[0];
      return open ? open.cards : [E.THREE_OF_CLUBS];
    }
    return lowestBy(groups, function (h) { return h.cards[0]; }).cards;
  }

  function lead(view, myPlan, minOpp, nextN, k) {
    var groups = myPlan.groups;
    if (view.mustOpen) {
      var open = groups.filter(function (h) { return h.cards.indexOf(E.THREE_OF_CLUBS) >= 0; })[0];
      return open ? open.cards : [E.THREE_OF_CLUBS];
    }
    if (groups.length === 1) return groups[0].cards;
    if (k) {                                        // counted out: nobody can stop this
      var way = sureWin(view.hand, k);
      if (way) return way[0].cards;
    }
    var ctl = k ? function (h) { return unbeatable(h, k) || isControl(h); } : isControl;

    var controls = groups.filter(ctl);
    var rest = groups.filter(function (h) { return !ctl(h); });
    // One loose group left: cash the sure winners first, then walk out.
    if (rest.length <= 1 && controls.length) {
      controls.sort(function (a, b) { return b.size - a.size || b.power - a.power; });
      return controls[0].cards;
    }

    var pool = rest.length ? rest : groups;
    var fives = pool.filter(function (h) { return h.size === 5; });
    var small = pool.filter(function (h) { return h.size < 5; });
    var singles = small.filter(function (h) { return h.size === 1; });
    var multi = small.filter(function (h) { return h.size > 1; });

    // Someone is on their last card: never feed them a low single.
    if (minOpp === 1) {
      if (fives.length) return lowestBy(fives, function (h) { return h.power; }).cards;
      if (multi.length) return lowestBy(multi, function (h) { return h.cards[0]; }).cards;
      var all1 = groups.filter(function (h) { return h.size === 1; });
      return lowestBy(all1, function (h) { return -h.power; }).cards;
    }
    if (fives.length) return lowestBy(fives, function (h) { return h.power; }).cards;
    // Otherwise open with the lowest thing we hold; bigger groups win ties.
    if (minOpp === 2 && singles.length) small = singles.concat(multi.filter(function (h) { return h.size === 3; })) ;
    return lowestBy(small, function (h) { return rankOf(h.cards[0]) * 10 - h.size; }).cards;
  }

  function follow(view, myPlan, minOpp, nextN, k) {
    var hand = view.hand, table = view.table;
    var legal = E.legalPlays(hand, table, false);
    if (!legal.length) return null;

    var base = myPlan.cost;
    var threat = minOpp <= 2;
    var lo = legal[0].power, span = Math.max(1, legal[legal.length - 1].power - lo);
    var tableRank = table.size === 5 ? 0 : rankOf(table.cards[table.cards.length - 1]);
    var best = null, bestCost = Infinity;

    for (var i = 0; i < legal.length; i++) {
      var h = legal[i];
      var restHand = without(hand, h.cards);
      if (!restHand.length) return h.cards; // going out
      // counted out: this takes the trick for certain and the rest walks out
      if (k && unbeatable(h, k) && sureWin(restHand, k)) return h.cards;
      var c = plan(restHand, k).cost - base;
      var twos = 0;
      h.cards.forEach(function (id) { if (rankOf(id) === 12) twos++; });
      // don't spend 2s on small stuff while the game is young
      if (twos && !threat && hand.length > 6 && tableRank < 9) c += 0.6 * twos;
      c += 0.1 * (h.power - lo) / span;
      // the next player is on one card: block with the biggest single we have
      if (table.size === 1 && nextN === 1) c = -10 - h.power / 100;
      if (c < bestCost) { bestCost = c; best = h; }
    }

    var passCost = -0.5;
    if (hand.length <= 5 || myPlan.groups.length <= 3) passCost = -0.2;
    if (threat) passCost = 0.6;
    if (minOpp === 1) passCost = 2;
    return bestCost < passCost ? best.cards : null;
  }

  var LEVELS = ['easy', 'normal', 'hard'];

  P.Bot = { choose: choose, plan: plan, LEVELS: LEVELS, knowledge: knowledge, unbeatable: unbeatable };
})(typeof globalThis !== 'undefined' ? globalThis : this);
