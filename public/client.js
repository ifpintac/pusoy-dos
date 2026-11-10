/* Pusoy Dos — the screen: home, table, cards, sounds, and the arcade polish.
 * It draws whatever view the table sends (solo or live) and sends back
 * { t: 'play' | 'pass' | 'start' | 'next' | 'chat' } messages. */
(function () {
  'use strict';
  var P = window.Pusoy, E = P.Engine, Bot = P.Bot, Net = P.Net, FX = P.FX;
  var $ = function (id) { return document.getElementById(id); };

  var COLORS = ['#EF6257', '#4DA6E0', '#F5A742', '#5FC592', '#A58AE6', '#EF8FB3'];
  var COLOR_NAMES = ['Coral', 'Blue', 'Amber', 'Green', 'Purple', 'Pink'];
  var QUICK = ['Nice!', 'Ouch!', 'Wow!', 'Hurry up!', 'No way!', 'GG'];
  var EMOJI = ['👍', '😂', '😱', '🔥', '😭', '👏'];
  var SHOUT = { straight: 'Straight!', flush: 'Flush!', fullhouse: 'Full house!', quads: 'Four of a kind!', straightflush: 'Straight flush!' };
  var CHIP = { pair: 'Pair', triple: 'Triple', straight: 'Straight', flush: 'Flush', fullhouse: 'Full house', quads: 'Four', straightflush: 'Str. flush' };
  var CHIP_ORDER = ['pair', 'triple', 'straight', 'flush', 'fullhouse', 'quads', 'straightflush'];

  /* ---------------------------------------------------------------- saved settings */

  function randomKey() {
    var a = new Uint8Array(18), s = '';
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }
  var me = { name: '', av: Math.floor(Math.random() * 6), key: randomKey(), sound: true, sort: 'rank', rounds: 5, passLock: true, bots: 'normal', lite: false };
  try {
    var saved = JSON.parse(localStorage.getItem('pusoy2') || 'null');
    if (saved && typeof saved === 'object') for (var k in me) if (saved[k] !== undefined && typeof saved[k] === typeof me[k]) me[k] = saved[k];
  } catch (e) { /* private mode: fine, nothing is remembered */ }
  if (Bot.LEVELS.indexOf(me.bots) < 0) me.bots = 'normal';
  function save() { try { localStorage.setItem('pusoy2', JSON.stringify(me)); } catch (e) { /* ignore */ } }
  save();
  // Each browser tab is its own player at player-hosted tables, so you can try a
  // table by yourself in two windows. The id survives a reload of that tab.
  var tabId = '';
  try {
    tabId = sessionStorage.getItem('pusoyTab') || '';
    if (!tabId) { tabId = randomKey().slice(0, 8); sessionStorage.setItem('pusoyTab', tabId); }
  } catch (e) { tabId = randomKey().slice(0, 8); }
  function profile() {
    var name = P.cleanText(me.name, 16) || 'Player ' + (parseInt(me.key.slice(0, 4), 16) % 900 + 100);
    return { name: name, av: me.av, key: me.key, tab: tabId };
  }
  function setHash(code) {
    try { history.replaceState(null, '', code ? '#' + code : location.pathname + location.search); }
    catch (e) { try { location.hash = code || ''; } catch (e2) { /* opened from a file: no address to update */ } }
  }

  /* ---------------------------------------------------------------- sound: little square-wave bleeps */

  var actx = null;
  // Browsers only allow sound and vibration after the first tap or key press.
  function touched() { var ua = navigator.userActivation; return !ua || ua.hasBeenActive; }
  function audio() {
    if (!me.sound || !touched()) return null;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { return null; }
    return actx;
  }
  function note(freq, dur, type, vol, when, slide) {
    var a = audio(); if (!a) return;
    var t = a.currentTime + (when || 0), o = a.createOscillator(), g = a.createGain();
    o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.06, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, when, freq) {
    var a = audio(); if (!a) return;
    var t = a.currentTime + (when || 0), len = Math.floor(a.sampleRate * dur);
    var buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    var src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq || 1800; f.Q.value = 0.8; g.gain.value = vol || 0.3;
    src.connect(f); f.connect(g); g.connect(a.destination); src.start(t);
  }
  var SCALE = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.7];
  var sfx = {
    pick: function (n) { note(SCALE[Math.max(0, Math.min(6, (n || 1) - 1))], 0.07, 'square', 0.05); },
    drop: function () { note(330, 0.06, 'square', 0.04, 0, 240); },
    ui: function () { note(740, 0.04, 'square', 0.04); },
    slam: function (power) {
      note(170 + power * 12, 0.16 + power * 0.04, 'sine', 0.3, 0, 46);
      noise(0.07, 0.3 + power * 0.08, 0, 2200);
    },
    combo: function (tier) {
      var seq = [[659, 880], [659, 784, 988], [523, 659, 784, 1047], [523, 659, 784, 1047, 1319], [523, 659, 784, 1047, 1319, 1568]][Math.max(0, Math.min(4, tier - 1))];
      seq.forEach(function (f, i) { note(f, 0.11, 'square', 0.055, 0.05 + i * 0.065); });
    },
    pass: function () { note(392, 0.07, 'square', 0.05); note(262, 0.11, 'square', 0.05, 0.07); },
    turn: function () { note(659, 0.08, 'triangle', 0.13); note(988, 0.14, 'triangle', 0.13, 0.08); },
    nope: function () { note(140, 0.16, 'sawtooth', 0.06); },
    tick: function (hi) { note(hi ? 1760 : 1320, 0.04, 'square', 0.045); },
    clear: function () { noise(0.22, 0.18, 0, 900); note(988, 0.06, 'square', 0.05, 0.1); note(1319, 0.14, 'square', 0.05, 0.16); },
    deal: function () { for (var i = 0; i < 13; i++) noise(0.03, 0.16, 0.12 + i * 0.045, 3000); },
    last: function () { note(880, 0.09, 'square', 0.05); note(660, 0.09, 'square', 0.05, 0.1); note(880, 0.09, 'square', 0.05, 0.2); },
    count: function () { note(1568, 0.025, 'square', 0.03); },
    // a 2 hits the table: a quick sparkle, one more note per 2
    dos: function (n) { [1047, 1319, 1568, 2093, 2637].slice(0, 3 + Math.min(2, n - 1)).forEach(function (f, i) { note(f, 0.09, 'square', 0.05, 0.03 + i * 0.05); }); note(262, 0.25, 'triangle', 0.12, 0.03); },
    // the 2 of diamonds: wind-up while it hangs in the air...
    charge: function () { note(180, 0.72, 'sawtooth', 0.045, 0, 1500); note(90, 0.72, 'triangle', 0.1, 0, 400); },
    // ...then the drop
    bigdos: function () {
      note(130, 0.6, 'sine', 0.4, 0, 30); noise(0.35, 0.45, 0, 700); noise(0.12, 0.3, 0, 3200);
      [523, 659, 784, 1047, 1319, 1568, 2093].forEach(function (f, i) { note(f, 0.1, 'square', 0.055, 0.08 + i * 0.055); });
      note(1047, 0.5, 'square', 0.05, 0.5); note(1568, 0.5, 'square', 0.045, 0.5); note(2093, 0.55, 'triangle', 0.08, 0.5);
    },
    win: function () { [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { note(f, i > 4 ? 0.3 : 0.11, 'square', 0.06, i * 0.1); }); },
    lose: function () { [392, 330, 262].forEach(function (f, i) { note(f, 0.22, 'triangle', 0.1, i * 0.17); }); }
  };
  function buzz(ms) { try { if (me.sound && navigator.vibrate && touched()) navigator.vibrate(ms); } catch (e) { /* no haptics */ } }

  /* ---------------------------------------------------------------- small helpers */

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function initial(name) { return esc((String(name).trim()[0] || '?').toUpperCase()); }
  function suitSvg(s) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#suit' + s + '"/></svg>'; }
  function cardHtml(id, tag, extra) {
    var r = id >> 2, s = id & 3;
    return '<' + tag + ' class="card s' + s + (s >= 2 ? ' red' : '') + (r === 7 ? ' r10' : '') + (r === 12 ? ' two' : '') + (id === 51 ? ' top' : '') + (extra ? ' ' + extra : '') + '" data-id="' + id + '"' +
      (tag === 'button' ? ' type="button" aria-pressed="false" aria-label="' + E.cardName(id) + '"' : '') + '>' +
      '<span class="idx"><b>' + E.RANKS[r] + '</b>' + suitSvg(s) + '</span><span class="pip">' + suitSvg(s) + '</span></' + tag + '>';
  }
  function mini(ids, cls) {
    return '<span class="mini ' + (cls || '') + '">' + ids.map(function (id) { return cardHtml(id, 'span'); }).join('') + '</span>';
  }
  function signed(n) { return n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0'; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function color(av) { return COLORS[(av | 0) % 6]; }

  function toast(text, ms) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    var box = $('toasts');
    // at the table, sit just above your hand so the seats stay readable
    box.style.top = fieldEl && !$('game').hidden ? Math.round(fieldEl.getBoundingClientRect().bottom - 56) + 'px' : '';
    while (box.children.length > 1) box.removeChild(box.firstChild);
    box.appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 320); }, ms || 2400);
  }
  function openDialog(d) { if (!d.open) d.showModal(); }
  function closeDialog(d) { if (d.open) d.close(); }

  /* Roll a number up (or down) to its final value, arcade-score style. */
  function countUp(el, from, to, ms, delay) {
    el.textContent = signed(from);
    if (from === to || FX.isCalm()) { el.textContent = signed(to); return; }
    setTimeout(function () {
      var t0 = performance.now(), lastShown = from;
      (function step(t) {
        if (!el.isConnected) return;
        var k = Math.min(1, (t - t0) / ms), v = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
        if (v !== lastShown) { lastShown = v; el.textContent = signed(v); sfx.count(); }
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    }, delay || 0);
  }

  /* ================================================================ HOME */

  var lobby = null, lobbyState = 'connecting', lobbyData = null, pendingGo = false;

  function buildBackdrop() {
    var html = '';
    for (var i = 0; i < 6; i++) {
      var size = 40 + Math.random() * 90, dur = 22 + Math.random() * 26;
      html += '<svg viewBox="0 0 24 24" style="left:' + (Math.random() * 100).toFixed(1) + '%;width:' + size.toFixed(0) + 'px;height:' + size.toFixed(0) +
        'px;animation-duration:' + dur.toFixed(1) + 's;animation-delay:-' + (Math.random() * dur).toFixed(1) + 's"><use href="#suit' + (i % 4) + '"/></svg>';
    }
    $('bg').innerHTML = html;
  }

  function buildHome() {
    var i = 0;
    $('logo').innerHTML = ['Pusoy', 'Dos'].map(function (word) {
      return '<span class="row" aria-hidden="true">' + word.split('').map(function (ch) { return '<span class="l" style="--i:' + (i++) + '">' + ch + '</span>'; }).join('') + '</span>';
    }).join('');
    // lowest card to highest
    var fan = [0, 18, 34, 45, 51], n = fan.length;
    $('hero-cards').innerHTML = fan.map(function (id, j) {
      return cardHtml(id, 'span').replace('class="card', 'style="--a:' + ((j - (n - 1) / 2) * 9) + 'deg;--i:' + j + '" class="card');
    }).join('');

    $('name').value = me.name;
    $('name').addEventListener('input', function () { me.name = this.value; save(); });
    $('swatches').innerHTML = COLORS.map(function (c, j) {
      return '<button type="button" role="radio" aria-checked="' + (j === me.av) + '" aria-label="' + COLOR_NAMES[j] + '" style="--c:' + c + '" data-av="' + j + '"></button>';
    }).join('');
    $('swatches').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      me.av = +b.dataset.av; save(); audio(); sfx.pick(me.av + 1);
      [].forEach.call(this.children, function (x) { x.setAttribute('aria-checked', x === b); });
    });

    $('btn-solo').addEventListener('click', function () { audio(); startSolo(); });
    $('btn-solo-opts').addEventListener('click', function () { openNew(true); });
    $('btn-quick').addEventListener('click', function () {
      audio();
      if (lobbyState !== 'online') return toast(offlineReason());
      pendingGo = true; lobby.send({ t: 'quick' });
    });
    $('btn-new').addEventListener('click', function () {
      if (lobbyState !== 'online') return toast(offlineReason());
      openNew(false);
    });
    $('btn-code').addEventListener('click', function () {
      if (Net.mode() === 'off') return toast(offlineReason());
      $('code').value = ''; openDialog($('dlg-code')); $('code').focus();
    });
    $('form-code').addEventListener('submit', function (e) {
      if (e.submitter && e.submitter.value === 'cancel') return;
      var code = $('code').value.trim().toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) { e.preventDefault(); toast('A table code is four letters.'); return; }
      joinTable(code);
    });
    $('tables').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-code]');
      if (b) { audio(); joinTable(b.dataset.code); }
    });
    $('btn-rules').addEventListener('click', showRules);
    $('btn-board').addEventListener('click', function () {
      $('board').innerHTML = '<p class="muted">' + (lobbyState === 'online' ? 'Loading…' : esc(offlineReason())) + '</p>';
      openDialog($('dlg-board'));
      if (lobbyState === 'online') lobby.send({ t: 'board' });
    });
    $('btn-sound-home').addEventListener('click', toggleSound);
    $('btn-fx-home').addEventListener('click', function () { me.lite = !me.lite; save(); renderFx(); });

    $('form-new').addEventListener('submit', function (e) {
      if (e.submitter && e.submitter.value === 'cancel') return;
      var f = e.target, rounds = +f.rounds.value, lock = $('new-lock').checked;
      me.bots = Bot.LEVELS.indexOf(f.bots.value) >= 0 ? f.bots.value : 'normal';
      if (f.dataset.solo) {
        me.rounds = rounds; me.passLock = lock; save(); renderSoloNote();
        startSolo();
      } else {
        save(); renderSoloNote();
        pendingGo = true;
        lobby.send({ t: 'create', o: { name: $('new-name').value, pub: f.pub.value === '1', rounds: rounds, turnSecs: +f.secs.value, passLock: lock, bots: me.bots } });
      }
    });
    renderSoloNote();
    renderSound();
    renderFx();
    renderLobby();
  }

  function renderSoloNote() { $('solo-note').textContent = '3 ' + me.bots + ' bots, ' + plural(me.rounds, 'round') + ', no clock.'; }
  function botsLabel(level) { return level === 'easy' ? 'Easy bots' : level === 'hard' ? 'Hard bots' : 'Normal bots'; }

  function openNew(solo) {
    var f = $('form-new');
    if (solo) f.dataset.solo = '1'; else delete f.dataset.solo;
    $('new-title').textContent = solo ? 'Solo game' : 'New table';
    $('new-ok').textContent = solo ? 'Deal me in' : 'Open table';
    $('new-name-field').hidden = $('new-pub-field').hidden = $('new-clock-field').hidden = solo;
    $('new-note').hidden = solo || Net.mode() !== 'p2p';
    $('new-bots-legend').textContent = solo ? 'Bots' : 'Bots in the open seats';
    f.bots.value = me.bots;
    if (solo) { f.rounds.value = String([3, 5, 10].indexOf(me.rounds) >= 0 ? me.rounds : 5); $('new-lock').checked = me.passLock; }
    else { $('new-name').value = ''; $('new-lock').checked = true; }
    openDialog($('dlg-new'));
  }

  function offlineReason() {
    if (Net.mode() === 'off') return 'Live tables aren’t available in this copy of the game. Solo works right here.';
    return lobbyState === 'connecting' ? 'Looking for live tables…' : 'Can’t reach the live tables right now. Solo still works.';
  }

  function connectLobby() {
    if (lobby) return;
    if (Net.mode() === 'off') { lobbyState = 'offline'; renderLobby(); return; }
    lobby = Net.lobby({
      onStatus: function (s) { lobbyState = s === 'online' ? 'online' : s === 'connecting' ? 'connecting' : 'offline'; renderLobby(); },
      onLobby: function (m) { lobbyData = m; renderLobby(); },
      onGo: function (code) { if (pendingGo) { pendingGo = false; joinTable(code); } },
      onBoard: renderBoard,
      onError: function (msg) { pendingGo = false; toast(msg); }
    });
  }
  function dropLobby() { if (lobby) { lobby.close(); lobby = null; } lobbyData = null; lobbyState = 'connecting'; }

  function renderLobby() {
    var box = $('tables'), on = $('online');
    var live = lobbyState === 'online' && lobbyData;
    var none = Net.mode() === 'off';
    $('btn-quick').disabled = $('btn-new').disabled = $('btn-code').disabled = none;
    $('btn-board').hidden = Net.mode() !== 'server';      // a hall of fame needs a referee to keep it honest
    on.className = 'online' + (live ? ' on' : '');
    on.textContent = live ? lobbyData.online + ' online' : lobbyState === 'connecting' ? 'Connecting…' : 'Offline';
    if (!live) { box.innerHTML = '<p class="empty">' + esc(offlineReason()) + '</p>'; return; }
    if (!lobbyData.tables.length) {
      box.innerHTML = '<p class="empty">' + (lobbyData.searching ? 'Looking for open tables…' : 'No open tables yet. Open one and anyone can jump in.') + '</p>';
      return;
    }
    box.innerHTML = lobbyData.tables.map(function (t) {
      var open = t.seats.filter(function (x) { return !x; }).length;
      var dots = t.seats.map(function (x) {
        return x ? '<i style="--c:' + color(x.av) + '" title="' + esc(x.name) + '">' + initial(x.name) + '</i>' : '<i class="open" title="Open seat"></i>';
      }).join('');
      var when = t.phase === 'waiting' ? 'Waiting to deal' : t.phase === 'matchEnd' ? 'Between matches' : 'Round ' + t.round + ' of ' + t.rounds;
      if (open && t.bots && t.bots !== 'normal') when += ' · ' + botsLabel(t.bots);
      return '<div class="trow"><div><div class="tn">' + esc(t.name) + '</div>' +
        '<div class="ts"><span class="dots">' + dots + '</span>' + when + '</div></div>' +
        '<button class="btn btn-play" data-code="' + esc(t.code) + '"' + (open ? '' : ' disabled') + '>' + (open ? 'Join' : 'Full') + '</button></div>';
    }).join('');
  }

  function renderBoard(top) {
    $('board').innerHTML = top && top.length ? top.map(function (p, i) {
      return '<div class="brow"><b>' + (i + 1) + '</b><span class="av" style="--c:' + color(p.av) + '">' + initial(p.name) + '</span>' +
        '<span>' + esc(p.name) + '<small>' + p.games + (p.games === 1 ? ' match' : ' matches') + ', ' + plural(p.rounds, 'round') + ' won</small></span>' +
        '<span class="w">' + plural(p.wins, 'win') + '</span></div>';
    }).join('') : '<p class="muted">Nobody yet. Win a match at a live table to get on the board.</p>';
  }

  function renderSound() {
    $('btn-sound-home').textContent = me.sound ? 'Sound on' : 'Sound off';
    $('btn-sound').classList.toggle('off', !me.sound);
    $('btn-sound').setAttribute('aria-label', me.sound ? 'Turn sound off' : 'Turn sound on');
  }
  function toggleSound() { me.sound = !me.sound; save(); renderSound(); if (me.sound) sfx.pick(3); }
  /* "Effects: light" keeps the game's moves and drops the decoration; for devices that find the full show heavy. */
  function renderFx() {
    $('btn-fx-home').textContent = me.lite ? 'Effects: light' : 'Effects: full';
    document.body.classList.toggle('lite', me.lite);
    FX.setLite(me.lite);
  }

  function showRules() {
    var c = function (rank, suit) { return E.RANKS.indexOf(rank) * 4 + suit; };
    var row = function (ids, title, sub) { return '<li>' + mini(ids) + '<span>' + title + (sub ? '<small>' + sub + '</small>' : '') + '</span></li>'; };
    $('rules').innerHTML =
      '<h3>The goal</h3><p>Everyone gets 13 cards. Be the first to play them all.</p>' +
      '<h3>Which card is higher</h3>' +
      '<p>Rank first: 3 is the lowest, then 4 up to King, Ace, and 2 on top. Same rank? The suit decides: clubs, spades, hearts, diamonds, low to high.</p>' +
      '<p>' + mini([c('3', 0)], 'inline') + ' is the lowest card in the deck and ' + mini([c('2', 3)], 'inline') + ' is the highest. ' +
        mini([c('9', 3)], 'inline') + ' beats ' + mini([c('9', 2)], 'inline') + '.</p>' +
      '<h3>What you can play</h3><ul>' +
      row([c('K', 1)], 'One card') +
      row([c('8', 0), c('8', 2)], 'A pair', 'The pair holding the higher suit wins a tie.') +
      row([c('5', 0), c('5', 1), c('5', 3)], 'Three of a kind') +
      '</ul><p>Or a five-card hand. From weakest to strongest:</p><ul>' +
      row([c('5', 1), c('6', 3), c('7', 0), c('8', 2), c('9', 1)], 'Straight', 'Five in a row. 3-4-5-6-7 is the lowest, J-Q-K-A-2 the highest. No wrapping around.') +
      row([c('4', 2), c('7', 2), c('9', 2), c('J', 2), c('A', 2)], 'Flush', 'Five of one suit. Highest card wins, then suit.') +
      row([c('6', 0), c('6', 1), c('6', 3), c('J', 1), c('J', 2)], 'Full house', 'Three of a kind plus a pair. The three decide it.') +
      row([c('10', 0), c('10', 1), c('10', 2), c('10', 3), c('4', 1)], 'Four of a kind', 'Plus any one card.') +
      row([c('7', 3), c('8', 3), c('9', 3), c('10', 3), c('J', 3)], 'Straight flush', 'A straight in one suit.') +
      '</ul>' +
      '<h3>Taking turns</h3>' +
      '<p>The lowest card always goes first: every round, whoever holds the 3 of clubs opens, and has to play it, either alone or as part of a hand.</p>' +
      '<p>On your turn, beat what’s on the table with the same number of cards, or pass. Five-card hands only answer five-card hands, and any stronger kind beats any weaker kind.</p>' +
      '<p>When you pass you sit out until the table clears. Once everyone else has passed, the last player to play clears the table and leads anything they like.</p>' +
      '<h3>The 2s</h3>' +
      '<p>The 2s (the “dos”) are the strongest cards, and the ' + mini([c('2', 3)], 'inline') + ' beats every other single card. Save them to win the lead back when it matters.</p>' +
      '<h3>Scoring</h3>' +
      '<p>The round ends the moment someone plays their last card. Everyone else pays the winner one point per card still in hand. Stuck with 10 or more? They count double. All 13? Triple. Highest total after the last round wins the match.</p>' +
      '<h3>Controls</h3>' +
      '<p>Tap cards to pick them, or drag across several. On a keyboard: <kbd>←</kbd> <kbd>→</kbd> move, <kbd>Space</kbd> picks, <kbd>Enter</kbd> plays, <kbd>P</kbd> passes, <kbd>S</kbd> sorts.</p>' +
      '<p>Solo games add three practice aids: Hint (<kbd>H</kbd>), the chips above your hand that jump straight to pairs, straights and other hands you can play, and the cards-played tracker in the top bar. At live tables those are switched off, so everyone plays on their own wits.</p>';
    openDialog($('dlg-rules'));
    $('dlg-rules').scrollTop = 0;
  }

  /* ================================================================ TABLE */

  var session = null, view = null, sel = [], kb = -1, hints = null, hintAt = -1, hintSeq = -1;
  var tableCode = '';    // the live table we're at, so we can sit back down if its host changes
  var sending = false;   // a move is on its way to the table; hold the buttons until it answers
  var clockSkew = 0, conn = 'online', resultsTimer = 0, lastTickSec = -1, shownResultSeq = -1, wasMyTurn = false;
  var seatEls = [], handEl, pileEl, fieldEl, gameEl;
  var prevCount = [-1, -1, -1, -1];
  var legalSeq = -1, legalNow = [], comboAt = {};

  function show(screen) {
    $('home').hidden = screen !== 'home';
    $('game').hidden = screen !== 'game';
    document.body.classList.toggle('in-game', screen === 'game');     // the table has no moving backdrop
    handBox = null;
  }

  function handlers() {
    return {
      onState: onState,
      onError: function (msg, code) {
        sending = false; if (view) renderStatus();
        if (code === 'move') { nope(); return toast(msg); }
        if (code === 'net') return toast(msg);
        toast(msg, 4200);
        if (code === 'note') { if (view) { renderHud(); $('waiting')._sig = ''; renderWaiting(); } return; }
        if (code === 'moved' && tableCode) return joinTable(tableCode);     // our table carried on under a new host: sit back down
        if (code === 'gone' || code === 'full' || code === 'idle' || code === 'badkey' || code === 'replaced') goHome();
      },
      onStatus: function (s) {
        conn = s;
        if (s === 'offline') { toast('Lost the connection to the table.', 4200); goHome(); }
        else if (view) renderStatus();
        else $('status').textContent = s === 'online' ? '' : 'Connecting to the table…';
      }
    };
  }

  function enterTable() {
    dropLobby();
    view = null; sel = []; kb = -1; hints = null; sending = false; shownResultSeq = -1; wasMyTurn = false; conn = 'connecting';
    prevCount = [-1, -1, -1, -1]; legalSeq = -1; legalNow = []; comboAt = {};
    $('t-round').textContent = 'Pusoy Dos'; $('t-name').textContent = '';
    $('status').textContent = 'Connecting to the table…'; $('status').className = 'status';
    handEl.innerHTML = ''; handEl._order = []; handEl._nodes = {}; pileEl.innerHTML = ''; $('pile-label').textContent = '';
    $('combos').innerHTML = ''; $('timebar').className = 'timebar';
    $('waiting').hidden = true; $('btn-invite').hidden = true; $('chat-tray').hidden = true; $('results-wrap').hidden = true;
    fieldEl.style.removeProperty('--turn');
    seatEls.forEach(function (s) { s.body.innerHTML = ''; s.body.className = 'plate'; });
    show('game');
  }

  function startSolo() {
    if (session) session.close();
    enterTable();
    setHash('');
    // add ?fast to the address to make the bots play instantly (handy when testing)
    var fast = /[?&]fast\b/.test(location.search) ? [60, 120] : null;
    session = Net.solo({ rounds: me.rounds, passLock: me.passLock, bots: me.bots, botMs: fast }, profile(), handlers());
    session.send({ t: 'start' });
  }

  function joinTable(code) {
    if (session) { try { session.close(); } catch (e) { /* already closed */ } }
    session = null;
    if (Net.mode() === 'off') { toast(offlineReason()); return; }
    enterTable();
    setHash(code);
    tableCode = code;
    session = Net.online(code, profile(), handlers());
  }

  function goHome() {
    if (session) { try { session.close(); } catch (e) { /* already closed */ } }
    session = null; view = null;
    clearTimeout(resultsTimer);
    $('results-wrap').hidden = true;
    closeDialog($('dlg-leave')); closeDialog($('dlg-seen'));
    setHash('');
    show('home');
    connectLobby();
  }

  /* ---------- state arrives ---------- */

  function onState(v, ev) {
    var first = !view;
    // Where my cards are now, so the ones I just played can fly from there. Only measured when it was my turn.
    var rects = view && view.phase === 'playing' && view.turn === view.you ? captureHandRects() : {};
    clockSkew = v.now - Date.now();
    view = v; sending = false;
    sel = sel.filter(function (id) { return v.hand.indexOf(id) >= 0; });
    if (hintSeq !== v.seq) { hints = null; hintAt = -1; }
    if (legalSeq !== v.seq) { comboAt = {}; }
    var myTurn = isMyTurn();
    if (v.phase !== 'playing') sel = [];

    var dealt = false, clear = null;
    ev.forEach(function (e) { if (e.k === 'deal') dealt = true; if (e.k === 'clear') clear = e; });

    renderHud();
    renderSeats();
    renderPile(ev, rects, clear);
    renderHand(dealt);
    renderWaiting();
    renderStatus();
    renderResults(ev, first);
    if ($('dlg-seen').open) renderSeen();
    ev.forEach(react);

    if (myTurn && !wasMyTurn) {
      sfx.turn(); buzz(20); wave();
      var st = $('status'); st.classList.remove('pop'); void st.offsetWidth; st.classList.add('pop');
    }
    wasMyTurn = myTurn;
  }

  function isMyTurn() { return !!view && view.phase === 'playing' && view.turn === view.you; }
  function seatAt(pos) { return (view.you + pos) % 4; }
  function posOf(seat) { return (seat - view.you + 4) % 4; }
  function nameOf(seat) { return seat === view.you ? 'You' : view.seats[seat].name; }
  function seatColor(seat) { return color(view.seats[seat].av); }
  function pileCenter() { var r = fieldEl.getBoundingClientRect(), p = pileEl.getBoundingClientRect(); return { x: r.left + r.width / 2, y: p.top }; }

  /* How hard a play lands: 0 a tap, 3 the whole screen jumps. */
  function powerOf(e) {
    var p = { single: 0, pair: 1, triple: 1, straight: 2, flush: 2, fullhouse: 2, quads: 3, straightflush: 3 }[e.type] || 0;
    if (e.cards.some(function (id) { return id >= 48; })) p++;      // a 2 always hits harder
    return Math.min(3, p);
  }

  function react(e) {
    var pos, c, col;
    switch (e.k) {
      case 'play':
        pos = posOf(e.seat); col = seatColor(e.seat);
        var twos = e.cards.filter(function (id) { return id >= 48; }).length, big = e.cards.indexOf(51) >= 0;
        var power = powerOf(e), tier = E.TIER[e.type] || 0;
        var land = FX.isCalm() ? 0 : big ? 780 : 300 + e.cards.length * 30;
        if (big && !FX.isCalm()) {                 // the 2 of diamonds hangs in the air first: dim the table, wind up
          sfx.charge();
          fieldEl.classList.add('spot');
          setTimeout(function () { fieldEl.classList.remove('spot'); }, 2300);
        }
        setTimeout(function () {
          if (!view) return;
          c = pileCenter();
          sfx.slam(power); buzz(10 + power * 12);
          FX.kickClass(pileEl, 'thud');
          FX.ring(c.x, c.y, col, power);
          FX.burst(c.x, c.y, { colors: [col, '#F7F1E3'], count: 8 + power * 10, speed: 200 + power * 110, size: 6 + power * 2, life: 0.5 + power * 0.12 });
          if (big) bigDos(c);
          else {
            FX.shake(gameEl, power);
            if (twos) dos(c, twos, e.cards.length < 5);
            if (tier) { banner(SHOUT[e.type], 't' + tier); sfx.combo(tier); }
            if (tier >= 4) FX.flash($('flash'), col);
          }
          if (e.left === 1 && view.phase === 'playing') {
            var sc = FX.center(seatEls[pos].el);
            FX.floatText(sc.x, sc.y - 30, 'Last card!', '#FF8F86'); sfx.last();
          }
        }, land);
        break;
      case 'pass': sfx.pass(); bubble(posOf(e.seat), 'Pass', 'pass', 1200); break;
      case 'clear':
        sfx.clear();
        pos = posOf(e.seat);
        seatEls[pos].body.classList.add('won');
        c = FX.center(seatEls[pos].el);
        FX.burst(c.x, c.y, { colors: [seatColor(e.seat), '#F7F1E3'], count: 16, speed: 240, size: 6 });
        FX.floatText(c.x, c.y - (pos === 0 ? 34 : -34), pos === 0 ? 'Your lead!' : 'Takes it', seatColor(e.seat));
        break;
      case 'deal': sfx.deal(); dealFx(); break;
      case 'chat': say(posOf(e.seat), e.text); break;
      case 'join': if (e.seat !== view.you) toast(e.name + ' joined.'); break;
      case 'leave': if (e.seat !== view.you) toast(e.name + ' left. ' + view.seats[e.seat].name + ' took the seat.'); break;
      case 'away': if (e.seat !== view.you) toast(view.seats[e.seat].name + ' lost connection.'); break;
      case 'timeout': if (e.seat === view.you) toast('Time ran out, so your turn was played for you.'); break;
      case 'roundEnd':
        var mine = e.winner === view.you, last = view.phase === 'matchEnd';
        setTimeout(function () {
          if (!view) return;
          if (mine) { banner('You win!', 'win long'); sfx.win(); FX.confetti(null, last ? 220 : 130); buzz([30, 40, 30, 40, 80]); }
          else { banner(view.seats[e.winner].name + ' wins', 't2 long'); sfx.lose(); }
        }, FX.isCalm() ? 0 : 520);
        break;
    }
  }

  /* Any 2 landing: gold sparks, and a shout when it's a single, pair or triple of them. */
  function dos(c, twos, shout) {
    sfx.dos(twos);
    FX.ring(c.x, c.y, '#F5A742', 2);
    FX.burst(c.x, c.y, { colors: ['#F5A742', '#FFD08A', '#F7F1E3'], count: 18 + twos * 10, speed: 330, size: 8, life: 0.8, up: 120 });
    if (shout) banner(['Dos!', 'Double dos!', 'Triple dos!', 'All the dos!'][Math.min(3, twos - 1)], 'dos');
  }
  /* The 2 of diamonds, the best card in the deck: everything at once. */
  function bigDos(c) {
    var f = fieldEl.getBoundingClientRect();
    sfx.bigdos(); buzz([40, 30, 40, 30, 140]);
    FX.flash($('flash'), '#F5A742');
    FX.shake(gameEl, 3);
    FX.kickClass(fieldEl, 'punch');
    FX.rays(fieldEl, c.x - f.left, c.y - f.top);
    FX.ring(c.x, c.y, '#F5A742', 3);
    setTimeout(function () { FX.ring(c.x, c.y, '#EF6257', 3); }, 110);
    setTimeout(function () { FX.ring(c.x, c.y, '#F7F1E3', 3); }, 220);
    FX.diamonds(c.x, c.y);
    banner('Diamond dos!', 'big long');
  }

  function banner(text, cls) {
    var el = $('banner');
    el.textContent = text; el.className = 'banner';
    // long shouts shrink so they never run off a phone screen
    var win = /\b(win|big)\b/.test(cls || '');
    el.style.fontSize = 'min(' + (win ? '6rem' : '4.6rem') + ', ' + ((win ? 160 : 138) / Math.max(6, text.length)).toFixed(1) + 'vw)';
    void el.offsetWidth; el.className = 'banner go ' + (cls || '');
  }
  function nope() {
    sfx.nope(); buzz(40);
    handEl.classList.remove('nope'); void handEl.offsetWidth; handEl.classList.add('nope');
  }

  /* ---------- top bar ---------- */

  function renderHud() {
    $('t-round').textContent = view.phase === 'waiting' ? 'Get ready' : 'Round ' + view.round + '/' + view.rounds;
    $('t-name').textContent = view.name + (session.solo ? ' • ' + botsLabel(view.bots) : session.hosting ? ' • you’re hosting' : '');
    var inv = $('btn-invite');
    inv.hidden = !!session.solo;
    inv.textContent = view.code;
    inv.title = 'Copy the invite link';
    $('btn-chat').hidden = !!session.solo;
    // Hint, the quick-pick chips and the cards-played tracker are practice aids: solo only.
    var aids = !!view.aids;
    $('btn-seen').hidden = !aids || view.phase === 'waiting';
    $('btn-hint').hidden = !aids;
    $('combos').hidden = !aids;
    $('game').classList.toggle('no-aids', !aids);
    if (!aids) closeDialog($('dlg-seen'));
    $('btn-sort').textContent = me.sort === 'rank' ? 'Rank' : 'Suit';
    var playing = view.phase === 'playing' && view.turn >= 0;
    if (playing) fieldEl.style.setProperty('--turn', seatColor(view.turn)); else fieldEl.style.removeProperty('--turn');
  }

  function inviteLink() { return location.origin + location.pathname + '#' + view.code; }
  function invite() {
    var url = inviteLink(), text = 'Join my Pusoy Dos table: ' + view.name;
    if (navigator.share) { navigator.share({ title: 'Pusoy Dos', text: text, url: url }).catch(function () { /* cancelled */ }); return; }
    var done = function () { toast('Invite link copied.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { toast(url, 6000); });
    else toast(url, 6000);
  }

  /* ---------- seats ---------- */

  function renderSeats() {
    var playing = view.phase === 'playing';
    var top = -1, best = 0;
    view.seats.forEach(function (x, k) { if (x.score > best) { best = x.score; top = k; } });
    for (var pos = 0; pos < 4; pos++) {
      var i = seatAt(pos), s = view.seats[i], body = seatEls[pos].body;
      var turn = playing && view.turn === i;
      var cls = 'plate' + (turn ? ' turn' : '') + (playing && s.passed ? ' passed' : '') + (!s.on ? ' off' : '') +
        (playing && s.n === 1 && pos !== 0 ? ' last' : '') + (playing && s.n <= 3 && pos !== 0 ? ' low' : '') + (turn && view.turnAt ? ' timed' : '');
      var sub, subCls = '';
      var waitingBot = view.phase === 'waiting' && s.bot;
      if (view.phase === 'waiting') sub = s.bot ? 'Open seat' : pos === 0 ? 'You' : 'Ready';
      else if (!s.on) sub = 'Away';
      else if (playing && s.passed) sub = 'Passed';
      else { sub = signed(s.score) + ' pts'; subCls = s.score > 0 ? ' up' : s.score < 0 ? ' down' : ''; }
      var bumped = playing && pos !== 0 && prevCount[i] >= 0 && prevCount[i] !== s.n;
      prevCount[i] = playing ? s.n : -1;
      body.className = cls;
      body.style.setProperty('--c', waitingBot ? '#5C7284' : color(s.av));
      body.innerHTML =
        '<span class="avatar">' + (waitingBot ? '+' : initial(s.name)) + (i === top && view.phase !== 'waiting' ? '<i class="crown" title="In the lead"></i>' : '') + '</span>' +
        '<span class="who"><span class="nm">' + esc(waitingBot ? 'Bot' : s.name) + '</span><span class="sub' + subCls + '">' + sub + '</span></span>' +
        (pos !== 0 && playing ? '<span class="cnt' + (bumped ? ' bump' : '') + '" title="' + plural(s.n, 'card') + ' left">' + s.n + '</span>' : '') +
        (pos !== 0 ? '<span class="tbar"><i></i></span>' : '');
    }
    tickClock();
  }

  function bubble(pos, text, cls, ms) {
    var b = seatEls[pos].bubble;
    b.textContent = text; b.className = 'bubble show ' + (cls || '');
    clearTimeout(b._t);
    b._t = setTimeout(function () { b.className = 'bubble ' + (cls || ''); }, ms);
  }
  function say(pos, text) {
    var isEmoji = text.length <= 4 && !/[\w!?.,]/.test(text);
    if (isEmoji) {
      var c = FX.center(seatEls[pos].el);
      FX.floatText(c.x, c.y - (pos === 0 ? 30 : -30), text, null, true);
      sfx.ui();
    } else { bubble(pos, text, '', 3200); sfx.ui(); }
  }

  /* ---------- the pile ---------- */

  function playKey(p) { return p.by + ':' + p.cards.join('.'); }

  function renderPile(ev, rects, clear) {
    var want = view.trick.concat(view.table ? [view.table] : []);
    if (view.phase !== 'playing') want = view.table ? [view.table] : [];
    var keys = want.map(playKey), have = {}, i;
    var winner = clear ? FX.center(seatEls[posOf(clear.seat)].el) : null;
    [].slice.call(pileEl.children).forEach(function (node) {
      if (node.classList.contains('gone')) return;
      if (keys.indexOf(node.dataset.key) >= 0) { have[node.dataset.key] = node; return; }
      node.classList.add('gone');
      // swept off the table, toward whoever took the trick
      var r = node.getBoundingClientRect();
      var dx = winner ? winner.x - (r.left + r.width / 2) : 0, dy = winner ? winner.y - (r.top + r.height / 2) : -40;
      if (node.animate && !FX.isCalm()) {
        var from = getComputedStyle(node).transform;
        node.animate([{ transform: from, opacity: 1 }, { transform: 'translate(' + dx + 'px,' + dy + 'px) ' + from + ' scale(.2) rotate(40deg)', opacity: 0 }],
          { duration: 380, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' }).onfinish = function () { node.remove(); };
      } else node.remove();
    });
    var played = null;
    ev.forEach(function (e) { if (e.k === 'play') played = e; });
    want.forEach(function (p, idx) {
      var key = keys[idx], node = have[key], fresh = !node;
      if (fresh) {
        node = document.createElement('div');
        node.dataset.key = key;
        var h = 0; for (i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 997;
        node.style.setProperty('--rot', ((h % 13) - 6) + 'deg');
        node.innerHTML = p.cards.map(function (id) { return cardHtml(id, 'span'); }).join('');
        pileEl.appendChild(node);
      }
      var age = want.length - 1 - idx;
      node.className = 'play' + (age === 1 ? ' old' : age >= 2 ? ' older' : '');
      node.style.zIndex = idx + 1;
      if (fresh && age === 0 && played && playKey({ by: played.seat, cards: played.cards }) === key) flyIn(node, p, rects);
    });
    var label = $('pile-label');
    if (view.phase === 'playing' && view.table) {
      label.style.setProperty('--c', seatColor(view.table.by));
      label.innerHTML = '<b>' + esc(nameOf(view.table.by)) + '</b> ' + esc(view.table.name);
    } else label.textContent = '';
  }

  function flyIn(node, play, rects) {
    if (!node.animate || FX.isCalm()) return;
    var mine = play.by === view.you;
    var src = seatEls[posOf(play.by)].el.getBoundingClientRect();
    [].forEach.call(node.children, function (card, i) {
      var to = card.getBoundingClientRect(), from = mine && rects[card.dataset.id];
      var fx = from ? from.left + from.width / 2 : src.left + src.width / 2;
      var fy = from ? from.top + from.height / 2 : src.top + src.height / 2;
      var sc = from ? from.width / to.width : 0.4;
      var dx = fx - to.left - to.width / 2, dy = fy - to.top - to.height / 2;
      if (+card.dataset.id === 51) {
        // the 2 of diamonds: spins up big, hangs for a beat, then slams down
        card.style.zIndex = 9;
        card.animate([
          { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sc + ') rotate(0deg)', opacity: mine ? 1 : 0.4, offset: 0 },
          { transform: 'translate(0,-58px) scale(2.1) rotate(360deg)', opacity: 1, offset: 0.42 },
          { transform: 'translate(0,-70px) scale(2.3) rotate(366deg)', opacity: 1, offset: 0.8 },
          { transform: 'translate(0,5px) scale(.88) rotate(360deg)', offset: 0.93 },
          { transform: 'translate(0,0) scale(1) rotate(360deg)', opacity: 1, offset: 1 }
        ], { duration: 840, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'backwards' }).onfinish = function () { card.style.zIndex = ''; };
        return;
      }
      card.animate([
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sc + ') rotate(' + (mine ? 0 : -30) + 'deg)', opacity: mine ? 1 : 0.3, offset: 0 },
        { transform: 'translate(0,-14px) scale(1.22) rotate(4deg)', opacity: 1, offset: 0.72 },
        { transform: 'translate(0,3px) scale(.94)', offset: 0.88 },
        { transform: 'none', opacity: 1, offset: 1 }
      ], { duration: 360, delay: i * 30, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'backwards' });
    });
  }

  /* Cards shoot out from the middle of the table to each seat. */
  function dealFx() {
    if (FX.isCalm() || !document.body.animate) return;
    var f = fieldEl.getBoundingClientRect(), cx = f.left + f.width / 2, cy = f.top + f.height / 2;
    for (var k = 0; k < 20; k++) {
      (function (k) {
        var pos = k % 4, to = FX.center(pos === 0 ? handEl : seatEls[pos].el);
        var d = document.createElement('div');
        d.className = 'dealcard';
        d.style.left = cx + 'px'; d.style.top = cy + 'px';
        document.body.appendChild(d);
        d.animate([{ transform: 'translate(-50%,-50%) scale(1) rotate(0deg)', opacity: 1 },
          { transform: 'translate(calc(-50% + ' + (to.x - cx) + 'px), calc(-50% + ' + (to.y - cy) + 'px)) scale(.5) rotate(' + (pos % 2 ? 200 : -200) + 'deg)', opacity: 0.2 }],
          { duration: 360, delay: k * 42, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'both' }).onfinish = function () { d.remove(); };
      })(k);
    }
  }

  /* ---------- your hand ---------- */

  var handBox = null;          // cached size of the hand area and of one card

  function captureHandRects() {
    var r = {};
    if (!handEl) return r;
    [].forEach.call(handEl.children, function (c) { r[c.dataset.id] = c.getBoundingClientRect(); });
    return r;
  }

  function renderHand(dealt) {
    var ids = E.sortHand(view.hand, me.sort), nodes = {};
    [].slice.call(handEl.children).forEach(function (c) {
      if (ids.indexOf(+c.dataset.id) < 0) c.remove(); else nodes[c.dataset.id] = c;
    });
    ids.forEach(function (id) {
      if (!nodes[id]) {
        var holder = document.createElement('div');
        holder.innerHTML = cardHtml(id, 'button');
        nodes[id] = holder.firstChild;
      }
    });
    // keep DOM order = visual order (tab order), but only touch the DOM when it actually changed
    var cur = [].map.call(handEl.children, function (c) { return +c.dataset.id; });
    if (cur.join() !== ids.join()) ids.forEach(function (id) { handEl.appendChild(nodes[id]); });
    handEl._order = ids; handEl._nodes = nodes;
    handEl.classList.toggle('idle', view.phase === 'playing' && !isMyTurn());
    layoutHand();
    if (dealt && handEl.animate && !FX.isCalm()) {
      ids.forEach(function (id, i) {
        nodes[id].animate([{ translate: '0 80px', scale: '.5', opacity: 0 }, { translate: '0 -12px', scale: '1.08', opacity: 1, offset: 0.7 }, { translate: '0 0', scale: '1', opacity: 1 }],
          { duration: 320, delay: 260 + i * 45, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'backwards' });
      });
    }
  }

  function layoutHand() {
    var ids = handEl._order || [], nodes = handEl._nodes || {}, n = ids.length;
    if (!n) return;
    // Measuring forces the browser to lay the page out, so the two sizes are read once and kept until the window changes.
    if (!handBox || !handBox.W) handBox = { W: handEl.clientWidth, cw: nodes[ids[0]].offsetWidth || 60 };
    var W = handBox.W, cw = handBox.cw;
    var step = n > 1 ? Math.min(cw * 0.8, (W - cw) / (n - 1)) : 0;
    var x0 = (W - (cw + step * (n - 1))) / 2;
    var fan = Math.min(1, W / 700);
    ids.forEach(function (id, i) {
      var t = n > 1 ? i / (n - 1) - 0.5 : 0, on = sel.indexOf(id) >= 0;
      var y = t * t * 26 * fan * (n / 13) - (on ? cw * 0.28 : 0);
      var c = nodes[id];
      c.style.transform = 'translate(' + (x0 + i * step) + 'px,' + y + 'px) rotate(' + (t * 9 * fan * (n / 13)) + 'deg)' + (on ? ' scale(1.04)' : '');
      c.style.zIndex = i + 1;
      c.classList.toggle('sel', on);
      c.classList.toggle('kb', i === kb);
      c.setAttribute('aria-pressed', on);
    });
  }

  /* A ripple through your cards when it becomes your turn. */
  function wave() {
    if (FX.isCalm() || !handEl.animate) return;
    (handEl._order || []).forEach(function (id, i) {
      handEl._nodes[id].animate([{ translate: '0 0' }, { translate: '0 -14px' }, { translate: '0 0' }], { duration: 300, delay: i * 28, easing: 'ease-out' });
    });
  }

  function setSel(id, on) {
    var i = sel.indexOf(id);
    if (on && i < 0) { sel.push(id); sfx.pick(sel.length); buzz(8); }
    else if (!on && i >= 0) { sel.splice(i, 1); sfx.drop(); }
    else return;
    hintAt = -1;
    layoutHand(); renderStatus();
  }
  /* Answering a pair or three of a kind: tapping one card picks up its partners. */
  function pickMates(id) {
    var t = view.table, need = t && isMyTurn() && sel.length === 1 && (t.size === 2 || t.size === 3) ? t.size : 0;
    if (!need) return;
    var mates = view.hand.filter(function (x) { return x !== id && (x >> 2) === (id >> 2); }).sort(function (a, b) { return b - a; });
    if (mates.length < need - 1) return;
    sel = sel.concat(mates.slice(0, need - 1));
    sfx.pick(sel.length);
    layoutHand(); renderStatus();
  }

  /* ---------- status line, quick picks and buttons ---------- */

  function legal() {
    if (!isMyTurn()) return [];
    if (legalSeq !== view.seq) { legalSeq = view.seq; legalNow = E.legalPlays(view.hand, view.table, view.mustOpen); }
    return legalNow;
  }

  function renderCombos(selType) {
    var box = $('combos');
    if (!isMyTurn() || !view.aids) { if (box.firstChild) box.innerHTML = ''; box._sig = ''; return; }
    var by = {};
    legal().forEach(function (h) { (by[h.type] = by[h.type] || []).push(h); });
    var types = CHIP_ORDER.filter(function (t) { return by[t]; });
    var sig = view.seq + ':' + types.map(function (t) { return t + by[t].length; }).join(',');
    if (box._sig !== sig) {
      box._sig = sig;
      box.innerHTML = types.map(function (t, i) {
        return '<button type="button" class="combo" style="--i:' + i + '" data-type="' + t + '">' + CHIP[t] + '<b>' + by[t].length + '</b></button>';
      }).join('');
    }
    [].forEach.call(box.children, function (b) { b.classList.toggle('on', b.dataset.type === selType); });
  }

  function renderStatus() {
    if (!view) return;
    var st = $('status'), play = $('btn-play'), pass = $('btn-pass'), hint = $('btn-hint');
    var myTurn = isMyTurn(), text = '', cls = '', canPlay = false, label = 'Play', selType = '';
    var my = view.seats[view.you];
    var stuck = myTurn && !!view.table && !legal().length;

    if (conn === 'reconnecting' || conn === 'connecting') { text = 'Reconnecting…'; cls = 'bad'; }
    else if (view.phase !== 'playing') text = '';
    else if (sel.length && myTurn) {
      var res = E.check(sel, view.table, view.mustOpen);
      if (res.combo) selType = res.combo.type;
      if (res.ok) { canPlay = true; text = cap(res.combo.name); cls = 'good'; label = sel.length === 1 ? 'Play' : 'Play ' + (CHIP[res.combo.type] || '').toLowerCase(); }
      else { text = res.reason; cls = 'bad'; }
    } else if (myTurn) {
      cls = 'you';
      if (!view.table) text = view.mustOpen ? 'You open! Play the 3' + E.SUITS[0] + ', alone or in a hand.' : 'Your lead! Play anything.';
      else if (stuck) text = 'Nothing beats that. Pass.';
      else text = 'Your turn! Beat the ' + view.table.name + ' or pass.';
    } else if (my.passed && view.table) text = 'You passed. Back in when the table clears.';
    else if (view.turn >= 0) text = view.seats[view.turn].name + '’s turn';

    st.textContent = text; st.className = 'status ' + cls + (st.classList.contains('pop') ? ' pop' : '');
    play.disabled = !canPlay || sending; play.textContent = label;
    play.classList.toggle('ready', canPlay && !sending);
    handEl.classList.toggle('ok', canPlay);
    pass.disabled = !(myTurn && view.table) || sending;
    pass.classList.toggle('nudge', stuck && !sending);
    hint.disabled = !myTurn || sending;
    renderCombos(selType);
  }

  function doPlay() {
    if (!isMyTurn() || !sel.length || sending) return;
    var res = E.check(sel, view.table, view.mustOpen);
    if (!res.ok) { nope(); toast(res.reason); return; }
    sending = true; renderStatus();
    session.send({ t: 'play', cards: sel.slice() });
  }
  function doPass() {
    if (!isMyTurn() || !view.table || sending) return;
    sel = []; sending = true; layoutHand(); renderStatus();
    session.send({ t: 'pass' });
  }
  function doHint() {
    if (!isMyTurn() || sending || !view.aids) return;
    if (!hints || hintSeq !== view.seq) {
      hintSeq = view.seq; hintAt = -1;
      var all = legal();
      // the hint is always the strongest brain, whatever level the bots are playing at
      var best = Bot.choose({ hand: view.hand, table: view.table, seat: view.you, mustOpen: view.mustOpen,
        passed: view.seats.map(function (s) { return s.passed; }), counts: view.seats.map(function (s) { return s.n; }),
        seen: view.seen || [], passLock: view.passLock, level: 'hard', think: Net.THINK_MS });
      var front = [];
      if (best) front.push(best.slice().sort(function (a, b) { return a - b; }).join(','));
      if (!view.table && !view.mustOpen) Bot.plan(view.hand).groups.forEach(function (g) { front.push(g.cards.join(',')); });
      var seen = {};
      hints = [];
      front.forEach(function (key) {
        if (seen[key]) return;
        var hit = all.filter(function (h) { return h.cards.join(',') === key; })[0];
        if (hit) { seen[key] = 1; hints.push(hit); }
      });
      all.forEach(function (h) { var key = h.cards.join(','); if (!seen[key]) { seen[key] = 1; hints.push(h); } });
    }
    if (!hints.length) { nope(); var st = $('status'); st.classList.remove('pop'); void st.offsetWidth; st.classList.add('pop'); return; }
    hintAt = (hintAt + 1) % hints.length;
    sel = hints[hintAt].cards.slice();
    sfx.pick(sel.length);
    layoutHand(); renderStatus();
  }
  /* A quick-pick chip: step through the hands of that kind, weakest first. */
  function doCombo(type) {
    if (!isMyTurn() || sending || !view.aids) return;
    var list = legal().filter(function (h) { return h.type === type; });
    if (!list.length) return;
    var cur = sel.slice().sort(function (a, b) { return a - b; }).join(',');
    var at = comboAt[type] === undefined ? -1 : comboAt[type];
    if (at >= 0 && list[at] && list[at].cards.join(',') !== cur) at = -1;   // selection changed by hand: start over
    at = (at + 1) % list.length;
    comboAt[type] = at;
    sel = list[at].cards.slice();
    sfx.pick(sel.length); buzz(8);
    layoutHand(); renderStatus();
  }

  /* ---------- before the deal ---------- */

  function renderWaiting() {
    var w = $('waiting');
    if (view.phase !== 'waiting') { w.hidden = true; return; }
    var humans = view.seats.filter(function (s) { return !s.bot; }).length;
    var sig = view.code + humans + (session.hosting ? 'h' : '') + view.bots;
    w.hidden = false;
    if (w._sig === sig) return;
    w._sig = sig;
    w.innerHTML = '<h2>' + esc(view.name) + '</h2>' +
      '<p>' + (humans === 4 ? 'Full table. Deal whenever you’re ready.' :
        plural(humans, 'player') + ' in. ' + botsLabel(view.bots) + ' fill the open seats' + (session.solo ? '.' : ', and anyone who joins later takes over a bot.')) + '</p>' +
      '<button class="btn btn-play btn-big" id="btn-deal">Deal</button>' +
      (session.solo ? '' : '<div class="invite"><span>Code <strong>' + esc(view.code) + '</strong>' + (view.pub ? ', listed in live tables' : ', invite only') + '</span><button class="link" id="btn-copy">Share link</button></div>') +
      (session.hosting ? '<p class="hostnote">You’re hosting, so keep this tab open. If you leave, the next player takes over.</p>' : '');
  }

  /* ---------- end of a round ---------- */

  function renderResults(ev, first) {
    var wrap = $('results-wrap');
    var over = view.phase === 'roundEnd' || view.phase === 'matchEnd';
    if (!over || !view.result) { clearTimeout(resultsTimer); wrap.hidden = true; shownResultSeq = -1; return; }
    if (!wrap.hidden) return;                      // already showing this round
    var justEnded = ev.some(function (e) { return e.k === 'roundEnd'; });
    clearTimeout(resultsTimer);
    resultsTimer = setTimeout(function () {
      if (!view || !view.result || (view.phase !== 'roundEnd' && view.phase !== 'matchEnd')) return;
      fillResults();
      wrap.hidden = false;
      var go = $('results').querySelector('.btn-play') || $('results').querySelector('.btn');
      if (go) go.focus({ preventScroll: true });
    }, justEnded && !first && !FX.isCalm() ? 2100 : justEnded && !first ? 600 : 0);
  }

  function fillResults() {
    var r = view.result, match = view.phase === 'matchEnd';
    var title, order = [0, 1, 2, 3];
    if (match) {
      title = r.champ === view.you ? 'You’re the champ!' : view.seats[r.champ].name + ' takes the match';
      order.sort(function (a, b) { return view.seats[b].score - view.seats[a].score || view.seats[b].wins - view.seats[a].wins; });
    } else {
      title = r.winner === view.you ? 'Round won!' : view.seats[r.winner].name + ' went out first';
      order.sort(function (a, b) { return r.delta[b] - r.delta[a]; });
    }
    var rows = order.map(function (i, rank) {
      var s = view.seats[i], left = r.hands[i];
      var detail = i === r.winner ? 'Out of cards' : plural(left.length, 'card') + ' left' + (left.length >= 13 ? ', tripled' : left.length >= 10 ? ', doubled' : '') + mini(left);
      return '<li class="' + (i === (match ? r.champ : r.winner) ? 'win' : '') + '" style="--i:' + rank + '">' +
        '<span class="rk">' + (rank + 1) + '</span>' +
        '<span class="av" style="--c:' + color(s.av) + '">' + initial(s.name) + '</span>' +
        '<span class="rn">' + esc(s.name) + (i === view.you ? ' (you)' : '') + '<span class="rl">' + detail + '</span></span>' +
        '<span class="rd ' + (r.delta[i] > 0 ? 'up' : r.delta[i] < 0 ? 'down' : '') + '" data-to="' + r.delta[i] + '">0</span>' +
        '<span class="rt" data-from="' + (s.score - r.delta[i]) + '" data-to="' + s.score + '">' + signed(s.score - r.delta[i]) + '</span></li>';
    }).join('');
    var actions;
    if (match) actions = '<button class="btn" data-act="leave">Leave</button><button class="btn btn-play" data-act="start">Play again</button>';
    else if (view.manualNext) actions = '<button class="btn" data-act="leave">Leave</button><button class="btn btn-play" data-act="next">Next round</button>';
    else actions = '<button class="btn" data-act="leave">Leave table</button>';
    $('results').innerHTML =
      '<h2 class="res-title">' + esc(title) + '</h2>' +
      '<p class="res-sub">' + (match ? 'Final scores after ' + plural(view.rounds, 'round') : 'Round ' + view.round + ' of ' + view.rounds) + '</p>' +
      '<div class="res-head"><span></span><span></span><span></span><span>Round</span><span>Total</span></div>' +
      '<ol class="res-rows">' + rows + '</ol>' +
      (!match && !view.manualNext ? '<div class="res-next" id="res-next"><i></i></div><p class="res-next-label" id="res-next-label"></p>' : '') +
      '<div class="sheet-actions">' + actions + '</div>';
    [].forEach.call($('results').querySelectorAll('.res-rows li'), function (li, i) {
      var d = li.querySelector('.rd'), t = li.querySelector('.rt');
      countUp(d, 0, +d.dataset.to, 500, 260 + i * 110);
      countUp(t, +t.dataset.from, +t.dataset.to, 500, 760 + i * 110);
    });
    tickClock();
  }

  /* ---------- cards played so far ---------- */

  function renderSeen() {
    var gone = {}, mine = {};
    (view.seen || []).forEach(function (id) { gone[id] = 1; });
    view.hand.forEach(function (id) { mine[id] = 1; });
    var html = '';
    for (var s = 3; s >= 0; s--) {
      html += '<div class="srow' + (s >= 2 ? ' red' : '') + '">' + suitSvg(s);
      for (var r = 0; r < 13; r++) { var id = r * 4 + s; html += '<span class="tile' + (gone[id] ? ' gone' : mine[id] ? ' mine' : '') + '">' + E.RANKS[r] + '</span>'; }
      html += '</div>';
    }
    $('seen').innerHTML = html;
    var left = 52 - (view.seen || []).length - view.hand.length;
    $('seen-note').textContent = view.phase === 'playing'
      ? 'Faded cards are gone. Outlined cards are yours. The other ' + left + ' are still in someone’s hand.'
      : 'Faded cards were played this round.';
  }

  /* ---------- the clock ---------- */

  function tickClock() {
    if (!view) return;
    var now = Date.now() + clockSkew, bar = $('timebar'), mineOn = false;
    for (var pos = 0; pos < 4; pos++) {
      var body = seatEls[pos].body, i = seatAt(pos);
      if (view.phase === 'playing' && view.turn === i && view.turnAt && view.turnSecs) {
        var left = Math.max(0, view.turnAt - now), p = Math.min(1, left / (view.turnSecs * 1000));
        var hurry = left < 6000;
        if (pos === 0) {
          mineOn = true;
          bar.style.setProperty('--p', p.toFixed(3));
          bar.classList.toggle('hurry', hurry);
          if (hurry && left > 0) {
            var sec = Math.ceil(left / 1000);
            if (sec !== lastTickSec) { lastTickSec = sec; sfx.tick(sec <= 3); }
          }
        } else {
          body.style.setProperty('--p', p.toFixed(3));
          body.classList.toggle('hurry', hurry);
        }
      }
    }
    bar.classList.toggle('on', mineOn);
    var nx = $('res-next');
    if (nx && view.nextAt) {
      var rem = Math.max(0, view.nextAt - now);
      nx.style.setProperty('--p', Math.min(1, rem / 11000).toFixed(3));
      $('res-next-label').textContent = 'Next round in ' + Math.ceil(rem / 1000);
    }
  }

  /* ---------- wiring ---------- */

  function buildTable() {
    handEl = $('hand'); pileEl = $('pile'); fieldEl = $('field'); gameEl = $('game');
    for (var pos = 0; pos < 4; pos++) {
      var el = $('seat' + pos);
      var body = document.createElement('div'), bub = document.createElement('div');
      body.className = 'plate'; bub.className = 'bubble';
      el.appendChild(body); el.appendChild(bub);
      seatEls.push({ el: el, body: body, bubble: bub });
    }

    // Picking cards: tap one, or press and drag across several.
    var drag = null, lastPointer = 0;
    handEl.addEventListener('pointerdown', function (e) {
      var c = e.target.closest('.card');
      if (!c || !view || e.button) return;
      lastPointer = Date.now(); kb = -1; audio();
      var id = +c.dataset.id, add = sel.indexOf(id) < 0;
      drag = { add: add, ids: [id] };
      setSel(id, add);
      try { handEl.setPointerCapture(e.pointerId); } catch (err) { /* fine without it */ }
    });
    handEl.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var under = document.elementFromPoint(e.clientX, e.clientY);
      var c = under && under.closest && under.closest('#hand .card');
      if (!c) return;
      var id = +c.dataset.id;
      if (drag.ids.indexOf(id) < 0) { drag.ids.push(id); setSel(id, drag.add); }
    });
    var endDrag = function () {
      if (drag && drag.add && drag.ids.length === 1) pickMates(drag.ids[0]);
      drag = null;
    };
    handEl.addEventListener('pointerup', endDrag);
    handEl.addEventListener('pointercancel', function () { drag = null; });
    handEl.addEventListener('click', function (e) {          // keyboard and assistive tech
      if (Date.now() - lastPointer < 700) return;
      var c = e.target.closest('.card'); if (!c || !view) return;
      var id = +c.dataset.id;
      setSel(id, sel.indexOf(id) < 0);
    });

    fieldEl.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      if (sel.length) { sel = []; hintAt = -1; sfx.drop(); layoutHand(); renderStatus(); }
      $('chat-tray').hidden = true;
    });
    $('combos').addEventListener('click', function (e) {
      var b = e.target.closest('.combo'); if (b) doCombo(b.dataset.type);
    });
    $('btn-play').addEventListener('click', doPlay);
    $('btn-pass').addEventListener('click', doPass);
    $('btn-hint').addEventListener('click', doHint);
    $('btn-sort').addEventListener('click', function () {
      me.sort = me.sort === 'rank' ? 'suit' : 'rank'; save(); sfx.ui();
      this.textContent = me.sort === 'rank' ? 'Rank' : 'Suit';
      kb = -1; if (view) renderHand(false);
    });
    $('btn-sound').addEventListener('click', toggleSound);
    $('btn-help').addEventListener('click', showRules);
    $('btn-seen').addEventListener('click', function () { if (view && view.aids) { renderSeen(); openDialog($('dlg-seen')); } });
    $('btn-invite').addEventListener('click', invite);
    $('btn-leave').addEventListener('click', function () {
      if (!view || view.phase === 'waiting' || view.phase === 'matchEnd') return goHome();
      $('leave-text').textContent = session && session.solo ? 'This solo game will end.'
        : session && session.hosting ? (session.others() ? 'You’re hosting. The table passes to the next player, and a bot takes your seat.' : 'You’re hosting and nobody else is here, so the table will close.')
        : 'A bot takes over your seat and your cards.';
      openDialog($('dlg-leave'));
    });
    $('dlg-leave').addEventListener('close', function () { if (this.returnValue === 'ok') goHome(); this.returnValue = ''; });
    $('waiting').addEventListener('click', function (e) {
      if (e.target.id === 'btn-deal') { audio(); session.send({ t: 'start' }); }
      if (e.target.id === 'btn-copy') invite();
    });
    $('results').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      if (b.dataset.act === 'leave') goHome();
      else { sfx.ui(); session.send({ t: b.dataset.act }); }
    });

    $('btn-chat').addEventListener('click', function () { var tray = $('chat-tray'); tray.hidden = !tray.hidden; });
    $('quick').innerHTML = QUICK.map(function (q) { return '<button type="button">' + q + '</button>'; }).join('');
    $('quick-emoji').innerHTML = EMOJI.map(function (q) { return '<button type="button">' + q + '</button>'; }).join('');
    var quickSend = function (e) {
      if (e.target.tagName !== 'BUTTON' || !session) return;
      session.send({ t: 'chat', text: e.target.textContent }); $('chat-tray').hidden = true;
    };
    $('quick').addEventListener('click', quickSend);
    $('quick-emoji').addEventListener('click', quickSend);
    $('chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('chat-text'), text = input.value.trim();
      if (text && session) { session.send({ t: 'chat', text: text }); input.value = ''; $('chat-tray').hidden = true; }
    });

    window.addEventListener('resize', function () { handBox = null; if (view) layoutHand(); });
    setInterval(tickClock, 250);

    document.addEventListener('keydown', function (e) {
      if (!view || $('game').hidden) return;
      if (e.target.tagName === 'INPUT' || document.querySelector('dialog[open]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!$('results-wrap').hidden) return;                  // the results buttons handle their own keys
      var ids = handEl._order || [], n = ids.length, key = e.key.toLowerCase();
      var onButton = document.activeElement && document.activeElement.tagName === 'BUTTON' && !document.activeElement.classList.contains('card');
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (!n) return;
        kb = kb < 0 ? (e.key === 'ArrowRight' ? 0 : n - 1) : (kb + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
        layoutHand(); e.preventDefault();
      } else if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (onButton && e.key === ' ') return;
        if (kb >= 0 && kb < n) { setSel(ids[kb], sel.indexOf(ids[kb]) < 0); e.preventDefault(); }
      } else if (e.key === 'Enter') { if (onButton) return; doPlay(); e.preventDefault(); }
      else if (key === 'p') doPass();
      else if (key === 'h') doHint();
      else if (key === 's') $('btn-sort').click();
      else if (e.key === 'Escape') { sel = []; kb = -1; hintAt = -1; layoutHand(); renderStatus(); $('chat-tray').hidden = true; }
    });
  }

  /* ---------------------------------------------------------------- go */

  FX.init($('fx'));
  buildBackdrop();
  buildHome();
  buildTable();
  // close a sheet by tapping outside it
  [].forEach.call(document.querySelectorAll('dialog.sheet'), function (d) {
    d.addEventListener('click', function (e) {
      if (e.target !== d) return;
      var r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close('cancel');
    });
  });
  var m = /^#([A-Za-z]{4})$/.exec(location.hash);
  if (m && Net.mode() !== 'off') joinTable(m[1].toUpperCase());
  else { show('home'); connectLobby(); }
  // Closing or reloading the tab: a host hands the table on, a guest asks for the seat to be held.
  window.addEventListener('pagehide', function () {
    if (!session) return;
    try { if (session.hosting) session.close(); else if (session.bye) session.bye(); } catch (e) { /* tab is going away anyway */ }
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (view) layoutHand(); });

  // handy for poking at the game from the console
  window.PusoyDebug = { get view() { return view; }, get session() { return session; } };
})();
