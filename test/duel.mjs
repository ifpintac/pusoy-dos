// Head-to-head between bot levels, through the real table code.
// Run: node test/duel.mjs [rounds per pairing]
// Each pairing seats one "hero" bot against three "field" bots and rotates the
// hero's seat, so the deal is fair. A level with no edge wins 25% of rounds.
import '../public/engine.js';
import '../public/bot.js';
import '../public/table.js';
const { TableCore, Bot } = globalThis.Pusoy;

const rounds = Number(process.argv[2] || 4000);
const think = Number(process.argv[3] || 0);        // ms a hard bot may spend looking ahead (0 = card counting only)
const real = Bot.choose;
let levels = ['normal', 'normal', 'normal', 'normal'];
Bot.choose = (v) => real({ ...v, level: levels[v.seat], think });

export function duel(hero, field, n) {
  let wins = 0, points = 0, ms = 0, moves = 0;
  for (let r = 0; r < n; r++) {
    const seat = r % 4;
    levels = [field, field, field, field]; levels[seat] = hero;
    const core = TableCore.create({ rounds: 1, turnSecs: 0, passLock: r % 8 < 4, botMs: [1, 2] }, 0);
    core.startMatch(0);
    let guard = 0;
    while (core.s.phase === 'playing') {
      const t = performance.now();
      core.autoMove(core.s.turn, true, 0);
      ms += performance.now() - t; moves++;
      if (guard++ > 600) throw new Error('round did not finish');
    }
    core.drain();
    if (core.s.result.winner === seat) wins++;
    points += core.s.scores[seat];
  }
  return { wins: wins / n, points: points / n, perMove: ms / moves };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[4];
  const rows = [['hard', 'normal'], ['normal', 'easy'], ['hard', 'easy'], ['easy', 'normal'], ['normal', 'hard'], ['easy', 'hard']]
    .filter(([h, f]) => !only || only === h + ':' + f);
  console.log(`duel: one hero against three of the field, ${rounds} rounds each (25% = no edge)` + (think ? `, hard bots think ${think} ms` : ''));
  for (const [h, f] of rows) {
    const d = duel(h, f, rounds);
    console.log(`  ${h.padEnd(6)} vs 3 ${f.padEnd(6)}  wins ${(d.wins * 100).toFixed(1)}%  points/round ${d.points >= 0 ? '+' : ''}${d.points.toFixed(2)}  ${d.perMove < 1 ? (d.perMove * 1000).toFixed(0) + 'µs' : d.perMove.toFixed(1) + 'ms'}/move`);
  }
}
