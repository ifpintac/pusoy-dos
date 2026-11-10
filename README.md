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
- **Players connect directly,** so, as with any peer-to-peer game, they can technically see each other's IP addresses.
- **The public relays belong to other people.** They are free and there are many of them, but they can be slow or unavailable. You can list your own in `public/config.js`.
- **No hall of fame.** Without a neutral referee, wins can't be trusted, so it is switched off.

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
public/bot.js       the computer players (also powers the Hint button)
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

The player-hosted test uses pretend browsers on an in-memory network, so it needs no internet. To check the optional referee server, run `npm run dev` in one terminal and `npm run test:online` in another.

Tip: add `?fast` to the address to make solo bots play instantly.

## At the table

- Tap cards to pick them, or press and drag across several.
- Keyboard: arrow keys move, Space picks a card, Enter plays, P passes, S sorts, Esc clears.
- Solo games add three practice aids: Hint (H) suggests a play; the chips above your hand (Pair, Straight, Flush...) jump straight to hands you can play; and the card-stack button in the top bar shows every card played so far this round.
- At live tables those three aids are off, and the played-cards list is never sent to players.
- Effects calm down automatically for anyone whose device is set to reduce motion.

Fonts: Jersey 20, Rubik and Barlow Condensed, all under the SIL Open Font License. Matchmaking: Trystero by Dan Motzenbecker, MIT licence.
