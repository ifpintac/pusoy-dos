// A tiny stand-in for a public Nostr relay, for testing player-hosted tables offline.
// It keeps nothing: every event is passed straight on to whoever subscribed to its topic.
//   node test/tools/local-relay.mjs [port]
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] || 7777);
const wss = new WebSocketServer({ port });
const subs = new Map();   // socket -> Map(subId -> filter)

const matches = (f, ev) =>
  (!f.kinds || f.kinds.includes(ev.kind)) &&
  (!f['#x'] || (ev.tags || []).some((t) => t[0] === 'x' && f['#x'].includes(t[1])));

wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m[0] === 'REQ') { subs.get(ws).set(m[1], m[2] || {}); ws.send(JSON.stringify(['EOSE', m[1]])); }
    else if (m[0] === 'CLOSE') subs.get(ws).delete(m[1]);
    else if (m[0] === 'EVENT') {
      const ev = m[1];
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      for (const [sock, map] of subs) for (const [id, f] of map) if (matches(f, ev) && sock.readyState === 1) sock.send(JSON.stringify(['EVENT', id, ev]));
    }
  });
  ws.on('close', () => subs.delete(ws));
});
console.log('local relay on ws://127.0.0.1:' + port);
