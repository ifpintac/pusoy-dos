/* Pusoy Dos — rules engine.
 * Shared by the browser (solo play, hints) and the game server (the referee).
 * Plain script: attaches to globalThis.Pusoy so it loads from a <script> tag,
 * from Node tests, and from the Cloudflare Worker alike.
 *
 * Cards are integers 0..51:  id = rank * 4 + suit
 *   rank 0..12  ->  3 4 5 6 7 8 9 10 J Q K A 2   (3 is lowest, 2 is highest)
 *   suit 0..3   ->  clubs < spades < hearts < diamonds   (Philippine order)
 * So a higher id is simply a higher single card: 0 is the 3 of clubs, 51 is the 2 of diamonds.
 */
(function (root) {
  'use strict';
  var P = (root.Pusoy = root.Pusoy || {});

  var RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
  // U+FE0E keeps the suit glyphs as text (not emoji) on phones.
  var SUITS = ['♣︎', '♠︎', '♥︎', '♦︎'];
  var SUIT_NAMES = ['clubs', 'spades', 'hearts', 'diamonds'];
  var RANK_NAMES = ['3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace', '2'];
  var RANK_PLURAL = ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', 'Jacks', 'Queens', 'Kings', 'Aces', '2s'];
  var THREE_OF_CLUBS = 0;

  // Five-card hands, weakest to strongest.
  var TIER = { straight: 1, flush: 2, fullhouse: 3, quads: 4, straightflush: 5 };
  var TYPE_LABEL = {
    single: 'Single', pair: 'Pair', triple: 'Three of a kind',
    straight: 'Straight', flush: 'Flush', fullhouse: 'Full house',
    quads: 'Four of a kind', straightflush: 'Straight flush'
  };

  function rankOf(id) { return id >> 2; }
  function suitOf(id) { return id & 3; }
  function cardLabel(id) { return RANKS[id >> 2] + SUITS[id & 3]; }
  function cardName(id) { return RANK_NAMES[id >> 2] + ' of ' + SUIT_NAMES[id & 3]; }
  function byId(a, b) { return a - b; }

  function isCard(id) { return typeof id === 'number' && id >= 0 && id <= 51 && Math.floor(id) === id; }

  /* Work out what a set of cards is. Returns null if it is not a playable hand.
   * `power` only compares hands of the same size. */
  function evaluate(ids) {
    if (!ids || !ids.length) return null;
    var c = ids.slice().sort(byId);
    var n = c.length, i;
    for (i = 0; i < n; i++) { if (!isCard(c[i]) || (i && c[i] === c[i - 1])) return null; }
    var top = c[n - 1];

    if (n === 1) return mk('single', c, top, cardLabel(top));

    if (n === 2) {
      if (rankOf(c[0]) !== rankOf(c[1])) return null;
      return mk('pair', c, top, 'pair of ' + RANK_PLURAL[rankOf(top)]);
    }

    if (n === 3) {
      if (rankOf(c[0]) !== rankOf(c[2])) return null;
      return mk('triple', c, rankOf(top), 'three ' + RANK_PLURAL[rankOf(top)]);
    }

    if (n !== 5) return null;

    var flush = true, straight = true;
    for (i = 1; i < 5; i++) {
      if (suitOf(c[i]) !== suitOf(c[0])) flush = false;
      // Straights run in Pusoy order with no wrap-around:
      // 3-4-5-6-7 is the lowest, J-Q-K-A-2 is the highest.
      if (rankOf(c[i]) !== rankOf(c[i - 1]) + 1) straight = false;
    }
    var counts = {}, r;
    for (i = 0; i < 5; i++) { r = rankOf(c[i]); counts[r] = (counts[r] || 0) + 1; }
    var quadRank = -1, tripRank = -1, pairRank = -1;
    for (r in counts) {
      if (counts[r] === 4) quadRank = +r;
      else if (counts[r] === 3) tripRank = +r;
      else if (counts[r] === 2) pairRank = +r;
    }

    if (straight && flush) return mk5('straightflush', c, top, 'straight flush to ' + cardLabel(top));
    if (quadRank >= 0) return mk5('quads', c, quadRank, 'four ' + RANK_PLURAL[quadRank]);
    if (tripRank >= 0 && pairRank >= 0) {
      return mk5('fullhouse', c, tripRank, 'full house, ' + RANK_PLURAL[tripRank] + ' over ' + RANK_PLURAL[pairRank]);
    }
    // Flushes and straights are ranked by their highest card, then by that card's suit.
    if (flush) return mk5('flush', c, top, cardLabel(top) + '-high flush');
    if (straight) return mk5('straight', c, top, 'straight to ' + cardLabel(top));
    return null;
  }

  function mk(type, cards, power, name) {
    return { type: type, size: cards.length, cards: cards, power: power, name: name, label: TYPE_LABEL[type] };
  }
  function mk5(type, cards, key, name) {
    var h = mk(type, cards, TIER[type] * 100 + key, name);
    h.tier = TIER[type];
    return h;
  }

  /* Does hand `a` beat hand `b`? Sizes must match; any stronger kind of
   * five-card hand beats any weaker kind. */
  function beats(a, b) {
    return !!a && !!b && a.size === b.size && a.power > b.power;
  }

  /* Check a proposed play. `table` is the hand to beat (or null when leading).
   * Returns { ok, combo, reason }. */
  function check(ids, table, mustOpen) {
    var combo = evaluate(ids);
    if (!combo) {
      var n = ids ? ids.length : 0;
      if (n === 4 || n > 5) return bad('Play 1, 2, 3 or 5 cards.');
      if (n === 2) return bad('Those two don’t make a pair.');
      if (n === 3) return bad('Three of a kind needs three of the same rank.');
      if (n === 5) return bad('Those five don’t make a hand.');
      return bad('Pick cards to play.');
    }
    if (mustOpen && combo.cards.indexOf(THREE_OF_CLUBS) < 0) {
      return bad('The opening play must include the 3' + SUITS[0] + '.', combo);
    }
    if (table) {
      if (combo.size !== table.size) {
        var need = table.size === 1 ? 'a single card' : table.size === 2 ? 'a pair' : table.size === 3 ? 'three of a kind' : 'a five-card hand';
        return bad('You need ' + need + ' here.', combo);
      }
      if (combo.power <= table.power) return bad('That doesn’t beat the ' + table.name + '.', combo);
    }
    return { ok: true, combo: combo, reason: '' };
  }
  function bad(reason, combo) { return { ok: false, combo: combo || null, reason: reason }; }

  /* ---------- generating plays (for hints and for the bots) ---------- */

  function combos(arr, k) {
    var out = [];
    (function rec(start, pick) {
      if (pick.length === k) { out.push(pick.slice()); return; }
      for (var i = start; i <= arr.length - (k - pick.length); i++) {
        pick.push(arr[i]); rec(i + 1, pick); pick.pop();
      }
    })(0, []);
    return out;
  }

  function groupByRank(hand) {
    var g = []; for (var r = 0; r < 13; r++) g.push([]);
    for (var i = 0; i < hand.length; i++) g[rankOf(hand[i])].push(hand[i]);
    return g;
  }

  /* Every playable hand of `size` cards that can be made from `hand`. */
  function generate(hand, size) {
    var out = [], g = groupByRank(hand), r, i, j;
    if (size === 1) {
      for (i = 0; i < hand.length; i++) out.push(evaluate([hand[i]]));
    } else if (size === 2 || size === 3) {
      for (r = 0; r < 13; r++) {
        if (g[r].length >= size) combos(g[r], size).forEach(function (c) { out.push(evaluate(c)); });
      }
    } else if (size === 5 && hand.length >= 5) {
      var seen = {};
      var push = function (c) {
        var h = evaluate(c); if (!h) return;
        var k = h.cards.join(','); if (seen[k]) return;
        seen[k] = 1; out.push(h);
      };
      // straights and straight flushes
      for (r = 0; r <= 8; r++) {
        if (g[r].length && g[r + 1].length && g[r + 2].length && g[r + 3].length && g[r + 4].length) {
          g[r].forEach(function (a) { g[r + 1].forEach(function (b) { g[r + 2].forEach(function (c) {
            g[r + 3].forEach(function (d) { g[r + 4].forEach(function (e) { push([a, b, c, d, e]); }); });
          }); }); });
        }
      }
      // flushes
      for (var s = 0; s < 4; s++) {
        var same = hand.filter(function (id) { return suitOf(id) === s; });
        if (same.length >= 5) combos(same, 5).forEach(push);
      }
      // full houses and four of a kind
      for (r = 0; r < 13; r++) {
        if (g[r].length >= 3) {
          var trips = combos(g[r], 3);
          for (j = 0; j < 13; j++) {
            if (j !== r && g[j].length >= 2) {
              combos(g[j], 2).forEach(function (pr) { trips.forEach(function (t) { push(t.concat(pr)); }); });
            }
          }
        }
        if (g[r].length === 4) {
          for (i = 0; i < hand.length; i++) if (rankOf(hand[i]) !== r) push(g[r].concat([hand[i]]));
        }
      }
    }
    return out;
  }

  /* Every legal play from `hand` right now, weakest first. */
  function legalPlays(hand, table, mustOpen) {
    var sizes = table ? [table.size] : [1, 2, 3, 5], out = [];
    sizes.forEach(function (n) {
      generate(hand, n).forEach(function (h) {
        if (table && h.power <= table.power) return;
        if (mustOpen && h.cards.indexOf(THREE_OF_CLUBS) < 0) return;
        out.push(h);
      });
    });
    out.sort(function (a, b) { return a.size - b.size || a.power - b.power; });
    return out;
  }

  /* ---------- dealing ---------- */

  function randInt(n) {
    var c = root.crypto;
    if (c && c.getRandomValues) {
      var buf = new Uint32Array(1), limit = Math.floor(4294967296 / n) * n;
      do { c.getRandomValues(buf); } while (buf[0] >= limit);
      return buf[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  function shuffledDeck(rand) {
    rand = rand || randInt;
    var d = [], i, j, t;
    for (i = 0; i < 52; i++) d.push(i);
    for (i = 51; i > 0; i--) { j = rand(i + 1); t = d[i]; d[i] = d[j]; d[j] = t; }
    return d;
  }

  /* Four sorted hands of 13. Redeals if anyone is dealt all four 2s. */
  function deal(rand) {
    for (var tries = 0; tries < 20; tries++) {
      var d = shuffledDeck(rand), hands = [], ok = true;
      for (var p = 0; p < 4; p++) {
        var h = d.slice(p * 13, p * 13 + 13).sort(byId);
        if (h[9] >= 48) ok = false; // four 2s occupy the top four slots
        hands.push(h);
      }
      if (ok) return hands;
    }
    return hands;
  }

  function sortHand(ids, mode) {
    var c = ids.slice();
    if (mode === 'suit') c.sort(function (a, b) { return (a & 3) - (b & 3) || a - b; });
    else c.sort(byId);
    return c;
  }

  P.Engine = {
    RANKS: RANKS, SUITS: SUITS, SUIT_NAMES: SUIT_NAMES, RANK_PLURAL: RANK_PLURAL,
    TIER: TIER, TYPE_LABEL: TYPE_LABEL, THREE_OF_CLUBS: THREE_OF_CLUBS,
    rankOf: rankOf, suitOf: suitOf, cardLabel: cardLabel, cardName: cardName,
    evaluate: evaluate, beats: beats, check: check,
    generate: generate, legalPlays: legalPlays, groupByRank: groupByRank,
    deal: deal, shuffledDeck: shuffledDeck, randInt: randInt, sortHand: sortHand
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
