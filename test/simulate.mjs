// Plays full bot-vs-bot matches through the real table code to shake out
// stuck games, illegal moves and scoring slips.  Run: node test/simulate.mjs [matches]
import assert from 'node:assert/strict';
import '../public/engine.js';
import '../public/bot.js';
import '../public/table.js';
const { TableCore, Bot, Engine: E } = globalThis.Pusoy;

// Every move a bot picks has to be legal at every level; the table would quietly
// cover for a bad one, so check here.
const pick = Bot.choose;
let checked = 0;
Bot.choose = (v) => {
  const cards = pick(v);
  if (cards) assert.ok(E.check(cards, v.table, v.mustOpen).ok, `${v.level} bot chose an illegal play`);
  else assert.ok(v.table, `${v.level} bot passed on the lead`);
  checked++;
  return cards;
};

const matches = Number(process.argv[2] || 200);
let rounds = 0, plays = 0, passes = 0, maxTurns = 0, t0 = Date.now();
const kinds = {};
const LEVELS = ['normal', 'easy', 'hard'];      // every level gets its share of matches

for (let m = 0; m < matches; m++) {
  const passLock = m % 2 === 0;
  // hard bots look ahead for a couple of milliseconds in a quarter of their matches, so that path is covered too
  const core = TableCore.create({ rounds: 5, turnSecs: 20, passLock, botMs: [1, 2], bots: LEVELS[m % 3], think: m % 12 === 2 ? 2 : 0 }, 0);
  core.join('watcher', { name: 'Watcher' }, 0);       // one seated human who never acts
  core.act('watcher', { t: 'start' }, 0);
  let now = 0, guard = 0, turns = 0, lastRound = 1;
  while (core.s.phase !== 'matchEnd') {
    const wake = core.nextWake();
    assert.ok(wake > 0, 'table went to sleep mid-match');
    now = Math.max(now + 1, wake);
    core.tick(now);
    for (const e of core.drain()) {
      if (e.k === 'play') { plays++; turns++; kinds[e.type] = (kinds[e.type] || 0) + 1; }
      if (e.k === 'pass') { passes++; turns++; }
      if (e.k === 'roundEnd') { rounds++; maxTurns = Math.max(maxTurns, turns); turns = 0; }
    }
    const s = core.s;
    // invariants
    const held = s.hands.flat();
    assert.equal(new Set(held).size, held.length, 'duplicate card in play');
    if (s.phase === 'playing') assert.ok(s.turn >= 0 && s.hands[s.turn].length > 0, 'turn points at an empty hand');
    assert.equal(s.scores.reduce((a, b) => a + b, 0), 0, 'scores are not zero-sum');
    assert.ok(guard++ < 5000, 'match did not finish');
    if (s.seats[0].bot) { core.join('watcher', { name: 'Watcher' }, now); }  // got bumped for idling: sit back down
  }
  assert.equal(core.s.round, 5);
  assert.ok(core.s.result.champ >= 0);
}
console.log(`simulate: ${matches} matches, ${rounds} rounds, ${plays} plays, ${passes} passes, longest round ${maxTurns} turns, ${Date.now() - t0} ms`);
console.log(`  bot moves checked: ${checked} (easy, normal and hard)`);
console.log('  hands played:', Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', '));
