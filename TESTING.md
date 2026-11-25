# Verification record

Date: 25 November 2026

## Local automated verification

- 18 automated tests pass against real Socket.IO clients and temporary HTTP servers.
- Server and browser JavaScript syntax checks pass.
- Production dependency audit reports zero known vulnerabilities.
- All eight winning patterns are checked for both marks.
- Full winning and nine-move draw matches are exercised.
- Invalid, out-of-turn, occupied, spectator, and stale-round actions are rejected.
- Restart requests require both players; old requests cannot affect a new round.
- A spectator disconnect, resume, or leave preserves player restart consent.
- Multiple rooms, reconnecting, seat expiry, idle expiry, and bounded room creation are checked.

## Local browser verification

- Two separate player tabs and a third spectator tab joined the same room.
- A complete win and draw displayed the same board, result, and score on all tabs.
- A pending restart kept the old board until the second player agreed.
- A restart request could be cancelled, and the next round alternated the first mark.
- Refreshing a player's tab restored its role and board; a keyboard Enter press placed a move.
- An invalid room code produced a usable error message.
- Phone-width (320px) and tablet-width (768px) embedded browser viewports rendered both lobby and game without horizontal overflow. These are layout checks, not tests on physical devices.
- A phone-width player and tablet-width player exchanged live moves.

The browser viewport override did not change the existing preview dimensions, so a temporary same-origin iframe harness was used to verify actual media-query layouts. That harness is in the workspace's `work/` directory and is not shipped with the game.

## Publishing status

- Public game: https://xo-club.onrender.com
- Repository: https://github.com/MS-Creed/xo-club
- Render reports **Deploy succeeded | Live** on the Free plan in Singapore.
- Deployed source commit: `9844c6088c1508914d339439cfc443e8799a5454`.
- Runtime: Node.js 22.16.0; production build `npm ci --omit=dev`; start `npm start`; health path `/health`.
- GitHub-published game code was fetched and compared with the tested local source. All game, static, dependency, and test files match.
- A public HTTPS smoke run passed 194 checks across independent WebSocket and HTTP polling clients. It verified assets, room creation/joining, spectators, synchronized wins and draws, restart consent, reconnection, stale-action rejection, and room isolation. All test rooms were left afterwards.
- Two browser tabs completed a winning match on the public website and displayed the same board, winner, and score. The public lobby was left ready to play.
- Physical-device testing remains a user check: open the public URL on a phone and computer, create a room on one, and join on the other. The recorded browser checks use independent sessions and actual 320px/768px layout viewports; they do not claim to have operated two physical devices.

GitHub CLI authentication was unavailable in the sandbox, so source publication used the authenticated GitHub browser. Render sign-in and email verification were completed by the user. The temporary Cloudflare preview is not the published game; permanent hosting is the Render URL above.
