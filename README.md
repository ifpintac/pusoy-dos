# Pusoy Dos

The card game, in the browser, arcade style. Play solo against bots, or open a live table that anyone can join.

No build step and no server. The whole game is the plain HTML, CSS and JavaScript in `public/`, so any static host (GitHub Pages, Cloudflare Pages, Netlify) can serve it for free.

## Try it

Double-click `public/index.html`. Solo works straight away, and so do live tables: open the file in a second browser window and you can host in one and join from the other.

## Put it online (GitHub Pages)

1. Put this folder in a GitHub repository (the `.gitignore` already leaves `node_modules` out).
2. In the repository's Pages settings, publish from your main branch, root folder.

GitHub gives you an address like `https://yourname.github.io/pusoy-dos/`, which forwards to the game in `public/`. Send that to friends. Any other static host works too: publish the contents of `public/`.

## How live tables work (player-hosted)

- **Whoever opens a table hosts it.** Their browser deals, checks every move and runs the bots, using the same referee code as solo play. Everyone else connects straight to the host, browser to browser.
- **Live tables list.** Hosts of public tables announce them on a shared channel, and everyone on the home screen sees the list. Invite-only tables are never announced; share the link or the four-letter code.
- **How browsers find each other.** Browsers can't discover one another unaided, so the game uses public Nostr relays for the introduction (through the bundled Trystero library). Once two players are connected, the game data goes directly between them, not through the relays.
- **Bots are free seats.** Empty seats are played by bots, and anyone who joins, even mid-round, takes over a bot and its cards.
- **If the host leaves,** the table passes to the next player in seat order and a bot takes the old host's seat. This also happens if the host's tab crashes or their connection drops; the others notice within about seven seconds.
- **If a guest drops,** their seat is held for 45 seconds with a bot covering. Reloading the page puts them back in it.
- **Quick join** seats you at an open table, or opens one with you as host if there are none.

What to know about hosting this way:

- **The host holds the deck.** A technically minded host could look at everyone's cards, and so could the one player lined up to take over. Play with people you trust.
- **Hosts should keep the tab open.** If the host's phone locks or the tab is closed, the table moves to the next player.
- **Some networks block direct connections.** Strict mobile carriers and office networks can stop two players from reaching each other. A TURN server fixes this; see `public/config.js`.
- **Players connect directly,** so, as with any peer-to-peer game, they can technically see each other's IP addresses. That includes everyone on the home screen while the live-tables list is open, not only the people at your table. A TURN server set to relay-only would hide them.
- **The public relays belong to other people.** They are free and there are many of them, but they can be slow or unavailable. You can list your own in `public/config.js`.
- **No hall of fame.** Without a neutral referee, wins can't be trusted, so it is switched off.

### What a stranger can and cannot do

Anyone can open the page, join a room and send whatever they like, so the game treats everything from the network as untrusted.

| Someone tries to | What happens |
| --- | --- |
| Announce "I host this table now" | Ignored. A player only accepts the host they sat down with and, once that host is gone, the one successor that host named. A real host only steps aside for a successor it named itself. |
| Put markup or nonsense on other players' screens (names, chat, table names, cards) | Everything a host or the lobby sends is rebuilt field by field before the page uses it: text is stripped of markup, cards must be real and distinct, numbers are clamped. The page also carries a content security policy, so only the game's own script files can run. |
| Take someone's seat by replaying their identity | A player's saved key never leaves their browser. A host is shown a token that only works for that one table code, and the table copy kept by the successor stores only a hash of it. |
| List a fake table under a real table's code | The list keeps one row per code, from whoever listed it first, and joining from the list goes to that host. |
| Flood a host with messages | Anything beyond 30 messages a second from one connection is dropped, and oversized chat is cut before it is looked at. |
| Hand a successor a rigged table | The table copy is checked when it is taken over: all 52 cards must be accounted for exactly once, or the handover is refused. |

What this does not fix, because it needs a neutral referee: a host can read the deck, and a host can simply cheat or close the table. The player named as successor can read the deck too. `npm test` includes these attacks.

## Optional: a referee server

`server.js` is a small Cloudflare Worker that does the hosting instead of a player: it holds the cards and checks every move, so nobody at the table can peek, tables don't depend on anyone's tab, and the hall of fame works. It fits Cloudflare's free plan.

```
npm install
npx wrangler login
npm run deploy
```

Then set `window.PUSOY_SERVER = 'same';` in `public/config.js` (or the Worker's address if the page is hosted elsewhere). `npm run dev` runs it locally at http://localhost:8787.

## The rules this version plays

- 52 cards, 13 each. Ranks run 3 (low) to 2 (high). Suits run clubs, spades, hearts, diamonds (low to high), so the 3♣ is the lowest card and the 2♦ the highest.
- Plays: one card, a pair, three of a kind, or a five-card hand. Five-card hands rank straight, flush, full house, four of a kind (plus any card), straight flush.
- Straights follow the same rank order and don't wrap: 3-4-5-6-7 is the lowest, J-Q-K-A-2 the highest.
- Flushes and straights compare by their highest card, then that card's suit. Full houses compare by the three of a kind, four of a kind by the four.
- The lowest card always plays first: every round, whoever holds the 3♣ opens, and must play it alone or inside a hand.
- Beat the table with the same number of cards or pass. A pass sits you out until the table clears (this can be switched off when you open a table). When everyone else has passed, the last player to play leads anything.
- The round ends when someone plays their last card. Everyone else pays the winner a point per card left; 10 or more cards count double, all 13 triple. Highest total after the last round wins.
- A deal that gives one player all four 2s is reshuffled.

House rules vary from group to group. The rules live in `public/engine.js` (hands and comparisons) and `public/table.js` (turn order, passing, scoring) if you want to bend them.

## Bots

Pick the level when you start a solo game or open a table. At a table it applies to every open seat.

| Level | How it plays |
| --- | --- |
| Easy | A beginner: dumps its lowest cards, breaks up its own hands, burns 2s early, and never notices that someone is about to go out. |
| Normal | Plans its hand into groups, sheds weak cards first, saves 2s and big hands to win the lead back, and blocks a player who is on their last card. |
| Hard | Normal, plus it counts cards, so it knows exactly which of its plays nobody can beat. It also thinks ahead: it deals the unseen cards out at random a few times, plays each option to the end of the round, and keeps the one that scores best. |

No level cheats. Bots only use what a player at the table could know: their own hand, how many cards everyone holds, and what has been played.

Measured with `npm run duel` (one bot against three of another level; 25% of rounds won means no edge):

| Match-up | Rounds won | Points per round |
| --- | --- | --- |
| Easy against three Normal | 15% | -2.6 |
| Normal against three Easy | 37% | +1.7 |
| Hard against three Normal | 31% | +4.2 |

Hard's thinking takes about 30 ms a move on the device that referees the table (`THINK_MS` in `public/net.js`), so a slow phone gets fewer look-aheads and plays a little weaker. On the optional referee server it is off by default to stay inside the free plan's CPU limit, which leaves Hard there about as strong as Normal; `BOT_THINK_MS` in `server.js` turns it on. The Hint button in solo games always uses the Hard brain.

A bot covering for a player who stepped away plays at Normal whatever the table is set to.

## Keeping it smooth

The table is drawn so that nothing moves unless something happened: while you think about your move, the browser draws nothing at all.

- The background is painted once. It used to drift, which made the whole screen redraw 60 times a second for as long as the page was open.
- Shines, pulses and the sunburst only slide, scale or fade ready-made pictures. They no longer repaint cards every frame.
- The spark canvas is capped at about a million pixels whatever the screen size, only clears the patch it drew on, and leaves the page when it is empty.
- If a device still falls under 30 frames a second during a big effect, the game quietly uses fewer sparks from then on.
- **Effects: light** on the home screen switches off the decoration (shines, pulses, screen shake, sunburst) and thins the sparks, for devices that find the full show heavy. The browser's "reduce motion" setting is respected as before.

## What's where

```
public/index.html   the page
public/style.css    the look
public/client.js    the screen: home, table, cards, sounds
public/fx.js        arcade effects: sparks, rings, confetti, screen shake
public/net.js       solo / live table / lobby connections
public/p2p.js       player-hosted tables: hosting, joining, host handover, the live list
public/vendor/      Trystero (matchmaking + WebRTC), bundled into one file
public/engine.js    the rules: what a hand is, what beats what, dealing
public/bot.js       the computer players, three levels (also powers the Hint button)
public/table.js     one table: seats, turns, passing, scoring, timers
public/config.js    player-hosted (default) or referee server, plus relay/TURN options
server.js           optional referee server (Cloudflare Worker)
wrangler.jsonc      Cloudflare config for it
test/               rule checks, bot simulation, player-hosted tables, referee-server check
_old-v1/            the original game, untouched, for reference
```

`engine.js`, `bot.js` and `table.js` are shared: the same files referee solo games, player-hosted tables (in the host's browser) and the optional server.

## Tests

```
npm install
npm test                 # rules, 300 simulated matches, and player-hosted tables (hosting, joining, handover)
```

`npm run duel` pits the bot levels against each other and prints how often each wins (add a number of rounds, then `30` to let Hard think ahead: `npm run duel 1000 30`).

The player-hosted test uses pretend browsers on an in-memory network, so it needs no internet. To check the optional referee server, run `npm run dev` in one terminal and `npm run test:online` in another.

Tip: add `?fast` to the address to make solo bots play instantly.

## At the table

- Tap cards to pick them, or press and drag across several.
- Keyboard: arrow keys move, Space picks a card, Enter plays, P passes, S sorts, Esc clears.
- Solo games add three practice aids: Hint (H) suggests a play; the chips above your hand (Pair, Straight, Flush...) jump straight to hands you can play; and the card-stack button in the top bar shows every card played so far this round.
- At live tables those three aids are off, and the played-cards list is never sent to players.
- Effects calm down automatically for anyone whose device is set to reduce motion.

Fonts: Jersey 20, Rubik and Barlow Condensed, all under the SIL Open Font License. Matchmaking: Trystero by Dan Motzenbecker, MIT licence.
