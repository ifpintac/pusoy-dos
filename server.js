/* Pusoy Dos — game server (Cloudflare Worker + Durable Objects).
 *
 *   /api/lobby          WebSocket: the list of live tables, quick join, new table, hall of fame
 *   /api/table/CODE     WebSocket: one table. The server holds the cards and referees every move.
 *   everything else     the static game in ./public
 *
 * Lobby  — a single object that knows every open table and keeps the hall of fame.
 * Table  — one object per table. It sleeps between moves (WebSocket hibernation)
 *          and wakes on a message or an alarm, so idle tables cost nothing.
 */
import { DurableObject } from 'cloudflare:workers';
import './public/engine.js';
import './public/bot.js';
import './public/table.js';

const { TableCore, cleanText } = globalThis.Pusoy;

const HEARTBEAT_MS = 4 * 60 * 1000;     // how often a quiet table tells the lobby it is still there
const STALE_MS = 10 * 60 * 1000;        // the lobby forgets tables it hasn't heard from for this long
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
// Hard bots can look ahead by playing the round out many times, which costs CPU
// (tens of milliseconds a move). 0 keeps them to card counting, which fits the free
// plan's CPU limit; on a paid plan set this to 30 to match player-hosted tables.
const BOT_THINK_MS = 0;
const PLACES = ['Neon Room', 'Lucky Sevens', 'High Rollers', 'Bonus Stage', 'Wild Cards', 'Double Down', 'Card Sharks', 'Night Shift', 'Final Round', 'Coin Slot', 'Top Deck', 'Player Two'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/lobby') {
      return env.LOBBY.get(env.LOBBY.idFromName('main')).fetch(request);
    }
    const m = url.pathname.match(/^\/api\/table\/([A-Za-z]{4})$/);
    if (m) {
      return env.TABLE.get(env.TABLE.idFromName(m[1].toUpperCase())).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  }
};

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch (e) { /* socket already gone */ }
}
function parse(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  try { const m = JSON.parse(raw); return m && typeof m === 'object' ? m : null; } catch (e) { return null; }
}
function upgrade(ctx, tags) {
  const pair = new WebSocketPair();
  ctx.acceptWebSocket(pair[1], tags);
  return { client: pair[0], server: pair[1], response: new Response(null, { status: 101, webSocket: pair[0] }) };
}
async function playerId(key) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pusoy:' + key)));
  return Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Lobby                                                                */
/* ------------------------------------------------------------------ */

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tables = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS players (pid TEXT PRIMARY KEY, name TEXT, av INTEGER, wins INTEGER DEFAULT 0,' +
      ' games INTEGER DEFAULT 0, rounds INTEGER DEFAULT 0, points INTEGER DEFAULT 0, at INTEGER)'
    );
  }

  async load() {
    if (!this.tables) this.tables = (await this.ctx.storage.get('tables')) || {};
    const cutoff = Date.now() - STALE_MS;
    for (const code in this.tables) if (this.tables[code].at < cutoff) delete this.tables[code];
    return this.tables;
  }
  save() { return this.ctx.storage.put('tables', this.tables); }

  snapshot() {
    const list = Object.values(this.tables).filter((t) => t.pub);
    const open = (t) => t.seats.filter((x) => !x).length;
    const humans = (t) => 4 - open(t);
    list.sort((a, b) => (open(b) > 0) - (open(a) > 0) || humans(b) - humans(a) || b.at - a.at);
    let seated = 0;
    for (const t of Object.values(this.tables)) seated += humans(t);
    return { t: 'lobby', tables: list.slice(0, 60), online: this.ctx.getWebSockets().length + seated };
  }
  broadcast() {
    const msg = JSON.stringify(this.snapshot());
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch (e) { /* gone */ } }
  }

  top() {
    return this.ctx.storage.sql
      .exec('SELECT name, av, wins, games, rounds, points FROM players ORDER BY wins DESC, rounds DESC, points DESC LIMIT 20')
      .toArray();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    await this.load();
    const { server, response } = upgrade(this.ctx);
    server.serializeAttachment({ made: 0 });
    send(server, this.snapshot());
    return response;
  }

  async webSocketMessage(ws, raw) {
    const msg = parse(raw);
    if (!msg) return;
    await this.load();
    if (msg.t === 'board') return send(ws, { t: 'board', top: this.top() });

    if (msg.t === 'quick') {
      const open = Object.values(this.tables)
        .filter((t) => t.pub && t.seats.some((x) => !x))
        .sort((a, b) => b.seats.filter(Boolean).length - a.seats.filter(Boolean).length || (a.phase === 'waiting' ? -1 : 1));
      if (open.length) return send(ws, { t: 'go', code: open[0].code });
      msg.o = { pub: true };
    }

    if (msg.t === 'create' || msg.t === 'quick') {
      const att = ws.deserializeAttachment() || { made: 0 };
      const now = Date.now();
      if (now - att.made < 3000) return send(ws, { t: 'error', msg: 'One table at a time. Try again in a moment.' });
      if (Object.keys(this.tables).length >= 500) return send(ws, { t: 'error', msg: 'Every table is taken right now. Try joining one.' });
      att.made = now; ws.serializeAttachment(att);
      const o = msg.o || {};
      const used = new Set(Object.values(this.tables).map((t) => t.name));
      const free = PLACES.filter((p) => !used.has(p));
      const fallback = free.length ? free[Math.floor(Math.random() * free.length)] : 'Table ' + (Object.keys(this.tables).length + 1);
      for (let tries = 0; tries < 8; tries++) {
        let code = '';
        for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        if (this.tables[code]) continue;
        const summary = await this.env.TABLE.get(this.env.TABLE.idFromName(code)).init({
          code, name: cleanText(o.name, 28) || fallback, pub: o.pub !== false,
          rounds: o.rounds, turnSecs: o.turnSecs || 30, passLock: o.passLock !== false,
          bots: o.bots, think: BOT_THINK_MS
        });
        if (!summary) continue;            // that code is in use by a private table
        this.tables[code] = { ...summary, at: now };
        await this.save();
        this.broadcast();
        return send(ws, { t: 'go', code });
      }
      return send(ws, { t: 'error', msg: 'Couldn’t open a table. Try again.' });
    }
  }

  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) { /* closed */ } }
  async webSocketError() { /* nothing to clean up */ }

  /* --- called by tables --- */

  async tableUpdate(summary) {
    await this.load();
    this.tables[summary.code] = { ...summary, at: Date.now() };
    await this.save();
    this.broadcast();
  }
  async tableGone(code) {
    await this.load();
    if (!this.tables[code]) return;
    delete this.tables[code];
    await this.save();
    this.broadcast();
  }
  /* Finished matches. Only tables with two or more people count, so nobody climbs by beating bots. */
  async record(rows) {
    const now = Date.now();
    for (const r of rows) {
      if (!r || !r.pid || r.humans < 2) continue;
      this.ctx.storage.sql.exec(
        'INSERT INTO players (pid, name, av, wins, games, rounds, points, at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)' +
        ' ON CONFLICT(pid) DO UPDATE SET name = excluded.name, av = excluded.av, wins = wins + excluded.wins,' +
        ' games = games + 1, rounds = rounds + excluded.rounds, points = points + excluded.points, at = excluded.at',
        r.pid, cleanText(r.name, 16), r.av | 0, r.won ? 1 : 0, r.rounds | 0, r.points | 0, now
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Table                                                                */
/* ------------------------------------------------------------------ */

export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = undefined;      // undefined = not loaded yet, null = no such table
    this.lobbyAt = 0;
    this.lobbySum = '';
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  lobby() { return this.env.LOBBY.get(this.env.LOBBY.idFromName('main')); }

  async load() {
    if (this.core === undefined) {
      const s = await this.ctx.storage.get('s');
      this.core = s ? new TableCore(s) : null;
    }
    return this.core;
  }

  /* Called by the lobby when someone opens a table. */
  async init(o) {
    if (await this.load()) return null;
    const now = Date.now();
    this.core = TableCore.create(o, now);
    this.core.s.closeAt = now + 60000;         // nobody sat down within a minute: close again
    await this.ctx.storage.put('s', this.core.s);
    await this.ctx.storage.setAlarm(this.core.s.closeAt);
    this.lobbyAt = now;
    this.lobbySum = JSON.stringify(this.core.summary());
    return this.core.summary();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || '';
    const core = await this.load();
    const { server, response } = upgrade(this.ctx);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) {
      send(server, { t: 'error', code: 'badkey', msg: 'Couldn’t sign you in. Reload the page.' });
      server.close(4001, 'bad key');
      return response;
    }
    if (!core) {
      send(server, { t: 'error', code: 'gone', msg: 'That table has closed.' });
      server.close(4004, 'gone');
      return response;
    }
    const pid = await playerId(key);
    const now = Date.now();
    const r = core.join(pid, { name: url.searchParams.get('name'), av: url.searchParams.get('av') }, now);
    if (r.error) {
      send(server, { t: 'error', code: 'full', msg: 'That table is full.' });
      server.close(4005, 'full');
      return response;
    }
    // one connection per player: a new tab or a reconnect replaces the old one
    for (const old of this.ctx.getWebSockets()) {
      const a = old !== server && old.deserializeAttachment();
      if (a && a.pid === pid) { old.serializeAttachment({ pid, dead: true }); try { old.close(4008, 'replaced'); } catch (e) { /* closed */ } }
    }
    server.serializeAttachment({ pid });
    await this.flush();
    return response;
  }

  async webSocketMessage(ws, raw) {
    const msg = parse(raw);
    const att = ws.deserializeAttachment();
    const core = await this.load();
    if (!msg || !att || att.dead || !core) return;
    const now = Date.now();
    if (msg.t === 'leave') {
      core.leave(att.pid, now);
      ws.serializeAttachment({ pid: att.pid, dead: true });
      try { ws.close(1000, 'left'); } catch (e) { /* closed */ }
    } else {
      const r = core.act(att.pid, msg, now);
      if (r && r.error) send(ws, { t: 'error', code: 'move', msg: r.error });
    }
    await this.flush();
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) { /* closed */ }
    await this.dropped(ws);
  }
  async webSocketError(ws) { await this.dropped(ws); }

  async dropped(ws) {
    const att = ws.deserializeAttachment();
    const core = await this.load();
    if (!att || att.dead || !core) return;
    ws.serializeAttachment({ pid: att.pid, dead: true });
    core.setOffline(att.pid, Date.now());
    await this.flush();
  }

  async alarm() {
    const core = await this.load();
    if (!core) return;
    core.tick(Date.now());
    await this.flush();
  }

  /* Send everyone their view, save, set the next alarm, keep the lobby posted. */
  async flush() {
    const core = this.core;
    if (!core) return;
    const now = Date.now();

    if (core.closed) {
      for (const ws of this.ctx.getWebSockets()) {
        send(ws, { t: 'error', code: 'gone', msg: 'This table has closed.' });
        try { ws.close(4004, 'gone'); } catch (e) { /* closed */ }
      }
      const code = core.s.code;
      this.core = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      await this.lobby().tableGone(code);
      return;
    }

    const ev = core.drain();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att || att.dead) continue;
      const seat = core.seatOf(att.pid);
      if (seat < 0) {                         // lost the seat for sitting idle
        send(ws, { t: 'error', code: 'idle', msg: 'You were away too long, so a bot took your seat.' });
        ws.serializeAttachment({ pid: att.pid, dead: true });
        try { ws.close(4006, 'idle'); } catch (e) { /* closed */ }
        continue;
      }
      send(ws, { t: 'state', s: core.view(seat, now), ev });
    }

    const outbox = core.s.outbox;
    core.s.outbox = [];
    await this.ctx.storage.put('s', core.s);
    await this.ctx.storage.setAlarm(core.nextWake() || now + HEARTBEAT_MS);

    const sum = JSON.stringify(core.summary());
    if (sum !== this.lobbySum || now - this.lobbyAt > HEARTBEAT_MS) {
      this.lobbySum = sum; this.lobbyAt = now;
      await this.lobby().tableUpdate(core.summary());
    }
    if (outbox.length) await this.lobby().record(outbox);
  }
}
