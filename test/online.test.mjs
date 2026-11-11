// End-to-end check of the live server. Start it first (npm run dev), then:
//   node test/online.test.mjs [http://127.0.0.1:8787]
import assert from 'node:assert/strict';
import '../public/engine.js';
import '../public/bot.js';
const { Engine: E, Bot } = globalThis.Pusoy;

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

function open(path) {
  const ws = new WebSocket(base + path);
  const c = { ws, msgs: [], state: null, errors: [], closed: null, waiters: [] };
  ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data);
    c.msgs.push(m);
    if (m.t === 'state') c.state = m.s;
    if (m.t === 'error') c.errors.push(m);
    if (c.onmsg) c.onmsg(m);
    c.waiters = c.waiters.filter((w) => !w(m));
  };
  ws.onclose = (e) => { c.closed = e.code; };
  c.send = (m) => ws.send(JSON.stringify(m));
  c.until = (pred, ms = 8000, what = 'message') => new Promise((res, rej) => {
    const hit = c.msgs.find(pred);
    if (hit) return res(hit);
    const timer = setTimeout(() => rej(new Error('timed out waiting for ' + what)), ms);
    c.waiters.push((m) => { if (pred(m)) { clearTimeout(timer); res(m); return true; } return false; });
  });
  c.ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to ' + base + path)); });
  return c;
}
const seat = (path, k, name, av = 0) => open(`${path}?key=${k}&name=${encodeURIComponent(name)}&av=${av}`);

// --- lobby: create a public table ---------------------------------------
const lobby = open('/api/lobby');
await lobby.ready;
const first = await lobby.until((m) => m.t === 'lobby', 8000, 'lobby snapshot');
assert.ok(Array.isArray(first.tables));
lobby.send({ t: 'create', o: { name: 'Test <b>table</b>', pub: true, rounds: 1, turnSecs: 20 } });
const { code } = await lobby.until((m) => m.t === 'go', 8000, 'table code');
assert.match(code, /^[A-Z]{4}$/);
const listed = await lobby.until((m) => m.t === 'lobby' && m.tables.some((t) => t.code === code), 8000, 'table in lobby');
assert.equal(listed.tables.find((t) => t.code === code).name, 'Test btable/b');     // markup stripped
console.log('ok  lobby lists the new table', code);

// --- two people sit down --------------------------------------------------
const ka = key(), kb = key();
const a = seat('/api/table/' + code, ka, 'Ana', 1);
await a.until((m) => m.t === 'state', 8000, 'first state');
const b = seat('/api/table/' + code, kb, 'Ben', 2);
await b.until((m) => m.t === 'state');
await a.until((m) => m.t === 'state' && m.s.seats.filter((x) => !x.bot).length === 2);
assert.equal(a.state.phase, 'waiting');
assert.notEqual(a.state.you, b.state.you);
await lobby.until((m) => m.t === 'lobby' && (m.tables.find((t) => t.code === code) || { seats: [] }).seats.filter(Boolean).length === 2, 8000, 'lobby seat count');
console.log('ok  two players seated, lobby shows 2 of 4');

// bad keys and unknown tables are refused politely
const bad = open('/api/table/' + code + '?key=short&name=x');
await bad.until((m) => m.t === 'error' && m.code === 'badkey');
const none = seat('/api/table/ZZZZ', key(), 'x');
await none.until((m) => m.t === 'error' && m.code === 'gone');
console.log('ok  bad key and unknown table rejected');

// --- play a whole round, each client using only what it can see -------------
function autoplay(c, label) {
  let acted = -1;
  c.onmsg = (m) => {
    if (m.t !== 'state') return;
    const s = m.s;
    assert.equal(s.hands, undefined);                                   // never the full deal
    if (s.phase !== 'playing' || s.turn !== s.you || s.seq === acted) return;
    acted = s.seq;
    const cards = Bot.choose({ hand: s.hand, table: s.table, seat: s.you, passed: s.seats.map((x) => x.passed), mustOpen: s.mustOpen, counts: s.seats.map((x) => x.n) });
    setTimeout(() => c.send(cards ? { t: 'play', cards } : { t: 'pass' }), 40);
  };
}
// cheating attempts before the deal and out of turn
a.send({ t: 'play', cards: [51] });
await a.until((m) => m.t === 'error' && m.code === 'move');
a.send({ t: 'ready' }); b.send({ t: 'ready' });          // two players: the deal waits until both are ready
await a.until((m) => m.t === 'state' && m.s.phase === 'playing');
await b.until((m) => m.t === 'state' && m.s.phase === 'playing');
assert.equal(a.state.hand.length, 13); assert.equal(b.state.hand.length, 13);
assert.equal(a.state.hand.filter((x) => b.state.hand.includes(x)).length, 0);
const notTurn = a.state.turn === a.state.you ? b : a;
const before = notTurn.errors.length;
notTurn.send({ t: 'play', cards: [notTurn.state.hand[0]] });
await sleep(300);
assert.equal(notTurn.errors.length, before + 1);
// playing a card you don't hold
const onTurn = a.state.turn === a.state.you ? a : b.state.turn === b.state.you ? b : null;
if (onTurn) {
  const other = onTurn === a ? b : a;
  onTurn.send({ t: 'play', cards: [other.state.hand[0]] });
  await onTurn.until((m) => m.t === 'error' && /aren.t your cards/.test(m.msg));
}
console.log('ok  out-of-turn and stolen-card plays refused');

// chat reaches the other player, with markup stripped
a.send({ t: 'chat', text: 'Ayos! <script>' });
await b.until((m) => m.t === 'state' && m.ev.some((e) => e.k === 'chat' && e.text === 'Ayos! script'));
console.log('ok  chat delivered and cleaned');

// --- drop and reconnect mid-round ---------------------------------------
const handBefore = b.state.hand.slice();
b.ws.close();
await a.until((m) => m.t === 'state' && m.s.seats[b.state.you].on === false, 8000, 'Ben shown as away');
const b2 = seat('/api/table/' + code, kb, 'Ben', 2);
await b2.until((m) => m.t === 'state');
assert.equal(b2.state.you, b.state.you);
assert.ok(b2.state.hand.every((x) => handBefore.includes(x)));           // same seat, same cards (minus any played for him)
await a.until((m) => m.t === 'state' && m.s.seats[b.state.you].on === true);
console.log('ok  reconnect returns the same seat and hand');

autoplay(a, 'Ana'); autoplay(b2, 'Ben');
// kick the loop for whoever is on turn right now
for (const c of [a, b2]) c.onmsg({ t: 'state', s: c.state });
const end = await a.until((m) => m.t === 'state' && m.s.phase === 'matchEnd', 150000, 'end of the match');
const r = end.s.result;
assert.equal(r.left[r.winner], 0);
assert.equal(r.delta.reduce((x, y) => x + y, 0), 0);
assert.equal(new Set(r.hands.flat()).size, r.hands.flat().length);
console.log('ok  full round played to the end; winner seat', r.winner, 'cards left', r.left.join('/'), 'scores', end.s.seats.map((x) => x.score).join('/'));

// --- hall of fame got the result (2 humans at the table) ---------------------
await sleep(400);
lobby.send({ t: 'board' });
const board = await lobby.until((m) => m.t === 'board');
assert.ok(board.top.some((p) => p.name === 'Ana') && board.top.some((p) => p.name === 'Ben'));
console.log('ok  hall of fame updated:', board.top.slice(0, 3).map((p) => `${p.name} ${p.wins}W`).join(', '));

// --- quick join lands on the open table; a third person takes a bot seat ---
const lobby2 = open('/api/lobby');
await lobby2.ready;
lobby2.send({ t: 'quick' });
const q = await lobby2.until((m) => m.t === 'go');
assert.equal(q.code, code);
const c3 = seat('/api/table/' + code, key(), 'Ana', 3);                      // same name on purpose
await c3.until((m) => m.t === 'state');
assert.equal(c3.state.seats[c3.state.you].name, 'Ana 2');
console.log('ok  quick join found the table; duplicate name became "Ana 2"');

// --- leaving frees the seat, and an empty table closes -----------------------
c3.send({ t: 'leave' });
await a.until((m) => m.t === 'state' && m.s.seats.filter((x) => !x.bot).length === 2 && m.ev.some((e) => e.k === 'leave'));
a.send({ t: 'leave' }); b2.send({ t: 'leave' });
await lobby.until((m) => m.t === 'lobby' && !m.tables.some((t) => t.code === code), 8000, 'table removed from lobby');
const late = seat('/api/table/' + code, key(), 'Late');
await late.until((m) => m.t === 'error' && m.code === 'gone');
console.log('ok  table closed once everyone left');

for (const c of [lobby, lobby2, a, b2, c3, bad, none, late]) { try { c.ws.close(); } catch (e) {} }
console.log('online: all checks passed');
process.exit(0);
