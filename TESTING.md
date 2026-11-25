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

Deployment is prepared but still requires account access. The saved GitHub CLI login failed authentication. A hosted public URL and physical phone/computer test must be verified after publishing; local success alone is not proof of a live deployment.
