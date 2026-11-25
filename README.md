# XO Club

A complete online multiplayer Tic-Tac-Toe game. Create a room, share its six-character code or invitation link, and play with a friend on another device. Extra friends can watch.

## What is included

- Live room creation and joining, with no player registration.
- Two active players per room, plus up to 30 spectators.
- Many independent rooms on one server.
- Server-checked turns, occupied squares, eight winning patterns, and draws.
- Room scores and a restart button that requires both players to agree.
- Alternating first turns after an agreed restart.
- A 60-second seat reservation after disconnecting, with automatic reconnect.
- Clear errors, phone and tablet layouts, keyboard controls, and reduced-motion support.

## Run the game on your computer

1. Install Node.js 22 LTS or 24 LTS from https://nodejs.org if it is not already installed.
2. Open a terminal in this project's folder, the folder containing `package.json`.
3. Run these commands:

```sh
npm install
npm start
```

4. Open http://localhost:3000 in your browser.
5. To try both players yourself, open a second tab, enter another nickname, and join the room code.

Keep the terminal running while playing. Press Ctrl+C in that terminal to stop the server. `localhost` refers to your own computer; use the published URL when playing from different networks.

For a different port, set the `PORT` environment variable before running the server. No API keys or database configuration are needed.

## Play

1. Enter a nickname and select **Create a room**.
2. Copy the code or invitation link and send it to your friend.
3. Your friend opens the website, enters a nickname, and joins.
4. X starts the first round. Place a mark in an empty square when the screen says **Your move**.
5. Three matching marks in a row, column, or diagonal wins. Nine filled squares without a winner is a draw.
6. Select **Play again** or **Request restart**. The other player selects **Accept restart**. Scores remain, the board clears, and the other mark starts.

The first two people joining a room become players. Additional people become spectators and cannot place marks. Spectators can leave and join again when a seat is free.

## If a connection drops

Moves pause while either player is disconnected. Return to the same browser tab within 60 seconds to restore the reserved seat and board. If the reservation expires, the seat opens and the board resets for a new opponent. Leaving a room intentionally releases the seat immediately.

Room identity is saved only for the current browser tab. If browser storage is unavailable, brief reconnects still work while that page remains open, but refreshing may require joining again.

## Publish with Render

The assistant will help complete these steps. They are also included here for future updates.

1. Upload this project to a GitHub repository. Keep `package.json`, `package-lock.json`, `server.js`, `lib/`, and `public/` at the repository root.
2. Sign in at https://dashboard.render.com.
3. Choose **New → Web Service**, then select the GitHub repository or its public Git URL.
4. Use the **Node** runtime, build command `npm ci --omit=dev`, and start command `npm start`.
5. Choose the **Free** instance for a hobby deployment. The health check path is `/health`.
6. Keep the service at **one instance**. Render supplies `PORT` automatically.
7. Deploy, wait until it is live, then open the exact `https://…onrender.com` address shown by Render.
8. Test that public address on a computer and a phone: create a room on one, join on the other, and check that turns and results update on both.

`render.yaml` contains the same settings for a Render Blueprint deployment. A `Dockerfile` is included for other hosts that support Node services and WebSockets.

### Free hosting and temporary rooms

Render's free web services can sleep after 15 minutes without incoming activity. A first visit after sleep may take about one minute to start. Free usage quotas apply; if your account already has a payment method, bandwidth or build overages can be billable. Check your workspace usage and spending settings before relying on a free service.

Rooms and scores are kept in the server's memory. They disappear on server restart, redeploy, or service sleep. Rooms also close after two hours without game or membership activity. This first version does not store permanent accounts or match history. Use one server instance; multiple instances would need a shared room store.

Current hosting limits: https://render.com/docs/free

## Test the code

```sh
npm test
npm run check
```

The automated tests open real independent Socket.IO connections and cover multiplayer state, winning patterns, a draw, turn enforcement, stale actions, restart consent, room isolation, spectators, reconnecting, seat expiry, and room limits. Tests start their own temporary server and do not change a running game's rooms.

## Understand the files

| File | What it does |
| --- | --- |
| `public/index.html` | The page structure, forms, rules, and controls |
| `public/styles.css` | Colors, spacing, animations, and screen-size layouts |
| `public/app.js` | Displays live state and sends player actions |
| `server.js` | Hosts the site and controls every room and move |
| `lib/game.js` | Finds wins and draws |
| `test/server.test.js` | Automated game and multiplayer tests |
| `package.json` | Libraries and simple run commands |
| `render.yaml` | Online deployment settings |

HTML creates the page, CSS makes it attractive, and JavaScript makes it interactive. Node.js runs JavaScript on the server. Express serves the website. Socket.IO keeps the browsers connected to the server so updates arrive live.

## Make simple changes

Change the site's colors in the variables near the top of `public/styles.css`. Change labels and introductory text in `public/index.html`. Change turn and result messages in `public/app.js`. Refresh your browser after saving. Once published, committing and pushing your updates allows Render to deploy the new version.
