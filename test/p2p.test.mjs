// Player-hosted tables, tested without a network: several pretend browsers
// share an in-memory "room" instead of WebRTC.   Run: node test/p2p.test.mjs
import assert from 'node:assert/strict';
import '../public/engine.js';
import '../public/bot.js';
import '../public/table.js';
import '../public/p2p.js';
import { createHash } from 'node:crypto';
const { P2P, Bot, TableCore } = globalThis.Pusoy;

Object.assign(P2P.timing, { heartbeat: 40, hostLost: 220, recover: 500, connect: 600, announce: 120, tableTtl: 400, searching: 150, linger: 20, pinWait: 150 });
P2P.limits.perSec = 400;      // these pretend browsers ping and play dozens of times a second; real ones do not
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000, what = 'condition') => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await sleep(10); } throw new Error('timed out waiting for ' + what); };

// ---- a pretend network -------------------------------------------------------
const hub = {};
function transportFor(id) {
  return (roomId) => {
    const room = (hub[roomId] ||= {});
    const me = { id, h: {} };
    room[id] = me;
    setTimeout(() => { for (const o of Object.values(room)) if (o !== me && room[id] === me) { o.h.join?.(id); me.h.join?.(o.id); } }, 3);
    return {
      selfId: id,
      send(m, to) { const data = JSON.parse(JSON.stringify(m)); setTimeout(() => { if (room[id] !== me) return; for (const o of Object.values(room)) if (o !== me && (!to || o.id === to)) o.h.msg?.(data, id); }, 2); },
      setHandlers(h) { me.h = h; },
      peers() { return Object.keys(room).filter((k) => k !== id); },
      leave() { if (room[id] !== me) return; delete room[id]; setTimeout(() => Object.values(room).forEach((o) => o.h.leave?.(id)), 2); }
    };
  };
}
const vanish = (id) => { for (const room of Object.values(hub)) delete room[id]; };   // a tab that dies without a word

function browser(name, av = 0) {
  const b = { name, net: P2P.create(transportFor(name)), state: null, errors: [], status: '', lobbyData: null, go: null, evs: [] };
  b.profile = { key: name + '-secret-key-0000', name, av };
  b.h = { onState: (s, ev) => { b.state = s; b.evs.push(...ev); if (b.auto) b.auto(); }, onError: (msg, code) => b.errors.push({ msg, code }), onStatus: (s) => { b.status = s; } };
  b.openLobby = () => { b.lobby = b.net.lobby({ onStatus() {}, onLobby: (m) => { b.lobbyData = m; }, onGo: (code) => { b.go = code; }, onBoard() {}, onError() {} }); };
  b.sit = (code) => { b.session = b.net.online(code, b.profile, b.h); };
  b.autoplay = () => {
    let acted = -1;
    b.auto = () => {
      const s = b.state;
      if (!s || s.phase !== 'playing' || s.turn !== s.you || s.seq === acted) return;
      acted = s.seq;
      const cards = Bot.choose({ hand: s.hand, table: s.table, seat: s.you, passed: s.seats.map((x) => x.passed), mustOpen: s.mustOpen, counts: s.seats.map((x) => x.n) });
      setTimeout(() => b.session.send(cards ? { t: 'play', cards } : { t: 'pass' }), 3);
    };
    b.auto();
  };
  return b;
}
const humans = (s) => s.seats.filter((x) => !x.bot).map((x) => x.name);
let n = 0; const ok = (msg) => { n++; console.log('ok  ' + msg); };

// ---- 1. host opens a public table; it shows up for someone browsing ------------
const H = browser('Hana', 0), A = browser('Ari', 1), B = browser('Bea', 2), L = browser('Lurker', 3);
L.openLobby(); H.openLobby();
await until(() => L.lobbyData, 1000, 'lobby to start');
assert.equal(L.lobbyData.tables.length, 0);
H.lobby.send({ t: 'create', o: { name: 'Friday <b>Night</b>', pub: true, rounds: 2, turnSecs: 30, botMs: [4, 8], bots: 'easy', readyMs: 300 } });
await until(() => H.go);
const code = H.go;
assert.match(code, /^[A-Z]{4}$/);
H.lobby.close(); H.sit(code);
assert.equal(H.session.hosting, true);
await until(() => H.state && H.state.phase === 'waiting');
await until(() => L.lobbyData.tables.some((t) => t.code === code), 2000, 'table to appear in the lobby');
const row = L.lobbyData.tables.find((t) => t.code === code);
assert.equal(row.name, 'Friday bNight/b');
assert.deepEqual(row.seats.map((x) => (x ? x.name : null)), ['Hana', null, null, null]);
assert.equal(row.bots, 'easy');                 // the bot level the host picked is on the table and in the lobby row
assert.equal(H.state.bots, 'easy');
ok('a hosted table appears in live tables, with its seats');

// ---- 2. two players join by code ---------------------------------------------
A.sit(code); B.sit(code);
await until(() => A.state && B.state && humans(H.state).length === 3, 3000, 'guests to be seated');
assert.equal(A.session.hosting, false);
assert.notEqual(A.state.you, B.state.you);
assert.equal(A.state.aids, false); assert.deepEqual(A.state.seen, []);
await until(() => L.lobbyData.tables[0].seats.filter(Boolean).length === 3, 2000, 'lobby seat count');
ok('guests are seated; lobby shows 3 of 4; hints and the card tracker are off');

// a fifth person can't squeeze in once the last seat goes
const C = browser('Cy', 3); C.sit(code);
await until(() => C.state && humans(H.state).length === 4);
const D = browser('Dee', 4); D.sit(code);
await until(() => D.session.watching && D.state && D.state.you === -1, 2000, 'the fifth player to end up watching');
assert.equal(humans(H.state).length, 4);
C.session.close();
await until(() => humans(H.state).length === 3, 2000, 'Cy to leave');
D.session.close();
await until(() => H.state.watchers === 0, 2000, 'the watcher to leave');
ok('a fifth player gets no seat at a full table (they watch); leaving frees the seat for a bot');

// ---- 3. play: everyone only ever holds their own cards -------------------------
A.session.send({ t: 'play', cards: [51] });
await until(() => A.errors.some((e) => e.code === 'move'));
[H, A, B].forEach((x) => x.session.send({ t: 'ready' }));        // three players: the deal waits until all are ready
await until(() => [H, A, B].every((x) => x.state.phase === 'playing'));
for (const x of [H, A, B]) { assert.equal(x.state.hand.length, 13); assert.equal(JSON.stringify(x.state).includes('"hands"'), false); }
assert.equal(new Set([...H.state.hand, ...A.state.hand, ...B.state.hand]).size, 39);
const idle = [A, B].find((x) => x.state.turn !== x.state.you);
const before = idle.errors.length;
idle.session.send({ t: 'play', cards: [idle.state.hand[0]] });
await until(() => idle.errors.length > before);
ok('out-of-turn and bogus plays are refused by the host');

[H, A, B].forEach((x) => x.autoplay());
await until(() => H.state.seats.reduce((s, x) => s + x.n, 0) < 44, 6000, 'some cards to be played');
ok('the game runs with the host refereeing');

// ---- 4. the host vanishes mid-round: the next player takes over ----------------
await until(() => H.state.phase === 'playing' && A.state.phase === 'playing', 4000);
const hostSeat = H.state.you, nextSeat = [1, 2, 3].map((i) => (hostSeat + i) % 4).find((s) => !H.state.seats[s].bot);
const heir = [A, B].find((x) => x.state.you === nextSeat), other = heir === A ? B : A;
await sleep(60);
const round = heir.state.round, scores = heir.state.seats.map((x) => x.score).join();
const midRound = heir.state.phase === 'playing';
H.session.kill(); vanish('Hana');
await until(() => heir.session.hosting, 3000, 'the next player to become host');
await until(() => other.status === 'online' && other.state && other.state.seats[hostSeat].bot, 3000, 'the other guest to follow the new host');
assert.equal(heir.state.seats[hostSeat].bot, true);                         // a bot sits where the host was
assert.equal(heir.state.round, round);
assert.equal(heir.state.bots, 'easy');                                      // the bot level moved with the table
assert.deepEqual(humans(heir.state).sort(), [heir.name, other.name].sort());
assert.ok(heir.errors.some((e) => e.code === 'note'));
ok(`host dropped: ${heir.name} took over, a bot took the old seat, same round`);
await until(() => L.lobbyData.tables.filter((t) => t.code === code).length === 1 && L.lobbyData.tables[0].seats.filter(Boolean).length === 2, 3000, 'lobby to follow the new host');
ok('live tables now lists the table under its new host, once');

// the round still finishes, and the scores carried over
await until(() => heir.state.phase !== 'playing' || heir.state.round > round, 20000, 'the round to finish under the new host');
assert.equal(heir.state.seats.reduce((s, x) => s + x.score, 0), 0);
if (round === 1 && midRound) assert.ok(scores === '0,0,0,0');
ok('the round finishes under the new host with scores intact');

// ---- 5. someone new joins and takes the bot's place ----------------------------
const E = browser('Eve', 5); E.sit(code);
await until(() => E.state && humans(heir.state).length === 3, 3000, 'Eve to be seated');
ok('a newcomer takes over a bot seat at the migrated table');

// ---- 6. the host leaves on purpose: instant handover ---------------------------
const hostNow = heir, seatNow = heir.state.you;
hostNow.session.close();
const rest = [other, E];
await until(() => rest.some((x) => x.session.hosting), 2000, 'handover');
const host2 = rest.find((x) => x.session.hosting), guest2 = rest.find((x) => !x.session.hosting);
await until(() => guest2.status === 'online' && guest2.state.seats[seatNow].bot && humans(guest2.state).length === 2, 3000, 'guest to follow the handover');
ok(`host left on purpose: ${host2.name} is hosting, nobody was dropped`);

// ---- 7. a guest reloads: the seat is held, then they are back in it ------------
const gSeat = guest2.state.you, gHand = guest2.state.hand.join();
guest2.session.bye(); guest2.session.kill(); vanish(guest2.name);
await until(() => host2.state.seats[gSeat].on === false, 2000, 'seat marked away');
const again = browser(guest2.name, 2); again.sit(code);
await until(() => again.state && again.state.you === gSeat && host2.state.seats[gSeat].on === true, 3000, 'guest to return');
if (host2.state.phase === 'playing') assert.ok(again.state.hand.every((c) => gHand.split(',').map(Number).includes(c)) || again.state.round !== guest2.state.round);
ok('a reloading guest gets the same seat back');

// ---- 8. everyone leaves: the table disappears from the lobby --------------------
again.session.close();
await until(() => humans(host2.state).length === 1, 2000);
host2.session.close();
await until(() => !L.lobbyData.tables.some((t) => t.code === code), 3000, 'table to leave the lobby');
ok('the table is gone from live tables once the last host leaves');

// ---- 9. invite-only tables stay off the list; quick join finds or makes a table --
const P1 = browser('Pia'), Q = browser('Quin');
P1.openLobby(); Q.openLobby();
P1.lobby.send({ t: 'create', o: { pub: false, rounds: 1 } });
await until(() => P1.go); P1.sit(P1.go);
await sleep(250);
assert.equal(Q.lobbyData.tables.length, 0);
Q.sit(P1.go);
await until(() => Q.state && humans(P1.state).length === 2, 2000, 'join by code');
ok('invite-only tables are joinable by code but never listed');
const R = browser('Rae'), S = browser('Sol');
R.openLobby(); S.openLobby();
R.lobby.send({ t: 'quick' });                                  // nothing open: quick join opens a table
await until(() => R.go); R.sit(R.go);
await until(() => S.lobbyData && S.lobbyData.tables.some((t) => t.code === R.go), 2000, 'quick table listed');
S.lobby.send({ t: 'quick' });                                  // now there is one: quick join picks it
await until(() => S.go);
assert.equal(S.go, R.go);
ok('quick join opens a table when none exist and picks an open one when there is');

// ---- 10. a guest pointed at a table that isn't there gives up politely ----------
const Z = browser('Zed'); Z.sit('ZZZZ');
await until(() => Z.errors.some((e) => e.code === 'gone'), 2000, 'give-up message');
ok('joining a table that does not exist ends with a clear message');

// =================== people who do not play by the rules ===================
// Mallory is a raw connection: she can join any room and send anything at all.
function rogue(id, roomId) {
  const raw = transportFor(id)(roomId), got = [];
  raw.setHandlers({ msg: (m, from) => got.push({ m, from }), join() {}, leave() {} });
  return { raw, got, joins: () => got.filter((x) => x.m && x.m.t === 'join') };
}

// ---- 11. seat tokens: the saved key never leaves the browser --------------------
for (const text of ['', 'abc', 'pusoy', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(200), 'ñ ♦ 2']) {
  assert.equal(P2P.sha256(text), createHash('sha256').update(text, 'utf8').digest('hex'));
}
{
  const fakeHost = rogue('Mallory-host', 'table-QQQQ');
  const beat = setInterval(() => fakeHost.raw.send({ t: 'host', epoch: 1, backup: null }), 20);
  const V = browser('Vic'); V.sit('QQQQ');
  await until(() => fakeHost.joins().length > 0, 2000, 'guest to introduce itself');
  const key = fakeHost.joins()[0].m.key;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(fakeHost.got).includes(V.profile.key));          // the real key is nowhere in what a host is sent
  assert.equal(key, P2P.tokenOf(V.profile, 'QQQQ'));
  assert.notEqual(key, P2P.tokenOf(V.profile, 'QQQR'));                       // and the token is useless at any other table
  ok('a host is shown a one-table token, never the player\'s saved key');

  // ---- 12. a hostile host cannot put markup or junk on a guest's screen ----------
  const evil = '<img src=x onerror=alert(1)>';
  fakeHost.raw.send({ t: 'state', ev: [{ k: 'chat', seat: 1, text: evil }, { k: 'play', seat: 1, cards: ['<b>', 3, 9] }, { k: 'join', seat: 9, name: evil }, { k: 'join', seat: 2, name: evil }, 'junk', null],
    s: { code: evil, name: evil, pub: 1, rounds: 1e9, turnSecs: -5, phase: 'playing', round: 2.5, you: 0, seq: 7, bots: evil, aids: true, seen: [1, 2, 3],
      seats: [0, 1, 2, 3].map((i) => ({ name: evil + i, av: 99, bot: 'yes', on: 1, n: 400, passed: 0, score: '12', wins: {} })),
      hand: [5, 5, '6', 51.5, -1, 99, 7, { toString() { return evil; } }], turn: '0', table: { cards: [evil], by: 7, name: evil, power: 1e9 },
      trick: [{ cards: [8, 12], by: 1 }, { cards: [4], by: evil }], mustOpen: 'x', turnAt: evil, nextAt: NaN, now: evil, result: { winner: evil } } }, 'Vic');
  await until(() => V.state, 2000, 'cleaned state');
  const flat = JSON.stringify([V.state, V.evs]);
  assert.ok(!flat.includes('<') && !flat.includes('>'), 'markup reached the page: ' + flat.slice(0, 600));
  assert.equal(V.state.code, 'QQQQ');
  assert.deepEqual(V.state.hand, [5, 7]);                                   // only real, distinct cards survive
  assert.equal(V.state.table, null);
  assert.deepEqual(V.state.trick, [{ cards: [4], by: 0 }]);                 // cards 8 and 12 are not a pair
  assert.equal(V.state.aids, false); assert.deepEqual(V.state.seen, []);
  assert.equal(V.state.rounds, 5); assert.equal(V.state.bots, 'normal'); assert.equal(V.state.turn, -1);
  assert.ok(V.state.seats.every((x) => x.n === 0 && x.av === 0 && x.score === 0 && typeof x.name === 'string'));
  assert.deepEqual(V.evs.map((e) => e.k), ['chat', 'join']);                // the bogus play and the seat-9 notice were dropped
  // awards from a host are cut down to an id, a seat and a number
  {
    const core = TableCore.create({ rounds: 1, botMs: [1, 2], emotes: false }, 0);
    core.join('a', { name: 'a' }, 0); core.act('a', { t: 'start' }, 0);
    let g = 0; while (core.s.phase === 'playing' && g++ < 600) core.autoMove(core.s.turn, true, 0);
    const view = JSON.parse(JSON.stringify(core.view(0, 0)));
    view.result.awards = [{ id: 'dos', seat: 2, n: 4, extra: evil }, { id: evil, seat: 1, n: 1 }, { id: 'heavy', seat: 7, n: 1 }, { id: 'bench', seat: 0, n: evil }, evil, null]
      .concat(Array.from({ length: 30 }, () => ({ id: 'tricks', seat: 1, n: 5 })));
    const clean = P2P.cleanView(view, view.code);
    assert.deepEqual(clean.result.awards, [{ id: 'dos', seat: 2, n: 4 }, { id: 'bench', seat: 0, n: 0 }]);          // and only the first six are even looked at
    const copy = P2P.cleanSnapshot(JSON.parse(JSON.stringify(Object.assign({}, core.s, { stats: [{ twos: 3, tricks: evil, best: -4, junk: evil }, null, evil, { passes: 1e9 }] }))), core.s.code);
    assert.deepEqual(copy.stats[0], { twos: 3, tricks: 0, passes: 0, fives: 0, big: 0, run: 0, best: 0, turns: 0, quick: 0, stuck: 0 });
    assert.ok(copy.stats.length === 4 && copy.stats[3].passes === 0 && !JSON.stringify(copy.stats).includes('<'));
  }
  const before = V.state;
  for (const junk of [null, 'state', { seats: [] }, { seats: [1, 2, 3, 4], phase: 'playing', you: 5 }, { seats: [{}, {}, {}, {}], phase: 'roundEnd', you: 0 }]) fakeHost.raw.send({ t: 'state', s: junk, ev: [] }, 'Vic');
  fakeHost.raw.send({ t: 'error', code: 'gone', msg: evil + ' bye' }, 'Vic');
  await until(() => V.errors.some((e) => e.code === 'gone'), 2000, 'closing message');
  assert.equal(V.state, before);                                            // malformed states never replaced the good one
  assert.ok(!V.errors.some((e) => e.msg.includes('<')));
  clearInterval(beat); fakeHost.raw.leave();
  ok('whatever a host sends is rebuilt before the page sees it: no markup, no impossible cards');
}

// ---- 13. "I am the host now": ignored unless the real host named you -------------
{
  const H3 = browser('Hugo'), G3 = browser('Gail', 1), K3 = browser('Kit', 2), L3 = browser('Lena', 3);
  H3.openLobby(); L3.openLobby();
  H3.lobby.send({ t: 'create', o: { name: 'Honest table', pub: true, rounds: 1, turnSecs: 30, botMs: [4, 8] } });
  await until(() => H3.go); const c3 = H3.go; H3.lobby.close(); H3.sit(c3);
  await until(() => L3.lobbyData && L3.lobbyData.tables.some((t) => t.code === c3), 2000, 'table listed');
  const M = rogue('Mallory', 'table-' + c3);
  G3.sit(c3);
  await until(() => G3.state && humans(H3.state).length === 2, 3000, 'first guest');
  K3.sit(c3);
  await until(() => K3.state && humans(H3.state).length === 3, 3000, 'second guest');
  // (someone who types a bare code has nothing to tell hosts apart by, so the impostor starts once these two are seated)
  const spam = setInterval(() => { M.raw.send({ t: 'hb', epoch: 999, backup: 'Mallory' }); M.raw.send({ t: 'host', epoch: 999, backup: 'Mallory' }); M.raw.send({ t: 'handover', epoch: 999, to: 'Mallory' }); }, 15);
  await sleep(300);
  assert.equal(H3.session.hosting, true);
  assert.ok(!H3.errors.some((e) => e.code === 'moved'));                     // the real host was not talked into stepping down
  assert.equal(G3.status, 'online'); assert.equal(K3.status, 'online');
  assert.equal(M.joins().length, 0);                                         // and nobody sat down with the impostor
  ok('a stranger announcing "I host this table" is ignored by the host and every guest');

  // someone browsing the lobby sits with the host that listed the table, even if an impostor speaks first
  L3.sit(c3);
  await until(() => L3.state && humans(H3.state).length === 4, 3000, 'lobby joiner');
  assert.equal(M.joins().length, 0);
  ok('joining from live tables goes to the host that listed the table');

  // the impostor copies a live table's code into the lobby: still one row, the real one
  const ML = rogue('Mallory', 'lobby'), W = browser('Wren'); W.openLobby();
  await until(() => W.lobbyData && W.lobbyData.tables.some((t) => t.code === c3), 2000, 'lobby');
  for (let i = 0; i < 20; i++) ML.raw.send({ t: 'tbl', s: { code: c3, name: 'Free chips here', pub: true, phase: 'waiting', round: 0, rounds: 5, seats: [null, null, null, null] } });
  await sleep(200);
  const rows = W.lobbyData.tables.filter((t) => t.code === c3);
  assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Honest table');
  ok('a copied table code does not get a second row in live tables');

  // the real host drops: only the successor it named (the next player) is followed
  [H3, G3, K3, L3].forEach((x) => x.session.send({ t: 'ready' }));
  await until(() => K3.state.phase === 'playing', 2000, 'deal');
  [G3, K3, L3].forEach((b) => b.autoplay());
  await sleep(120);
  const seat = H3.state.you;
  H3.session.kill(); vanish('Hugo');
  await until(() => [G3, K3, L3].some((b) => b.session.hosting), 4000, 'successor to take over');
  const heir3 = [G3, K3, L3].find((b) => b.session.hosting), rest = [G3, K3, L3].filter((b) => b !== heir3);
  await until(() => rest.every((b) => b.status === 'online' && b.state.seats[seat].bot), 4000, 'guests to follow the successor');
  assert.equal(M.joins().length, 0);
  assert.equal(heir3.state.seats.filter((x) => !x.bot).length, 3);
  ok(`host gone: everyone followed ${heir3.name}, the named successor, not the impostor`);
  clearInterval(spam); M.raw.leave(); ML.raw.leave();

  // a flood from one seat is dropped without stalling the table, and an old-style raw key is not a ticket
  const F = rogue('Flood', 'table-' + c3);
  F.raw.send({ t: 'join', key: rest[0].profile.key, name: 'Ghost', av: 0 }, heir3.name);
  for (let i = 0; i < 400; i++) F.raw.send({ t: 'act', m: { t: 'chat', text: 'x'.repeat(5000) } }, heir3.name);
  await sleep(150);
  assert.ok(!F.got.some((x) => x.m.t === 'state'));
  assert.equal(heir3.state.seats.filter((x) => !x.bot).length, 3);
  F.raw.leave();
  ok('a raw key gets no seat, and a message flood is shrugged off');
  [G3, K3, L3].forEach((b) => { b.auto = null; b.session.kill(); vanish(b.name); });
}

// ---- 14. the table copy a successor starts from is checked too --------------------
{
  const core = TableCore.create({ code: 'ABCD', name: 'T', rounds: 3, turnSecs: 30, bots: 'hard', aids: true }, 0);
  core.join('k' + 'a'.repeat(40), { name: 'Ana' }, 0); core.join('not-a-pid', { name: '<i>Bo</i>' }, 0);
  core.startMatch(0);
  const copy = JSON.parse(JSON.stringify(core.s));
  const good = P2P.cleanSnapshot(copy, 'ABCD');
  assert.ok(good);
  assert.deepEqual(good.hands, core.s.hands); assert.equal(good.turn, core.s.turn); assert.equal(good.opts.bots, 'hard');
  assert.equal(good.opts.aids, false);                                       // hints can never be switched on for a live table
  assert.equal(good.seats[0].pid, 'k' + 'a'.repeat(40));
  assert.equal(good.seats[1].bot, true);                                     // a seat without a proper id goes back to a bot
  assert.ok(!JSON.stringify(good).includes('<'));
  const cheat = JSON.parse(JSON.stringify(core.s)); cheat.hands[1][0] = cheat.hands[0][0];      // the same card in two hands
  assert.equal(P2P.cleanSnapshot(cheat, 'ABCD'), null);
  const short = JSON.parse(JSON.stringify(core.s)); short.hands[2].pop();                       // a card missing from the deck
  assert.equal(P2P.cleanSnapshot(short, 'ABCD'), null);
  assert.equal(P2P.cleanSnapshot({ seats: 'x' }, 'ABCD'), null);
  ok('a table copy with cards that do not add up is refused');
}

// ---- 15. watching a full table, and taking a seat when one opens ------------------
{
  const names = ['Wa', 'Wb', 'Wc', 'Wd'], seats = names.map((x, i) => browser(x, i));
  const host4 = seats[0], Lw = browser('Lobbyist', 4), V = browser('Viewer', 5), V2 = browser('Second', 5);
  Lw.openLobby(); host4.openLobby();
  host4.lobby.send({ t: 'create', o: { name: 'Packed', pub: true, rounds: 1, turnSecs: 30, botMs: [4, 8], readyMs: 60 } });
  await until(() => host4.go); const c4 = host4.go; host4.lobby.close(); host4.sit(c4);
  await until(() => host4.state);
  for (const b of seats.slice(1)) { b.sit(c4); await until(() => b.state, 3000, b.name + ' seated'); }
  await until(() => humans(host4.state).length === 4, 3000, 'four seated');
  V.session = V.net.online(c4, V.profile, V.h);                                   // asks for a seat, finds none
  await until(() => V.state && V.session.watching, 3000, 'a full table to turn into watching');
  assert.equal(V.state.you, -1); assert.deepEqual(V.state.hand, []);
  assert.ok(V.errors.some((e) => e.code === 'note' && /watching/.test(e.msg)));
  V2.session = V2.net.online(c4, V2.profile, V2.h, { watch: true });               // or come in as a watcher on purpose
  await until(() => V2.state && V2.state.you === -1, 3000, 'second watcher');
  await until(() => host4.state.watchers === 2 && Lw.lobbyData.tables.some((t) => t.code === c4 && t.watchers === 2), 3000, 'watcher count');
  assert.equal(humans(host4.state).length, 4);                                     // watchers hold no seat
  ok('a full table is watched instead of refused; watchers are counted and see no hand');

  seats.forEach((b) => b.session.send({ t: 'ready' }));
  await until(() => V.state.phase === 'playing', 3000, 'the deal to reach the watchers');
  assert.deepEqual(V.state.hand, []); assert.deepEqual(V.state.seen, []);
  assert.ok(V.state.seats.every((x) => x.n === 13));
  V.session.send({ t: 'play', cards: [0] }); V.session.send({ t: 'react', e: 1 });   // a watcher cannot act
  const flat = JSON.stringify(V.state);
  await sleep(120);
  assert.ok(!V.evs.some((e) => e.k === 'react'));
  assert.ok(!/"hand":\[\d/.test(flat));
  V.session.sit();                                                                   // no seat free yet
  await until(() => V.errors.some((e) => /just taken/.test(e.msg)), 2000, 'a polite no');
  assert.equal(V.session.watching, true);
  ok('watchers follow the game but cannot play, react or see cards; asking for a taken seat is refused politely');

  seats.forEach((b) => b.autoplay());
  const quitter = seats[3], qSeat = quitter.state.you;
  quitter.auto = null; quitter.session.close();
  await until(() => V.state.seats[qSeat].bot, 3000, 'a seat to open');
  V.session.sit();
  await until(() => V.state.you === qSeat && !V.session.watching, 3000, 'the watcher to sit down');
  assert.ok(V.state.phase !== 'playing' || V.state.hand.length > 0 || V.state.seats[qSeat].n === 0);
  await until(() => host4.state.watchers === 1, 2000, 'one watcher left');
  ok('when a player leaves, a watcher takes the open seat and its cards');

  // the host drops: the watcher follows the table to its new host
  const hSeat = host4.state.you;
  host4.auto = null; host4.session.kill(); vanish(host4.name);
  await until(() => V2.state.seats[hSeat].bot && V2.status === 'online', 5000, 'the watcher to follow the new host');
  assert.equal(V2.session.watching, true); assert.equal(V2.state.you, -1);
  ok('a watcher follows the table when it changes host');
  [...seats, V, V2].forEach((b) => { b.auto = null; try { b.session.kill(); } catch (e) { /* gone */ } vanish(b.name); });
}

// ---- 16. ready-up, reactions and rematch across the network ----------------------
{
  const Ra = browser('Rita', 0), Rb = browser('Rob', 1);
  Ra.openLobby();
  Ra.lobby.send({ t: 'create', o: { name: 'Again', pub: false, rounds: 1, turnSecs: 30, botMs: [3, 6], readyMs: 400 } });
  await until(() => Ra.go); const c5 = Ra.go; Ra.lobby.close(); Ra.sit(c5);
  await until(() => Ra.state); Rb.sit(c5);
  await until(() => Rb.state && humans(Ra.state).length === 2, 3000, 'two seated');
  Rb.session.send({ t: 'ready' });
  await until(() => Ra.state.seats[Rb.state.you].ready && Ra.state.readyAt > 0, 2000, 'a ready vote to show');
  assert.equal(Ra.state.phase, 'waiting'); assert.equal(Ra.state.seats[Ra.state.you].ready, false);
  Rb.session.send({ t: 'react', e: 8, to: Ra.state.you });
  await until(() => Ra.evs.some((e) => e.k === 'react' && e.e === 8 && e.to === Ra.state.you), 2000, 'a reaction to arrive');
  Rb.session.send({ t: 'react', e: 'x' }); Rb.session.send({ t: 'react', e: 500 });
  Ra.session.send({ t: 'ready' });
  await until(() => Ra.state.phase === 'playing' && Rb.state.phase === 'playing', 2000, 'the deal once both are ready');
  [Ra, Rb].forEach((b) => b.autoplay());
  await until(() => Ra.state.phase === 'matchEnd' && Rb.state.phase === 'matchEnd', 20000, 'the match to end');
  const champ = Ra.state.result.champ;
  assert.equal(Ra.state.seats[champ].series, 1);
  Ra.session.send({ t: 'ready' });                                                  // one player wants a rematch...
  await until(() => Rb.state.seats[Ra.state.you].ready && Rb.state.readyAt > 0, 2000, 'the rematch vote');
  await until(() => Rb.state.phase === 'playing' && Rb.state.round === 1, 3000, 'the rematch to start when the timer runs out');
  assert.equal(Rb.state.seats.reduce((a, x) => a + x.score, 0), 0);
  ok('ready votes, aimed reactions and a rematch all travel between players');
  [Ra, Rb].forEach((b) => { b.auto = null; b.session.kill(); vanish(b.name); });
}

console.log(`p2p: ${n} checks passed`);
process.exit(0);
