# Find the Impostor

A browser-based multiplayer social deduction game built with React, Vite, Express and Socket.IO.

## Requirements
- Node.js 18 or newer
- npm

## Run locally
```bash
npm install
npm run dev
```
Open http://localhost:5173 in two or more browser windows/devices. The Vite dev server proxies Socket.IO to the game server on port 3001.

For a production build:
```bash
npm run build
npm start
```
The Express server serves the built frontend and Socket.IO from the same origin. Set `PORT` on your hosting provider.

## Play
1. One player creates a room and shares the six-character room code.
2. Friends join with a nickname and avatar (2–8 players).
3. The host starts the match. Each round assigns one impostor privately.
4. Players give clues, discuss, and vote. If the impostor is caught, they get one final word guess.
5. Complete three rounds to see the leaderboard.

## Current build notes
- Uses an in-memory room store and curated word bank. Rooms reset when the server restarts; this is suitable for the first playable prototype, not multi-instance production hosting.
- The UI and server are prepared for a single Node process. Deploy the project as one Node web service (for example, Railway or Render) to keep Socket.IO connections on the same process.
- MongoDB persistence and optional AI word generation are not wired in yet; no API key is needed to play this build.
- This prototype includes core room, role, clue, chat, voting, final-guess and scoring flows. It still needs a full two-device QA pass and hardening before public launch.
