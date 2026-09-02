# web/

The Next.js dashboard for BURN. It has no data of its own — it proxies the collector (`../src/server.js`, port 4090) through same-origin routes (`app/events`, `app/api/session`).

Run from the repo root with `burn web` (or `npm run web`). See the top-level README.
