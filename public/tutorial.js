/* Pusoy Dos — the tutorial: four short guided hands at the real table.
 *
 * Each lesson is a small fixed deal and a script. The bots play their scripted
 * cards, and on your turn a coach says what to do and why; only that move is
 * accepted, anything else gets a nudge. It runs on the same table code as a
 * real game, so what you learn here is exactly how the game behaves.
 *
 * A step is one of:
 *   { by: seat, play: 'cards' }   a bot plays        { by: seat, pass: true }   a bot passes
 *   { me: true, want: 'cards' | 'pass', say: '…', why: '…' }   your move, with the coach's line
 * `say` on a bot step is shown while it plays. {1} {2} {3} stand for the bots' names.
 * Seats go round in order: you are 0, then 1, 2, 3.
 */
(function (root) {
  'use strict';
  var P = (root.Pusoy = root.Pusoy || {});

  var RANK = { '3': 0, '4': 1, '5': 2, '6': 3, '7': 4, '8': 5, '9': 6, '10': 7, J: 8, Q: 9, K: 10, A: 11, '2': 12 };
  var SUIT = { c: 0, s: 1, h: 2, d: 3 };
  /* "9h 10d 2c" -> card ids */
  function cards(text) {
    return text.split(' ').map(function (t) { return RANK[t.slice(0, -1)] * 4 + SUIT[t.slice(-1)]; }).sort(function (a, b) { return a - b; });
  }

  var LESSONS = [
    {
      title: 'One card at a time',
      recap: 'The 3♣ opens. Beat the card on the table with a higher one: 3 is low, then up to King, Ace and 2. Same rank? Clubs, spades, hearts, diamonds, low to high.',
      first: 0, open: true,
      hands: ['3c 8h Kd 2s', '5c 9s Qh', '6d 8s Ah', '4h Jc 2c'],
      steps: [
        { me: true, want: '3c', say: 'First to play all their cards wins. Whoever holds the 3♣, the lowest card in the deck, starts with it. Tap your 3♣, then press Play.', why: 'The opening play has to be the 3♣. Tap it, then press Play.' },
        { by: 1, play: '5c', say: 'Now everyone in turn has to beat the card on the table.' },
        { by: 2, play: '6d' },
        { by: 3, play: 'Jc' },
        { me: true, want: 'Kd', say: 'Your turn. Cards run from 3 (lowest) up to King, then Ace, then 2 (highest). Beat the Jack with your King.', why: 'Your 2 would work, but it is your best card. Save it and play the King.' },
        { by: 1, pass: true, say: '{1} cannot beat a King, so {1} passes.' },
        { by: 2, play: 'Ah' },
        { by: 3, play: '2c' },
        { me: true, want: '2s', say: 'A 2 is on the table. When ranks match, the suit decides: clubs ♣, spades ♠, hearts ♥, diamonds ♦, low to high. Your 2♠ beats the 2♣.', why: 'Only a higher 2 beats a 2. Play your 2♠.' },
        { by: 2, pass: true, say: 'Nobody can beat that.' },
        { by: 3, pass: true },
        { me: true, want: '8h', say: 'Everyone passed, so the table clears and you lead. One card left: play it to win!', why: 'Play your last card.' }
      ]
    },
    {
      title: 'Pairs and three of a kind',
      recap: 'A pair is answered with a higher pair, three of a kind with a higher three of a kind. Whoever leads decides which it is.',
      first: 1, open: false,
      hands: ['5h 5d Qc Qs 8c 8s 8h 3h', '4c 4s 9h Kc', '6c 6s Jd Ah', '10h 10d 7d 2h'],
      steps: [
        { by: 1, play: '4c 4s', say: '{1} leads a pair: two cards of the same rank.' },
        { by: 2, play: '6c 6s', say: 'A pair can only be beaten by a higher pair.' },
        { by: 3, play: '10h 10d' },
        { me: true, want: 'Qc Qs', say: 'Beat the pair of 10s with your pair of Queens. Tap one Queen and its partner comes along.', why: 'You need a pair higher than 10s. Play your two Queens.' },
        { by: 1, pass: true, say: 'Nobody has a higher pair.' },
        { by: 2, pass: true },
        { by: 3, pass: true },
        { me: true, want: '8c 8s 8h', say: 'The table cleared and you lead, so you choose what gets played. Three of a kind works like a pair, with three cards. Play your three 8s.', why: 'Tap all three 8s, then press Play.' },
        { by: 1, pass: true },
        { by: 2, pass: true },
        { by: 3, pass: true },
        { me: true, want: '5h 5d', say: 'You lead again. Now your pair of 5s.', why: 'Play your pair of 5s.' },
        { by: 1, pass: true },
        { by: 2, pass: true },
        { by: 3, pass: true },
        { me: true, want: '3h', say: 'One card left. Finish it!', why: 'Play your last card.' }
      ]
    },
    {
      title: 'Five-card hands',
      recap: 'Five-card hands only beat other five-card hands. Weakest to strongest: straight, flush, full house, four of a kind, straight flush.',
      first: 1, open: false,
      hands: ['4h 7h 9h Jh Kh Ac As Ad 6c 6s', '5c 6d 7s 8c 9d Qc Qs Qh 3s 3d 4d', '4c 8d Jc 2c', '5s 9s Kc 2h'],
      steps: [
        { by: 1, play: '5c 6d 7s 8c 9d', say: '{1} leads a straight: five cards in a row. Only another five-card hand can beat it.' },
        { by: 2, pass: true },
        { by: 3, pass: true },
        { me: true, want: '4h 7h 9h Jh Kh', say: 'A flush is five cards of the same suit, and any flush beats any straight. Play your five hearts.', why: 'Tap your five hearts (4, 7, 9, Jack, King), then press Play.' },
        { by: 1, play: 'Qc Qs Qh 3s 3d', say: '{1} answers with a full house: three of a kind plus a pair. A full house beats a flush.' },
        { me: true, want: 'Ac As Ad 6c 6s', say: 'Full houses are ranked by their three of a kind, and your three Aces beat three Queens. Play your Aces with the pair of 6s to win. Above a full house come four of a kind and the straight flush.', why: 'Tap your three Aces and both 6s, then press Play.' }
      ]
    },
    {
      title: 'Passing and the 2s',
      recap: 'You can pass at any time, but then you sit out until the table clears. Save your 2s to take the lead when it counts, then lead the cards you most want to be rid of.',
      first: 1, open: false,
      hands: ['4s 8c 8d 2d', 'Jc Js Ah 7d 6h', '2c 5h 10s 3d', 'Kc Kd 9h Qd 7c'],
      steps: [
        { by: 1, play: 'Jc Js', say: '{1} leads a pair of Jacks.' },
        { by: 2, pass: true },
        { by: 3, play: 'Kc Kd' },
        { me: true, want: 'pass', say: 'You need a pair higher than Kings, and your 8s are not. Press Pass. Passing sits you out until the table clears.', why: 'Your 8s cannot beat Kings. Press Pass.' },
        { by: 1, pass: true, say: 'Everyone passed, so {3} takes the trick and leads.' },
        { by: 3, play: '9h', wait: 1900 },
        { me: true, want: 'pass', say: 'You are back in. Your 2♦ would beat this 9, but it is the best card in the game. Do not spend it on a 9. Pass and wait for a better moment.', why: 'Hold on to the 2♦ for now. Press Pass.' },
        { by: 1, play: 'Ah', say: 'You are sitting this trick out.' },
        { by: 2, play: '2c' },
        { by: 3, pass: true },
        { by: 1, pass: true },
        { by: 2, play: '5h', wait: 1900, say: '{2} won the trick and leads a low card.' },
        { by: 3, play: 'Qd' },
        { me: true, want: '2d', say: 'Now it counts: you are three plays from winning. Take the lead with the 2♦. Nothing beats it.', why: 'This is the moment. Play the 2♦.' },
        { by: 1, pass: true, wait: 2600, say: 'Nothing beats the 2♦.' },
        { by: 2, pass: true },
        { by: 3, pass: true },
        { me: true, want: '8c 8d', say: 'You lead, so you choose. Get rid of your pair of 8s while nobody can answer.', why: 'Lead your pair of 8s.' },
        { by: 1, pass: true },
        { by: 2, pass: true },
        { by: 3, pass: true },
        { me: true, want: '4s', say: 'Last card. Go out!', why: 'Play your last card.' }
      ]
    }
  ];

  function sameCards(a, b) {
    if (!Array.isArray(a) || a.length !== b.length) return false;
    var x = a.slice().sort(function (p, q) { return p - q; });
    for (var i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
    return true;
  }

  /* h: { onState(view, events), onError(message, code) }. Returns a session like a solo game's. */
  function start(profile, h, opts) {
    var core = P.TableCore.create({ code: 'LEARN', name: 'Tutorial', rounds: LESSONS.length, turnSecs: 0, manualNext: true, aids: false, emotes: false, bots: 'easy' }, Date.now());
    var pace = (opts && opts.pace) || 1;            // tests run it faster
    core.join('me', profile, Date.now());
    var s = core.s, lesson = 0, step = 0, timer = 0, dead = false, line = '';

    function name(text) {
      return String(text || '').replace(/\{([123])\}/g, function (m, k) { return s.seats[+k].name; });
    }
    function cur() { return LESSONS[lesson].steps[step]; }
    function tutor() {
      var L = LESSONS[lesson], st = cur(), mine = !!(st && st.me && s.phase === 'playing');
      if (st && st.say) line = name(st.say);
      return {
        lesson: lesson, of: LESSONS.length, title: L.title, text: line, recap: L.recap,
        want: mine ? (st.want === 'pass' ? 'pass' : cards(st.want)) : null,
        done: s.phase !== 'playing', last: lesson === LESSONS.length - 1
      };
    }
    function flush() {
      if (dead) return;
      var v = core.view(0, Date.now());
      v.tutor = tutor();
      h.onState(v, core.drain());
      clearTimeout(timer);
      var st = cur();
      if (st && !st.me && s.phase === 'playing') timer = setTimeout(botStep, (st.wait || 1250) / pace);
    }
    function botStep() {
      var st = cur(), now = Date.now();
      if (dead || !st || st.me) return;
      var r = st.pass ? core.pass(st.by, now) : core.play(st.by, cards(st.play), now);
      if (r && r.error && root.console) root.console.warn('tutorial script out of step:', r.error);
      step++;
      flush();
    }
    function load(i) {
      var L = LESSONS[i];
      lesson = i; step = 0; line = '';
      s.phase = 'playing'; s.round = i + 1; s.result = null;
      s.hands = L.hands.map(cards);
      s.passed = [false, false, false, false];
      s.table = null; s.trick = []; s.seen = [];
      s.turn = L.first; s.mustOpen = !!L.open;
      s.turnAt = 0; s.actAt = 0; s.nextAt = 0;
      core.emit({ k: 'deal', round: s.round, first: s.turn });
      s.seq++;
      flush();
    }

    setTimeout(function () { if (dead) return; if (h.onStatus) h.onStatus('online'); load(0); }, 0);

    return {
      solo: true, tutorial: true, hosting: false,
      send: function (msg) {
        if (dead || !msg) return;
        if (msg.t === 'next') { if (s.phase !== 'playing' && lesson < LESSONS.length - 1) load(lesson + 1); return; }
        if (msg.t === 'again') { load(lesson); return; }
        if (msg.t !== 'play' && msg.t !== 'pass') return;
        var st = cur();
        if (!st || !st.me || s.phase !== 'playing') return h.onError('Hold on, it is not your turn yet.', 'move');
        var right = st.want === 'pass' ? msg.t === 'pass' : msg.t === 'play' && sameCards(msg.cards, cards(st.want));
        if (!right) return h.onError(name(st.why) || 'Not that one. Follow the coach.', 'move');
        var r = core.act('me', msg, Date.now());
        if (r && r.error) return h.onError(r.error, 'move');
        step++;
        flush();
      },
      close: function () { dead = true; clearTimeout(timer); },
      others: function () { return 0; }
    };
  }

  P.Tutorial = { start: start, LESSONS: LESSONS, cards: cards };
})(typeof globalThis !== 'undefined' ? globalThis : this);
