# Insiders Backend

Small backend for live sports/game data and odds.

## Run locally

```powershell
cd C:\Users\JUSTIN\OneDrive\Documents\CODEX\insiders-backend
npm start
```

## Endpoints

- `GET /health`
- `GET /api/sports`
- `GET /api/games?sport=NBA`
- `GET /api/games/:gameId?sport=NBA`
- `GET /api/games/:gameId/odds?sport=NBA`

## Local env

The server automatically reads a local `.env` file beside `server.js`.

Copy `.env.example` to `.env` and set:

- `PORT`
- `SPORTS_API_PROVIDER`
- `ODDS_PROVIDER`
- `SPORTSGAMEODDS_API_KEY`
- `ODDS_API_KEY`

## Deploy on Render

This repo includes [render.yaml](C:\Users\JUSTIN\OneDrive\Documents\CODEX\insiders-backend\render.yaml) so Render can detect the service settings automatically.

Steps:

1. Push `insiders-backend` to GitHub.
2. In Render, create a new `Blueprint` or `Web Service` from that repo.
3. Set the env vars in Render:
   - `SPORTS_API_PROVIDER=espn`
   - `ODDS_PROVIDER=sportsgameodds`
   - `SPORTSGAMEODDS_API_KEY=...`
4. Deploy.
5. Confirm `https://your-service.onrender.com/health` works.

## Point Expo at the deployed backend

Once the backend is live, run Expo with:

```powershell
cd C:\Users\JUSTIN\OneDrive\Documents\CODEX\insiders-mobile
$env:EXPO_PUBLIC_API_URL="https://your-service.onrender.com"
npx.cmd expo start -c
```

Friends can use Expo Go and scan the QR code, and the app will call the public backend instead of your localhost.
