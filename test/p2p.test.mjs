// Player-hosted tables, tested without a network: several pretend browsers
// share an in-memory "room" instead of WebRTC.   Run: node test/p2p.test.mjs
import assert from 'node:assert/strict';
import '../public/engine.js';
import '../public/bot.js';
import '../public/table.js';
import '../public/p2p.js';
const { P2P, Bot } = globalThis.Pusoy;

Object.assign(P2P.timing, { heartbeat: 40, hostLost: 220, recover: 500, connect: 600, announce: 120, tableTtl: 400, searching: 150, linger: 20 });
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
H.lobby.send({ t: 'create', o: { name: 'Friday <b>Night</b>', pub: true, rounds: 2, turnSecs: 30, botMs: [4, 8] } });
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
await until(() => D.errors.some((e) => e.code === 'full'), 2000, 'full-table refusal');
C.session.close();
await until(() => humans(H.state).length === 3, 2000, 'Cy to leave');
ok('a full table turns the fifth player away; leaving frees the seat for a bot');

// ---- 3. play: everyone only ever holds their own cards -------------------------
A.session.send({ t: 'play', cards: [51] });
await until(() => A.errors.some((e) => e.code === 'move'));
H.session.send({ t: 'start' });
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
H.session.kill(); vanish('Hana');
await until(() => heir.session.hosting, 3000, 'the next player to become host');
await until(() => other.status === 'online' && other.state && other.state.seats[hostSeat].bot, 3000, 'the other guest to follow the new host');
assert.equal(heir.state.seats[hostSeat].bot, true);                         // a bot sits where the host was
assert.equal(heir.state.round, round);
assert.deepEqual(humans(heir.state).sort(), [heir.name, other.name].sort());
assert.ok(heir.errors.some((e) => e.code === 'note'));
ok(`host dropped: ${heir.name} took over, a bot took the old seat, same round`);
await until(() => L.lobbyData.tables.filter((t) => t.code === code).length === 1 && L.lobbyData.tables[0].seats.filter(Boolean).length === 2, 3000, 'lobby to follow the new host');
ok('live tables now lists the table under its new host, once');

// the round still finishes, and the scores carried over
await until(() => heir.state.phase !== 'playing' || heir.state.round > round, 20000, 'the round to finish under the new host');
assert.equal(heir.state.seats.reduce((s, x) => s + x.score, 0), 0);
if (round === 1) assert.ok(scores === '0,0,0,0');
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

console.log(`p2p: ${n} checks passed`);
process.exit(0);
