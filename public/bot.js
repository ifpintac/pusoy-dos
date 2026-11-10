/* Pusoy Dos — computer players.
 * A bot first splits its hand into the groups it intends to play (its "plan"),
 * then leads or follows in a way that keeps that plan intact: it sheds weak
 * cards early, saves 2s and big hands to win the lead back, and stops holding
 * back once somebody is close to going out.
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
  function cost(groups) {
    var total = 0;
    for (var i = 0; i < groups.length; i++) {
      var h = groups[i], c = 1;
      if (h.size === 5) c -= [0, 0.05, 0.1, 0.25, 0.5, 0.6][h.tier];
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

  function plan(hand) {
    var best = null;
    for (var i = 0; i < RECIPES.length; i++) {
      var groups = decompose(hand, RECIPES[i]);
      var c = cost(groups);
      if (!best || c < best.cost - 1e-9) best = { groups: groups, cost: c };
    }
    return best;
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

  /* view: { hand, table, counts[4], seat, passed[4], mustOpen }
   * Returns an array of card ids to play, or null to pass. */
  function choose(view) {
    var hand = view.hand, seat = view.seat, counts = view.counts;
    if (!hand || !hand.length) return null;
    var others = [], i;
    for (i = 1; i < 4; i++) {
      var s = (seat + i) % 4;
      if (counts[s] > 0) others.push({ seat: s, n: counts[s], passed: !!(view.passed && view.passed[s]) });
    }
    var minOpp = 13, next = null;
    others.forEach(function (o) { if (o.n < minOpp) minOpp = o.n; if (!next && !o.passed) next = o; });
    var nextN = next ? next.n : 13;
    var myPlan = plan(hand);
    return view.table ? follow(view, myPlan, minOpp, nextN) : lead(view, myPlan, minOpp, nextN);
  }

  function lead(view, myPlan, minOpp, nextN) {
    var groups = myPlan.groups;
    if (view.mustOpen) {
      var open = groups.filter(function (h) { return h.cards.indexOf(E.THREE_OF_CLUBS) >= 0; })[0];
      return open ? open.cards : [E.THREE_OF_CLUBS];
    }
    if (groups.length === 1) return groups[0].cards;

    var controls = groups.filter(isControl);
    var rest = groups.filter(function (h) { return !isControl(h); });
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

  function follow(view, myPlan, minOpp, nextN) {
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
      var c = plan(restHand).cost - base;
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

  P.Bot = { choose: choose, plan: plan };
})(typeof globalThis !== 'undefined' ? globalThis : this);
