// Rule checks for the Pusoy Dos engine.  Run: npm test
import assert from 'node:assert/strict';
import '../public/engine.js';
import '../public/bot.js';
import '../public/table.js';
import '../public/tutorial.js';
const { Engine: E, Bot, TableCore } = globalThis.Pusoy;

const R = { '3': 0, '4': 1, '5': 2, '6': 3, '7': 4, '8': 5, '9': 6, '10': 7, J: 8, Q: 9, K: 10, A: 11, '2': 12 };
const S = { c: 0, s: 1, h: 2, d: 3 };
// "9h" -> id, "10d", "2c" ...
const c = (t) => R[t.slice(0, -1)] * 4 + S[t.slice(-1)];
const h = (str) => str.split(' ').map(c);
const ev = (str) => E.evaluate(h(str));
let n = 0;
const t = (name, fn) => { fn(); n++; };

t('card order: 3 of clubs lowest, 2 of diamonds highest', () => {
  assert.equal(c('3c'), 0); assert.equal(c('2d'), 51);
  assert.ok(c('3d') < c('4c'));                 // rank first
  assert.ok(c('9c') < c('9s') && c('9s') < c('9h') && c('9h') < c('9d')); // clubs < spades < hearts < diamonds
  assert.ok(c('Ad') < c('2c'));                 // any 2 beats any ace
});

t('singles, pairs, triples', () => {
  assert.equal(ev('9h').type, 'single');
  assert.equal(ev('9h 9c').type, 'pair');
  assert.equal(ev('9h 10c'), null);
  assert.equal(ev('9h 9c 9d').type, 'triple');
  assert.equal(ev('9h 9c 8d'), null);
  assert.equal(ev('9h 9c 9d 9s'), null);          // four cards is never a play
  assert.equal(ev('9h 9h'), null);                // duplicates
  assert.ok(E.beats(ev('7s 7d'), ev('7c 7h')));   // pair with the diamond wins
  assert.ok(!E.beats(ev('7c 7h'), ev('7s 7d')));
  assert.ok(E.beats(ev('8c 8s'), ev('7h 7d')));
  assert.ok(!E.beats(ev('8c 8s'), ev('7h')));     // sizes must match
});

t('five-card hands are recognised', () => {
  assert.equal(ev('3c 4d 5h 6s 7c').type, 'straight');
  assert.equal(ev('3c 4c 5c 6c 7c').type, 'straightflush');
  assert.equal(ev('3c 9c 5c Jc 2c').type, 'flush');
  assert.equal(ev('9c 9d 9h 4s 4c').type, 'fullhouse');
  assert.equal(ev('9c 9d 9h 9s 4c').type, 'quads');
  assert.equal(ev('3c 4d 5h 6s 8c'), null);
  assert.equal(ev('9c 9d 4h 4s 5c'), null);       // two pair is not a hand
});

t('straights follow Pusoy order, no wrap-around', () => {
  assert.equal(ev('Jc Qd Kh As 2c').type, 'straight');   // highest straight
  assert.equal(ev('10c Jd Qh Ks Ac').type, 'straight');
  assert.equal(ev('Ac 2d 3h 4s 5c'), null);              // no wrapping past the 2
  assert.equal(ev('2d 3h 4s 5c 6c'), null);
  assert.equal(ev('Qc Kd Ah 2s 3c'), null);
  assert.ok(E.beats(ev('Jc Qd Kh As 2c'), ev('10c Jd Qh Ks Ad')));
  assert.ok(E.beats(ev('3d 4c 5c 6c 7d'), ev('3c 4d 5h 6s 7h')));  // same top rank: suit of the top card
});

t('five-card ranking: straight < flush < full house < quads < straight flush', () => {
  const st = ev('Jc Qd Kh As 2d'), fl = ev('3c 4c 5c 6c 8c'), fh = ev('3c 3d 3h 4s 4c'),
        q = ev('3c 3d 3h 3s 4c'), sf = ev('3h 4h 5h 6h 7h');
  assert.ok(E.beats(fl, st)); assert.ok(E.beats(fh, fl)); assert.ok(E.beats(q, fh)); assert.ok(E.beats(sf, q));
  assert.ok(!E.beats(st, fl)); assert.ok(!E.beats(q, sf));
  assert.ok(E.beats(ev('4c 4d 4h 3s 3c'), fh));                       // full house: by the triple
  assert.ok(E.beats(ev('3d 5d 6d 7d 9d'), ev('3c 4c 5c 6c 9c')));      // flush: top card, then suit
  assert.ok(E.beats(ev('3c 4c 5c 6c 10c'), ev('3d 5d 6d 7d 9d')));
});

t('check() explains refusals', () => {
  const table = ev('9h 9c');
  assert.equal(E.check(h('10c 10s'), table, false).ok, true);
  assert.equal(E.check(h('8c 8s'), table, false).ok, false);
  assert.equal(E.check(h('Ac'), table, false).ok, false);
  assert.equal(E.check(h('4c 4s'), null, true).ok, false);            // opening play needs the 3 of clubs
  assert.equal(E.check(h('3c 3s'), null, true).ok, true);
  assert.equal(E.check(h('3c 4d 5h 6s 7c'), null, true).ok, true);
});

t('legalPlays matches brute force on random hands', () => {
  const brute = (hand, table) => {
    const out = new Set();
    const rec = (i, pick) => {
      if (pick.length && [1, 2, 3, 5].includes(pick.length)) {
        const e = E.evaluate(pick);
        if (e && (!table || (e.size === table.size && e.power > table.power))) out.add(e.cards.join(','));
      }
      if (pick.length === 5) return;
      for (let j = i; j < hand.length; j++) rec(j + 1, pick.concat(hand[j]));
    };
    rec(0, []);
    return out;
  };
  for (let k = 0; k < 60; k++) {
    const hands = E.deal();
    const hand = hands[0];
    const tables = [null, E.evaluate([hands[1][3]]), E.generate(hands[1], 2)[0], E.generate(hands[1], 5)[0]];
    for (const table of tables) {
      if (table === undefined) continue;
      const fast = new Set(E.legalPlays(hand, table, false).map((x) => x.cards.join(',')));
      const slow = brute(hand, table);
      assert.equal(fast.size, slow.size);
      for (const key of slow) assert.ok(fast.has(key));
    }
  }
});

t('deal: 52 distinct cards, 13 each, nobody holds four 2s', () => {
  for (let k = 0; k < 500; k++) {
    const hands = E.deal();
    assert.equal(new Set(hands.flat()).size, 52);
    hands.forEach((x) => { assert.equal(x.length, 13); assert.ok(x.filter((id) => id >= 48).length < 4); });
  }
});

t('table: opening play, pass lock, trick clear, scoring', () => {
  const core = TableCore.create({ code: 'TEST', rounds: 2, turnSecs: 30 }, 0);
  ['a', 'b', 'c', 'd'].forEach((p) => assert.ok(core.join(p, { name: p }, 0).seat >= 0));
  assert.equal(core.join('e', { name: 'e' }, 0).error, 'full');
  ['a', 'b', 'c', 'd'].forEach((p) => core.act(p, { t: 'ready' }, 0));          // four players: the deal waits for all of them
  const s = core.s;
  const pid = (i) => s.seats[i].pid;
  // rig the deal so the test is deterministic
  s.hands = [h('3c 4c 5c 9d'), h('3s 6c 7c 8c Kd'), h('3h 6s 7s 8s Kh'), h('3d 6h 7h 8h Ks')];
  s.turn = 0; s.mustOpen = true;
  assert.ok(core.act(pid(1), { t: 'play', cards: h('3s') }, 1).error);            // not their turn
  assert.ok(core.act(pid(0), { t: 'play', cards: h('4c') }, 1).error);            // must include 3 of clubs
  assert.ok(core.act(pid(0), { t: 'pass' }, 1).error);                            // can't pass on the lead
  assert.ok(core.act(pid(0), { t: 'play', cards: h('3c 2d') }, 1).error);         // card not in hand
  assert.equal(core.act(pid(0), { t: 'play', cards: h('3c') }, 1).error, undefined);
  assert.equal(s.turn, 1);
  assert.ok(core.act(pid(1), { t: 'play', cards: h('6c 7c') }, 2).error);         // not a pair
  assert.equal(core.act(pid(1), { t: 'pass' }, 2).error, undefined);
  assert.equal(core.act(pid(2), { t: 'play', cards: h('3h') }, 3).error, undefined);
  assert.equal(core.act(pid(3), { t: 'play', cards: h('3d') }, 4).error, undefined);
  assert.equal(core.act(pid(0), { t: 'play', cards: h('9d') }, 5).error, undefined);
  assert.equal(s.turn, 2);                                                        // seat 1 passed: skipped
  assert.equal(core.act(pid(2), { t: 'play', cards: h('Kh') }, 6).error, undefined);
  assert.equal(core.act(pid(3), { t: 'pass' }, 7).error, undefined);
  assert.equal(core.act(pid(0), { t: 'pass' }, 8).error, undefined);
  assert.equal(s.table, null);                                                    // trick cleared
  assert.equal(s.turn, 2);                                                        // winner of the trick leads
  assert.deepEqual(s.passed, [false, false, false, false]);
  // seat 2 walks out
  assert.equal(core.act(pid(2), { t: 'play', cards: h('6s') }, 9).error, undefined);
  s.passed = [true, true, false, true]; s.turn = 2; s.table = null;
  s.hands[2] = h('7s 8s');
  assert.ok(core.act(pid(2), { t: 'play', cards: h('7s 8s') }, 10).error);        // not a pair
  s.hands[2] = h('7s');
  assert.equal(core.act(pid(2), { t: 'play', cards: h('7s') }, 10).error, undefined);
  assert.equal(s.phase, 'roundEnd');
  assert.equal(s.result.winner, 2);
  assert.deepEqual(s.result.left, [2, 5, 0, 4]);
  assert.deepEqual(s.result.delta, [-2, -5, 11, -4]);
  assert.equal(s.scores.reduce((a, b) => a + b, 0), 0);                           // zero-sum
  // round 2: the holder of the 3 of clubs opens again and must play it
  core.tick(10 + 60000);
  assert.equal(s.phase, 'playing'); assert.equal(s.round, 2);
  assert.equal(s.hands[s.turn][0], 0); assert.equal(s.mustOpen, true);
  const opener = s.turn, low = s.hands[opener].find((x) => x !== 0);
  assert.ok(core.act(pid(opener), { t: 'play', cards: [low] }, 70000).error);          // not without the 3 of clubs
  assert.equal(core.act(pid(opener), { t: 'play', cards: [0] }, 70000).error, undefined);
});

t('scoring multipliers: 10+ cards double, all 13 triple', () => {
  const core = TableCore.create({ rounds: 1 }, 0);
  core.join('a', {}, 0); core.act('a', { t: 'start' }, 0);
  const s = core.s;
  s.hands = [h('5c'), E.deal()[0], E.deal()[0].slice(0, 10), E.deal()[0].slice(0, 9)];
  s.turn = 0; s.mustOpen = false; s.table = null;
  core.act('a', { t: 'play', cards: h('5c') }, 1);
  assert.deepEqual(s.result.delta, [39 + 20 + 9, -39, -20, -9]);
  assert.equal(s.phase, 'matchEnd'); assert.equal(s.result.champ, 0);
  assert.equal(s.outbox.length, 1); assert.equal(s.outbox[0].won, true);
});

t('view hides other hands', () => {
  const core = TableCore.create({}, 0);
  core.join('a', {}, 0); core.act('a', { t: 'start' }, 0);
  const v = core.view(0, 0);
  assert.equal(v.hand.length, 13);
  assert.equal(JSON.stringify(v).includes('"hands"'), false);
  assert.deepEqual(v.seats.map((x) => x.n), [13, 13, 13, 13]);
});

t('bot levels: the table keeps a valid level and shows it', () => {
  assert.equal(TableCore.create({}, 0).s.opts.bots, 'normal');
  assert.equal(TableCore.create({ bots: 'insane' }, 0).s.opts.bots, 'normal');
  const core = TableCore.create({ bots: 'hard', pub: true }, 0);
  core.join('a', { name: 'a' }, 0);
  assert.equal(core.view(0, 0).bots, 'hard');
  assert.equal(core.summary().bots, 'hard');
});

t('hard bots count cards: "nobody can beat this" matches a full search of the unseen cards', () => {
  let agree = 0;
  for (let round = 0; round < 60; round++) {
    const deck = E.shuffledDeck();
    const hand = deck.slice(0, 13).sort((a, b) => a - b);
    const seen = deck.slice(13, 13 + (round * 7) % 30);
    const pool = deck.slice(13 + seen.length);
    const k = Bot.knowledge({ hand, seen, seat: 0, counts: [13, 13, 13, 13] });
    assert.deepEqual(k.pool, pool.slice().sort((a, b) => a - b));
    for (const g of E.legalPlays(hand, null, false)) {
      const can = E.legalPlays(pool, g, false).length > 0;
      assert.equal(Bot.unbeatable(g, k), !can, g.name);
      agree++;
    }
  }
  assert.ok(agree > 1000);
  // and nobody with fewer cards than the hand can answer it at all
  const k = Bot.knowledge({ hand: h('5c 5s'), seen: [], seat: 0, counts: [2, 1, 1, 1] });
  assert.ok(Bot.unbeatable(ev('5c 5s'), k));
});

t('hard bots cash a sure winner first; normal bots do not see it', () => {
  // Every card above the ace of hearts has been played, so it cannot lose.
  const view = { hand: h('5c 5s Ah'), table: null, seat: 0, mustOpen: false, counts: [3, 5, 5, 5],
    passed: [false, false, false, false], seen: h('Ad 2c 2s 2h 2d') };
  assert.deepEqual(Bot.choose({ ...view, level: 'hard' }), h('Ah'));
  assert.deepEqual(Bot.choose({ ...view, level: 'hard', think: 5 }), h('Ah'));
  assert.deepEqual(Bot.choose({ ...view, level: 'normal' }), h('5c 5s'));
  assert.deepEqual(Bot.choose({ ...view }), h('5c 5s'));                       // no level given = normal
});

t('easy bots are forgiving: lowest card first, cheapest answer, and they often let a trick go', () => {
  const lead = { hand: h('3s 9c 9d 2d'), table: null, seat: 0, mustOpen: false, counts: [4, 6, 6, 6], passed: [false, false, false, false], level: 'easy' };
  assert.deepEqual(Bot.choose(lead), h('3s'));
  // down to three cards it always plays, and it will happily burn the 2 of diamonds
  const last = { hand: h('4c 6s 2d'), table: { ...ev('Ks'), by: 1 }, seat: 0, mustOpen: false, counts: [3, 6, 6, 6], passed: [false, false, false, false], level: 'easy' };
  assert.deepEqual(Bot.choose(last), h('2d'));
  // with a fuller hand it passes a good share of the time although it could beat the table...
  const could = { hand: h('4c 6s 8d 9h Jc Qs Kd Ah'), table: { ...ev('5s'), by: 1 }, seat: 0, mustOpen: false, counts: [8, 6, 6, 6], passed: [false, false, false, false], level: 'easy' };
  let passes = 0, plays = new Set();
  for (let i = 0; i < 600; i++) { const c = Bot.choose(could); if (c) plays.add(c.join()); else passes++; }
  assert.ok(passes > 120 && passes < 300, 'passed ' + passes + ' of 600');
  assert.deepEqual([...plays], [String(c('6s'))]);                      // ...and when it plays, it is always the cheapest card that works
  // it leads a single off a pair more often than not, and a normal bot never passes up the pair here
  const pair = { hand: h('5c 5s 9d Kh 2c'), table: null, seat: 0, mustOpen: false, counts: [5, 6, 6, 6], passed: [false, false, false, false], level: 'easy' };
  let singles = 0;
  for (let i = 0; i < 400; i++) if (Bot.choose(pair).length === 1) singles++;
  assert.ok(singles > 180 && singles < 300, 'led a single ' + singles + ' of 400');
});

t('ready-up: alone you just deal; with company everyone readies, or a timer runs out', () => {
  const solo = TableCore.create({}, 0); solo.join('a', { name: 'a' }, 0);
  solo.act('a', { t: 'start' }, 0);
  assert.equal(solo.s.phase, 'playing');                                   // alone at the table: no vote needed

  const core = TableCore.create({ readyMs: 5000 }, 0);
  ['a', 'b', 'c'].forEach((p) => core.join(p, { name: p }, 0));
  core.act('a', { t: 'start' }, 10);                                         // "Deal" with company counts as "I'm ready"
  assert.equal(core.s.phase, 'waiting');
  assert.deepEqual(core.view(0, 10).seats.map((x) => x.ready), [true, false, false, true]);   // the bot is always ready
  assert.equal(core.view(0, 10).readyAt, 5010);
  core.act('b', { t: 'ready' }, 20);
  core.act('b', { t: 'ready', on: false }, 30);                              // changed their mind
  assert.equal(core.view(0, 30).seats[1].ready, false);
  core.act('b', { t: 'ready' }, 40); core.act('c', { t: 'ready' }, 50);
  assert.equal(core.s.phase, 'playing');                                     // everyone in: dealt at once
  assert.ok(core.s.seats.every((x) => !x.ready) && core.s.readyAt === 0);

  const slow = TableCore.create({ readyMs: 5000 }, 0);
  ['a', 'b'].forEach((p) => slow.join(p, { name: p }, 0));
  slow.act('a', { t: 'ready' }, 100);
  assert.equal(slow.nextWake(), 5100);
  slow.tick(5099); assert.equal(slow.s.phase, 'waiting');
  slow.tick(5100); assert.equal(slow.s.phase, 'playing');                    // the timer ran out: dealt without waiting for b
  const left = TableCore.create({ readyMs: 5000 }, 0);
  ['a', 'b'].forEach((p) => left.join(p, { name: p }, 0));
  left.act('a', { t: 'ready' }, 0); left.leave('b', 10);
  assert.equal(left.s.phase, 'playing');                                     // the one holding things up left
});

t('rematch: scores start over and a winning streak is counted', () => {
  const core = TableCore.create({ rounds: 1, readyMs: 5000, botMs: [1, 2], emotes: false }, 0);
  ['a', 'b'].forEach((p) => core.join(p, { name: p }, 0));
  const playOut = () => { let g = 0; while (core.s.phase === 'playing' && g++ < 600) core.autoMove(core.s.turn, true, 0); };
  core.act('a', { t: 'ready' }, 0); core.act('b', { t: 'ready' }, 0); playOut();
  assert.equal(core.s.phase, 'matchEnd');
  const champ = core.s.result.champ;
  assert.equal(core.view(0, 0).seats[champ].series, 1);
  core.act('a', { t: 'ready' }, 0);
  assert.equal(core.s.phase, 'matchEnd');                                    // one vote is not a rematch yet
  core.act('b', { t: 'ready' }, 0);
  assert.equal(core.s.phase, 'playing'); assert.deepEqual(core.s.scores, [0, 0, 0, 0]); assert.equal(core.s.round, 1);
  playOut();
  const again = core.s.result.champ;
  assert.equal(core.s.series[again], again === champ ? 2 : 1);
  assert.equal(core.s.series.filter((x) => x > 0).length, 1);                // only the current champion has a streak
  if (!core.s.seats[again].bot) { core.leave(core.s.seats[again].pid, 0); assert.equal(core.s.series[again], 0); }   // and it leaves with them
});

t('reactions: a number from a fixed list, rate-limited, optionally aimed at a seat; bots answer', () => {
  const { REACTIONS } = globalThis.Pusoy;
  assert.ok(REACTIONS.length >= 8);
  const core = TableCore.create({}, 0); core.join('a', { name: 'a' }, 0); core.join('b', { name: 'b' }, 0); core.drain();
  assert.ok(core.act('a', { t: 'react', e: 99 }, 1000).error);
  assert.ok(core.act('a', { t: 'react', e: '<b>' }, 1000).error);
  core.act('a', { t: 'react', e: 1 }, 1000);
  core.act('a', { t: 'react', e: 2 }, 1100);                                  // too soon: dropped
  core.act('a', { t: 'react', e: 8, to: 1 }, 2000);
  core.act('a', { t: 'react', e: 8, to: 0 }, 3000);                           // aimed at yourself: just a reaction
  assert.deepEqual(core.drain(), [{ k: 'react', seat: 0, e: 1, to: -1 }, { k: 'react', seat: 0, e: 8, to: 1 }, { k: 'react', seat: 0, e: 8, to: -1 }]);
  let answered = 0;
  for (let i = 0; i < 60; i++) {
    const t0 = 10000 + i * 10000;
    core.act('a', { t: 'react', e: 8, to: 2 }, t0);                           // a tomato for the bot in seat 2
    core.drain(); core.tick(t0 + 3000);
    const back = core.drain().filter((e) => e.k === 'react' && e.seat === 2);
    assert.ok(back.length <= 1);
    if (back.length) { answered++; assert.ok(back[0].e >= 0 && back[0].e < REACTIONS.length); }
  }
  assert.ok(answered > 25 && answered < 58, 'the bot answered ' + answered + ' of 60');
});

t('bot styles: each seat has one, and it shows in how often a bot passes', () => {
  const { BOT_STYLE, BOT_NAMES } = globalThis.Pusoy;
  assert.deepEqual(new Set(Object.values(BOT_STYLE)), new Set(Bot.STYLES));
  assert.ok(BOT_NAMES.every((n) => BOT_STYLE[n]));
  const core = TableCore.create({}, 0); core.join('a', { name: 'a' }, 0);
  const v = core.view(0, 0);
  assert.equal(v.seats[0].style, '');                                         // players have no style
  assert.ok(v.seats.slice(1).every((x) => Bot.STYLES.includes(x.style)));
  // same spot for all four: a cheap play is available on a low single, nobody is close to going out
  const spot = { hand: h('5c 6s 8d 9h 10c Js Qd Kh Ac 2s'), table: { ...ev('4s'), by: 1 }, seat: 0, mustOpen: false, counts: [10, 9, 9, 9], passed: [false, false, false, false], level: 'normal' };
  const passes = (style) => { let n = 0; for (let i = 0; i < 300; i++) if (!Bot.choose({ ...spot, style })) n++; return n; };
  assert.equal(passes('steady'), 0); assert.equal(passes('rusher'), 0);
  const bluffs = passes('trickster');
  assert.ok(bluffs > 100 && bluffs < 200, 'the trickster bluffed ' + bluffs + ' of 300');
  // over many deals: how often each style lets a trick go although it could have played
  const real = Bot.choose, rate = {};
  for (const style of Bot.STYLES) {
    let pass = 0, could = 0;
    Bot.choose = (view) => { const c = real({ ...view, style: view.seat === 0 ? style : 'steady' }); if (view.seat === 0 && view.table && E.legalPlays(view.hand, view.table, false).length) { could++; if (!c) pass++; } return c; };
    for (let r = 0; r < 250; r++) { const t2 = TableCore.create({ rounds: 1, botMs: [1, 2], emotes: false }, 0); t2.startMatch(0); let g = 0; while (t2.s.phase === 'playing' && g++ < 600) t2.autoMove(t2.s.turn, true, 0); }
    rate[style] = pass / could;
  }
  Bot.choose = real;
  assert.ok(rate.rusher < rate.steady - 0.1, 'rusher ' + rate.rusher.toFixed(2) + ' vs steady ' + rate.steady.toFixed(2));
  assert.ok(rate.hoarder > rate.steady + 0.1, 'hoarder ' + rate.hoarder.toFixed(2) + ' vs steady ' + rate.steady.toFixed(2));
  assert.ok(rate.trickster > rate.steady, 'trickster ' + rate.trickster.toFixed(2) + ' vs steady ' + rate.steady.toFixed(2));
});

// The tutorial: every lesson can be played through by doing what the coach asks,
// wrong moves are refused with a nudge, and each one ends with you going out.
{
  const { Tutorial } = globalThis.Pusoy;
  const warn = console.warn; let warned = '';
  console.warn = (...a) => { warned += a.join(' '); };
  const errors = []; let last = null, moves = 0, refused = 0;
  const done = await new Promise((resolve) => {
    const finished = [];
    const session = Tutorial.start({ name: 'Learner', av: 0 }, {
      onError: (msg) => errors.push(msg),
      onState: (v) => {
        last = v;
        const tu = v.tutor;
        assert.ok(tu && tu.text.length > 10 && !/\{\d\}/.test(tu.text), 'the coach always has something to say');
        assert.equal(v.aids, false);
        if (tu.done) {
          assert.equal(v.result.winner, 0, 'lesson ' + (tu.lesson + 1) + ' ends with you going out');
          assert.ok(v.seats.slice(1).every((x) => x.n > 0));
          finished.push(tu.lesson);
          if (tu.last) { session.close(); return resolve(finished); }
          return setTimeout(() => session.send({ t: 'next' }), 1);
        }
        if (!tu.want || v.turn !== 0) return;
        setTimeout(() => {
          if (last !== v) return;
          // first something the coach did not ask for...
          const before = errors.length;
          if (tu.want === 'pass') session.send({ t: 'play', cards: [v.hand[0]] }); else session.send({ t: 'pass' });
          assert.equal(errors.length, before + 1, 'a wrong move is refused'); refused++;
          assert.equal(last, v, 'and changes nothing');
          // ...then the right move
          moves++;
          if (tu.want === 'pass') session.send({ t: 'pass' });
          else { assert.ok(E.check(tu.want, v.table, v.mustOpen).ok, 'the coach only asks for legal plays'); session.send({ t: 'play', cards: tu.want }); }
        }, 1);
      }
    }, { pace: 400 });
  });
  console.warn = warn;
  assert.deepEqual(done, [0, 1, 2, 3]);
  assert.equal(warned, '', 'the scripts never fall out of step with the table');
  assert.ok(moves >= 15 && refused === moves);
  n++;
}

console.log(`rules: ${n} groups of checks passed`);
