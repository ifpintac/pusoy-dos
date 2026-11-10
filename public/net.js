/* Pusoy Dos — connections.
 * Three things the screen can talk to, all with the same shape:
 *   Net.solo(...)    a table that lives in this browser tab
 *   Net.online(...)  a seat at a live table
 *   Net.lobby(...)   the list of live tables
 *
 * Live tables work one of two ways, chosen in config.js:
 *   player-hosted (the default)  no server; see p2p.js
 *   referee server               server.js on Cloudflare; the server holds the cards
 */
(function (root) {
  'use strict';
  var P = (root.Pusoy = root.Pusoy || {});

  function setting() { return String(root.PUSOY_SERVER || '').trim().replace(/\/+$/, ''); }

  /* 'p2p' = player-hosted, 'server' = referee server, 'off' = solo only. */
  function mode() {
    var cfg = setting();
    if (cfg === 'off') return 'off';
    if (cfg) return serverBase() ? 'server' : 'off';
    return P.P2P && P.P2P.available() ? 'p2p' : 'off';
  }

  function serverBase() {
    var cfg = setting(), loc = root.location;
    if (!cfg || cfg === 'off') return null;
    if (cfg !== 'same') return cfg.replace(/^http/i, 'ws');
    if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
      return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host;
    }
    return null;
  }

  /* ---------- solo ---------- */
  function solo(opts, profile, h) {
    var core = P.TableCore.create({
      code: 'SOLO', name: 'Solo table', rounds: opts.rounds, turnSecs: 0,
      passLock: opts.passLock !== false, manualNext: true, aids: true, botMs: opts.botMs || [750, 1400]
    }, Date.now());
    var timer = 0, dead = false;
    core.join('me', profile, Date.now());

    function flush() {
      if (dead) return;
      var ev = core.drain();
      h.onState(core.view(0, Date.now()), ev);
      clearTimeout(timer);
      var wake = core.nextWake();
      if (wake) timer = setTimeout(function () { core.tick(Date.now()); flush(); }, Math.max(0, wake - Date.now()));
    }
    setTimeout(function () { if (h.onStatus) h.onStatus('online'); flush(); }, 0);

    return {
      solo: true,
      send: function (msg) {
        if (dead) return;
        var r = core.act('me', msg, Date.now());
        if (r && r.error && h.onError) h.onError(r.error, 'move');
        flush();
      },
      close: function () { dead = true; clearTimeout(timer); }
    };
  }

  /* ---------- a socket that keeps itself alive ---------- */
  function socket(makeUrl, h) {
    var ws = null, dead = false, tries = 0, ping = 0, retry = 0, everOpen = false;

    function connect() {
      if (dead) return;
      var url = makeUrl();
      if (!url) { h.status('offline'); return; }
      h.status(everOpen ? 'reconnecting' : 'connecting');
      try { ws = new WebSocket(url); } catch (e) { again(); return; }
      ws.onopen = function () {
        tries = 0; everOpen = true;
        h.status('online');
        clearInterval(ping);
        ping = setInterval(function () { if (ws && ws.readyState === 1) ws.send('ping'); }, 25000);
      };
      ws.onmessage = function (e) {
        if (e.data === 'pong') return;
        var m; try { m = JSON.parse(e.data); } catch (err) { return; }
        h.message(m);
      };
      ws.onclose = function (e) {
        clearInterval(ping);
        if (dead) return;
        if (h.closed && h.closed(e.code) === false) { dead = true; return; }  // server said don't come back
        again();
      };
      ws.onerror = function () { /* onclose follows */ };
    }
    function again() {
      if (dead) return;
      tries++;
      if (h.giveUpAfter && tries > h.giveUpAfter) { dead = true; h.status('offline'); return; }
      h.status(everOpen ? 'reconnecting' : 'offline');
      retry = setTimeout(connect, Math.min(8000, 600 * Math.pow(1.6, tries)));
    }
    connect();
    return {
      send: function (m) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; },
      close: function () { dead = true; clearTimeout(retry); clearInterval(ping); if (ws) { try { ws.close(1000); } catch (e) { /* closed */ } } },
      retry: function () { if (dead) { dead = false; tries = 0; } clearTimeout(retry); if (!ws || ws.readyState > 1) connect(); }
    };
  }

  /* ---------- a seat at a live table ---------- */
  function online(code, profile, h) {
    if (mode() === 'p2p') return P.P2P.get().online(code, profile, h);
    var base = serverBase();
    var sock = socket(function () {
      return base && base + '/api/table/' + encodeURIComponent(code) +
        '?key=' + encodeURIComponent(profile.key) + '&name=' + encodeURIComponent(profile.name) + '&av=' + profile.av;
    }, {
      giveUpAfter: 12,
      status: function (s) { if (h.onStatus) h.onStatus(s); },
      message: function (m) {
        if (m.t === 'state') h.onState(m.s, m.ev || []);
        else if (m.t === 'error' && h.onError) h.onError(m.msg, m.code);
      },
      closed: function (code) {
        // 4004 table gone, 4005 full, 4006 idle, 4008 opened elsewhere, 4001 bad key
        if (code >= 4001 && code <= 4008) {
          if (code === 4008 && h.onError) h.onError('This table is open in another tab or device.', 'replaced');
          if (h.onStatus) h.onStatus('closed');
          return false;
        }
      }
    });
    return {
      solo: false,
      send: function (msg) { if (!sock.send(msg) && h.onError) h.onError('Reconnecting… try again in a second.', 'net'); },
      close: function () { sock.send({ t: 'leave' }); setTimeout(sock.close, 150); }
    };
  }

  /* ---------- the list of live tables ---------- */
  function lobby(h) {
    if (mode() === 'p2p') return P.P2P.get().lobby(h);
    var base = serverBase();
    var sock = socket(function () { return base && base + '/api/lobby'; }, {
      status: function (s) { h.onStatus(s); },
      message: function (m) {
        if (m.t === 'lobby') h.onLobby(m);
        else if (m.t === 'go') h.onGo(m.code);
        else if (m.t === 'board') h.onBoard(m.top);
        else if (m.t === 'error') h.onError(m.msg);
      }
    });
    return sock;
  }

  P.Net = { mode: mode, serverBase: serverBase, solo: solo, online: online, lobby: lobby };
})(typeof globalThis !== 'undefined' ? globalThis : this);
