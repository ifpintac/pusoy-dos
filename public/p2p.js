/* Pusoy Dos — player-hosted tables. No game server.
 *
 * The host's browser runs the table (the same referee code as solo play) and
 * the other players connect straight to it over WebRTC. Public relays are only
 * used to introduce browsers to each other; the cards never pass through them.
 *
 *   room "lobby"        everyone on the home screen, plus every host of a public table.
 *                       Hosts announce their table here; that is the live-tables list.
 *   room "table-CODE"   the players at one table.
 *
 * If the host leaves or drops, the next player in seat order takes over hosting
 * (the host keeps that one player supplied with a copy of the table for exactly
 * this purpose), and a bot sits in the old host's seat.
 *
 * Worth knowing: whoever hosts holds the whole deck in their browser, so this is
 * for playing with people you trust. A referee server (server.js) fixes that.
 */
(function (root) {
  'use strict';
  var P = (root.Pusoy = root.Pusoy || {});

  var APP_ID = 'pusoy-dos-arcade-1';
  var NAMES = ['Neon Room', 'Lucky Sevens', 'High Rollers', 'Bonus Stage', 'Wild Cards', 'Double Down', 'Card Sharks', 'Night Shift', 'Final Round', 'Coin Slot', 'Top Deck', 'Player Two'];
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  var FATAL = { gone: 1, full: 1, idle: 1, replaced: 1, moved: 1 };

  var timing = {
    heartbeat: 2000,     // host -> players: "still here"
    hostLost: 7000,      // no heartbeat for this long: the host is gone
    recover: 12000,      // how long to wait for the new host to appear
    connect: 25000,      // how long to wait to reach a table at all
    announce: 8000,      // hosts repeat their table to the lobby this often
    tableTtl: 20000,     // the lobby forgets tables it hasn't heard from
    searching: 6000,     // how long the home screen says "looking for tables"
    linger: 400          // keep a room open this long after the last user, in case it is reopened
  };

  function now() { return Date.now(); }
  function randomCode() {
    var s = '';
    for (var i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }
  function pidOf(key) { return 'k' + String(key || '').slice(0, 64); }
  /* Who a player is at a table: their saved key plus this tab's id, so two tabs are two players. */
  function identOf(profile) { return String(profile.key || '') + (profile.tab ? '.' + profile.tab : ''); }

  /* What a host tells the lobby, cleaned up before anyone trusts it. */
  function cleanSummary(s) {
    if (!s || typeof s !== 'object' || !/^[A-Z]{4}$/.test(s.code) || !Array.isArray(s.seats) || s.seats.length !== 4) return null;
    var phases = { waiting: 1, playing: 1, roundEnd: 1, matchEnd: 1 };
    return {
      code: s.code, name: P.cleanText(s.name, 28) || 'Table', pub: true,
      phase: phases[s.phase] ? s.phase : 'waiting',
      round: Math.max(0, Math.min(99, s.round | 0)), rounds: Math.max(1, Math.min(99, s.rounds | 0)),
      seats: s.seats.map(function (x) { return x && typeof x === 'object' ? { name: P.cleanText(x.name, 16) || 'Player', av: Math.max(0, Math.min(5, x.av | 0)) } : null; })
    };
  }

  /* ---------- the real transport: Trystero over public Nostr relays ---------- */

  function trysteroTransport(roomId) {
    var T = root.Trystero;
    var cfg = { appId: APP_ID, relayConfig: { warnOnRelayFailure: false } };
    if (root.PUSOY_RELAYS && root.PUSOY_RELAYS.length) cfg.relayConfig.urls = root.PUSOY_RELAYS;   // your own relay list, if you have one
    if (root.PUSOY_TURN && root.PUSOY_TURN.length) cfg.turnConfig = root.PUSOY_TURN;               // a TURN server helps strict networks
    var room = T.joinRoom(cfg, roomId, { onJoinError: function () { /* that one peer couldn't connect; others still can */ } });
    var act = room.makeAction('m');
    return {
      selfId: T.selfId,
      send: function (m, to) {
        try { var p = act.send(m, to ? { target: to } : undefined); if (p && p.catch) p.catch(function () { /* peer went away mid-send */ }); }
        catch (e) { /* not connected yet */ }
      },
      setHandlers: function (h) {
        act.onMessage = function (data, meta) { h.msg(data, meta && meta.peerId); };
        room.onPeerJoin = function (id) { h.join(id); };
        room.onPeerLeave = function (id) { h.leave(id); };
      },
      peers: function () { try { return Object.keys(room.getPeers()); } catch (e) { return []; } },
      leave: function () { try { room.leave(); } catch (e) { /* already left */ } }
    };
  }

  /* ---------- one player's view of the network ---------- */

  function create(transport) {
    var rooms = {};          // roomId -> { raw, users: [handle], timer }
    var pendingHost = {};    // code -> options for a table this player is about to host

    /* Rooms are shared and reference-counted, so leaving and immediately
     * rejoining the same room (home screen <-> hosting) never cuts it off. */
    function open(roomId) {
      var r = rooms[roomId];
      if (r) clearTimeout(r.timer);
      else {
        r = rooms[roomId] = { raw: transport(roomId), users: [], timer: 0 };
        var each = function (type) {
          return function (a, b) { r.users.slice().forEach(function (u) { if (u.on[type]) u.on[type](a, b); }); };
        };
        r.raw.setHandlers({ msg: each('msg'), join: each('join'), leave: each('leave') });
      }
      var handle = {
        selfId: r.raw.selfId, on: {},
        send: function (m, to) { r.raw.send(m, to); },
        peers: function () { return r.raw.peers(); },
        close: function () {
          var i = r.users.indexOf(handle);
          if (i < 0) return;
          r.users.splice(i, 1); handle.on = {};
          if (!r.users.length) r.timer = setTimeout(function () { if (!r.users.length && rooms[roomId] === r) { delete rooms[roomId]; r.raw.leave(); } }, timing.linger);
        }
      };
      r.users.push(handle);
      return handle;
    }

    /* ---------- home screen: the list of live tables ---------- */
    function lobby(h) {
      var ch = open('lobby'), tables = {}, started = now(), dead = false;
      function emit() {
        if (dead) return;
        var cutoff = now() - timing.tableTtl, list = [], seated = 0, k;
        for (k in tables) { if (tables[k].at < cutoff) delete tables[k]; else list.push(tables[k].s); }
        var open_ = function (t) { return t.seats.filter(function (x) { return !x; }).length; };
        list.sort(function (a, b) { return (open_(b) > 0) - (open_(a) > 0) || open_(a) - open_(b) || (a.code < b.code ? -1 : 1); });
        list.forEach(function (t) { seated += 4 - open_(t) - 1; });      // the host is already counted as a lobby peer
        h.onLobby({ tables: list, online: ch.peers().length + 1 + Math.max(0, seated), searching: !list.length && now() - started < timing.searching });
      }
      ch.on.msg = function (m, peer) {
        if (!m || !peer) return;
        if (m.t === 'tbl') { var s = cleanSummary(m.s); if (s) { tables[peer] = { s: s, at: now() }; emit(); } }
        else if (m.t === 'gone') { delete tables[peer]; emit(); }
      };
      ch.on.join = function (peer) { ch.send({ t: 'who' }, peer); emit(); };
      ch.on.leave = function (peer) { delete tables[peer]; emit(); };
      var tick = setInterval(emit, 2000);
      setTimeout(function () { if (!dead) { h.onStatus('online'); emit(); } }, 0);

      function make(o) {
        o = o || {};
        var used = {}, k, code;
        for (k in tables) used[tables[k].s.code] = 1;
        do { code = randomCode(); } while (used[code]);
        var free = NAMES.filter(function (n) { for (var j in tables) if (tables[j].s.name === n) return false; return true; });
        pendingHost[code] = {
          name: P.cleanText(o.name, 28) || (free.length ? free : NAMES)[Math.floor(Math.random() * (free.length || NAMES.length))],
          pub: o.pub !== false, rounds: o.rounds, turnSecs: o.turnSecs || 30, passLock: o.passLock !== false, botMs: o.botMs
        };
        h.onGo(code);
      }
      return {
        send: function (m) {
          if (dead || !m) return false;
          if (m.t === 'create') make(m.o);
          else if (m.t === 'board') h.onBoard([]);
          else if (m.t === 'quick') {
            var best = null, k;
            for (k in tables) {
              var t = tables[k].s, n = t.seats.filter(Boolean).length;
              if (n < 4 && (!best || n > best.n)) best = { code: t.code, n: n };
            }
            if (best) h.onGo(best.code); else make({ pub: true });
          }
          return true;
        },
        close: function () { dead = true; clearInterval(tick); ch.close(); }
      };
    }

    /* ---------- hosting a table ---------- */
    /* `takeover` is set when a player inherits a table: { ch, s, epoch, oldHostPid } */
    function host(code, opts, profile, h, takeover) {
      var Core = P.TableCore, myPid = pidOf(identOf(profile));
      var ch = takeover ? takeover.ch : open('table-' + code);
      var core, epoch, peers = {}, seen = {}, backup = null, snapKey = '', timer = 0, dead = false, lastSum = '', lob = null;

      if (takeover) {
        core = new Core(takeover.s);
        epoch = takeover.epoch + 1;
        var t0 = now();
        if (takeover.oldHostPid && core.seatOf(takeover.oldHostPid) >= 0) core.leave(takeover.oldHostPid, t0);   // a bot takes the old host's seat
        core.s.seats.forEach(function (seat) {             // everyone else has to check in with the new host
          if (!seat.bot && seat.pid !== myPid) { seat.on = false; seat.awayAt = t0; }
          if (seat.pid === myPid) { seat.on = true; seat.awayAt = 0; seat.afk = 0; }
        });
        core.s.closeAt = 0;
        core.drain();
        core.resume(t0);
      } else {
        core = Core.create({ code: code, name: opts.name, pub: opts.pub, rounds: opts.rounds, turnSecs: opts.turnSecs, passLock: opts.passLock, botMs: opts.botMs, aids: false }, now());
        core.join(myPid, profile, now());
        epoch = 1;
      }

      function pickBackup() {     // the next connected human after the host, in seat order
        var me = core.seatOf(myPid), found = null;
        for (var i = 1; i < 4 && !found; i++) {
          var seat = core.s.seats[(me + i + 4) % 4];
          if (seat.bot || !seat.on) continue;
          for (var p in peers) if (peers[p] === seat.pid) found = p;
        }
        return found;
      }
      function announce(force) {
        if (!lob || dead) return;
        var sum = core.summary(), key = JSON.stringify(sum);
        if (force || key !== lastSum) { lastSum = key; lob.send({ t: 'tbl', s: sum }); }
      }
      function flush() {
        if (dead) return;
        var t = now(), ev = core.drain(), p, seat;
        for (p in peers) {
          seat = core.seatOf(peers[p]);
          if (seat < 0) { ch.send({ t: 'error', code: 'idle', msg: 'You were away too long, so a bot took your seat.' }, p); delete peers[p]; continue; }
          ch.send({ t: 'state', s: core.view(seat, t), ev: ev }, p);
        }
        core.s.outbox = [];
        seat = core.seatOf(myPid);
        if (seat < 0) {             // the host dozed off and lost the seat: pass the table on
          shutdown(true);
          h.onError('You were away too long, so a bot took your seat.', 'idle');
          return;
        }
        h.onState(core.view(seat, t), ev);
        var b = pickBackup(), key = b + ':' + core.s.seq + ':' + core.s.turnAt + ':' + core.s.nextAt;
        if (b !== backup) { backup = b; ch.send({ t: 'hb', epoch: epoch, backup: backup }); }
        if (b && key !== snapKey) { snapKey = key; ch.send({ t: 'snap', epoch: epoch, s: core.s, hostPid: myPid }, b); }
        clearTimeout(timer);
        var wake = core.nextWake();
        if (wake) timer = setTimeout(function () { core.tick(now()); flush(); }, Math.max(0, wake - now()));
        announce(false);
      }

      ch.on.join = function (peer) { ch.send({ t: 'host', epoch: epoch, backup: backup }, peer); };
      function dropped(peer) {               // connection lost: hold the seat, a bot covers their turns
        var pid = peers[peer];
        if (!pid) return;
        delete peers[peer]; delete seen[peer];
        core.setOffline(pid, now()); flush();
      }
      ch.on.leave = dropped;
      ch.on.msg = function (m, peer) {
        if (dead || !m || !peer) return;
        var pid = peers[peer], r;
        seen[peer] = now();
        if (m.t === 'ping') return;
        if (m.t === 'join') {
          pid = pidOf(m.key);
          if (pid === myPid || pid === 'k') { ch.send({ t: 'error', code: 'replaced', msg: 'This table is already open in another tab or device.' }, peer); return; }
          for (var other in peers) {
            if (peers[other] === pid && other !== peer) { ch.send({ t: 'error', code: 'replaced', msg: 'This table is open in another tab or device.' }, other); delete peers[other]; }
          }
          r = core.join(pid, { name: m.name, av: m.av }, now());
          if (r.error) { ch.send({ t: 'error', code: 'full', msg: 'That table is full.' }, peer); return; }
          peers[peer] = pid; flush();
        } else if (m.t === 'act' && pid) {
          r = core.act(pid, m.m, now());
          if (r && r.error) ch.send({ t: 'error', code: 'move', msg: r.error }, peer);
          flush();
        } else if (m.t === 'leave' && pid) {
          delete peers[peer]; core.leave(pid, now()); flush();
        } else if (m.t === 'bye' && pid) {          // tab closed or reloading: hold the seat for a bit
          dropped(peer);
        } else if ((m.t === 'host' || m.t === 'hb') && m.epoch > epoch) {
          // The table carried on under a newer host while this one was out of touch.
          shutdown(false);
          h.onError('The table carried on with a new host while you were away. Rejoining…', 'moved');
        }
      };

      var beat = setInterval(function () {
        if (dead) return;
        ch.send({ t: 'hb', epoch: epoch, backup: backup });
        var t = now();                         // a player whose tab died silently stops pinging
        for (var p in peers) if (t - (seen[p] || 0) > timing.hostLost) dropped(p);
      }, timing.heartbeat);
      var again = setInterval(function () { announce(true); }, timing.announce);
      if (core.s.pub) {
        lob = open('lobby');
        lob.on.join = function (peer) { if (!dead) lob.send({ t: 'tbl', s: core.summary() }, peer); };
        lob.on.msg = function (m, peer) { if (!dead && m && m.t === 'who') lob.send({ t: 'tbl', s: core.summary() }, peer); };
      }

      /* Stop hosting. If `handOver`, give the table to the next player first. */
      function shutdown(handOver) {
        if (dead) return;
        if (handOver) {
          if (core.seatOf(myPid) >= 0) core.leave(myPid, now());
          var b = pickBackup();
          if (b) { ch.send({ t: 'snap', epoch: epoch, s: core.s, hostPid: null }, b); ch.send({ t: 'handover', epoch: epoch, to: b }); }
        }
        if (lob) lob.send({ t: 'gone' });
        dead = true;
        clearTimeout(timer); clearInterval(beat); clearInterval(again);
        var l = lob; lob = null;
        setTimeout(function () { ch.close(); if (l) l.close(); }, 250);     // let the last messages leave first
      }

      ch.send({ t: 'host', epoch: epoch, backup: null });
      if (takeover) h.onError('The host left, so you’re hosting now. Keep this tab open.', 'note');
      setTimeout(function () { if (!dead) { h.onStatus('online'); flush(); } }, 0);

      return {
        hosting: true,
        send: function (msg) {
          if (dead) return;
          var r = core.act(myPid, msg, now());
          if (r && r.error) h.onError(r.error, 'move');
          flush();
        },
        close: function () { shutdown(true); },
        kill: function () { dead = true; clearTimeout(timer); clearInterval(beat); clearInterval(again); },   // tests: a tab that just vanishes
        others: function () { return Object.keys(peers).length; }
      };
    }

    /* ---------- a seat at someone else's table ---------- */
    function guest(code, profile, h) {
      var ch = open('table-' + code);
      var hostId = null, epoch = 0, askedEpoch = -1, lastBeat = 0, backupId = null, snap = null;
      var started = now(), lostAt = 0, dead = false, live = false, role = null;

      function fail(msg, code_) { if (dead) return; stop(); h.onError(msg, code_); }
      function stop() { dead = true; clearInterval(watch); setTimeout(function () { if (!role) ch.close(); }, 250); }

      function hello(peer, m) {
        if (typeof m.epoch !== 'number' || m.epoch < epoch) return;
        if (m.epoch > epoch || !hostId) { hostId = peer; epoch = m.epoch; snap = null; }
        if (peer !== hostId) return;
        var wasLost = !!lostAt;
        lastBeat = now(); lostAt = 0; backupId = m.backup || null;
        // sit down with a new host, or check back in after a scare
        if (askedEpoch !== epoch || wasLost) { askedEpoch = epoch; ch.send({ t: 'join', key: identOf(profile), name: profile.name, av: profile.av }, hostId); }
      }
      function hostLost() {
        if (dead || lostAt) return;
        var mine = backupId === ch.selfId && snap;
        hostId = null;
        if (mine) return promote(snap.hostPid);
        lostAt = now(); live = false;
        h.onStatus('reconnecting');
      }
      /* This player inherits the table and becomes its host. */
      function promote(oldHostPid) {
        dead = true; clearInterval(watch);
        ch.on = {};
        role = host(code, null, profile, h, { ch: ch, s: snap.s, epoch: epoch, oldHostPid: oldHostPid });
      }

      ch.on.msg = function (m, peer) {
        if (dead || !m || !peer) return;
        if (m.t === 'host' || m.t === 'hb') return hello(peer, m);
        if (peer !== hostId) return;
        if (m.t === 'state') {
          if (!live) { live = true; h.onStatus('online'); }
          h.onState(m.s, m.ev || []);
        } else if (m.t === 'snap') snap = m;
        else if (m.t === 'handover') {
          if (m.to === ch.selfId && snap) promote(null);
          else { hostId = null; lostAt = now(); live = false; h.onStatus('reconnecting'); }
        } else if (m.t === 'error') {
          if (FATAL[m.code]) fail(m.msg, m.code); else h.onError(m.msg, m.code);
        }
      };
      ch.on.join = function () { /* the host introduces itself */ };
      ch.on.leave = function (peer) { if (peer === hostId) hostLost(); };

      var lastPing = 0;
      var watch = setInterval(function () {
        if (dead) return;
        var t = now();
        if (hostId && t - lastPing >= timing.heartbeat) { lastPing = t; ch.send({ t: 'ping' }, hostId); }
        if (hostId && t - lastBeat > timing.hostLost) hostLost();
        else if (lostAt && t - lostAt > timing.recover) fail('The host left and nobody could take over the table.', 'gone');
        else if (!hostId && !lostAt && t - started > timing.connect) fail('Couldn’t reach that table. It may have closed, or a network in between is blocking direct connections.', 'gone');
      }, Math.min(1000, timing.heartbeat));
      setTimeout(function () { if (!dead) h.onStatus('connecting'); }, 0);

      return {
        get hosting() { return !!role; },
        send: function (msg) {
          if (role) return role.send(msg);
          if (dead) return;
          if (!hostId) return h.onError('Reconnecting… try again in a second.', 'net');
          ch.send({ t: 'act', m: msg }, hostId);
        },
        close: function () {
          if (role) return role.close();
          if (hostId) ch.send({ t: 'leave' }, hostId);
          stop();
        },
        bye: function () { if (!role && hostId && !dead) ch.send({ t: 'bye' }, hostId); },
        kill: function () { if (role) role.kill(); dead = true; clearInterval(watch); },
        others: function () { return role ? role.others() : 0; }
      };
    }

    /* Host a table this player just opened, or join one by its code. */
    function online(code, profile, h) {
      var o = pendingHost[code];
      delete pendingHost[code];
      var s = o ? host(code, o, profile, h) : guest(code, profile, h);
      s.solo = false;
      return s;
    }

    return { lobby: lobby, online: online, host: host, guest: guest };
  }

  var shared = null;
  P.P2P = {
    timing: timing,
    create: create,
    /* True when this browser can do player-hosted tables at all. */
    available: function () { return !!(root.Trystero && root.RTCPeerConnection && root.WebSocket); },
    get: function () { return shared || (shared = create(trysteroTransport)); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
