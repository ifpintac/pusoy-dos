/* How live tables work.
 *
 *   ''       Player-hosted (the default). No server at all: whoever opens a table
 *            hosts it in their own browser and the others connect straight to them.
 *            Works from any static host (GitHub Pages, Cloudflare Pages...).
 *
 *   'same'   Use the referee server in server.js, deployed at this same address
 *            (npm run dev / npm run deploy). The server holds the cards, so nobody
 *            at the table can peek.
 *
 *   'https://your-worker.workers.dev'
 *            Use a referee server that lives somewhere else.
 *
 *   'off'    Solo only.
 */
window.PUSOY_SERVER = '';

/* Player-hosted extras (both optional):
 *   window.PUSOY_RELAYS = ['wss://relay.example.com'];   your own list of Nostr relays for matchmaking
 *   window.PUSOY_TURN = [{ urls: 'turn:example.com:3478', username: '...', credential: '...' }];
 *                                                         a TURN server lets players on strict networks connect
 */
