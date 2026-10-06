# Portfolio

My portfolio: **https://iamsrkg.github.io/portfolio/** (https://iamsrkg.github.io redirects here).

It follows one request through a backend (edge, rate limiter, auth, service, database, queue) and shows where I've built each part at work. Then there's a live API you can try to break, my public projects, and what I did at each job.

Everything is plain HTML, CSS and JavaScript, written by hand, with no framework and no build step.

- `index.html`, `styles.css`: the page
- `journey.js`: the request's progress bar and the small demo at each stop
- `playground.js`: the live API, a browser port of my [task-management-api](https://github.com/iamsrkg/task-management-api) with real HMAC-signed JWTs and PBKDF2 passwords (Web Crypto)
- `work.js`: the demos in the work section, the phone menu and the folding stops
- `cursor.js`: moving the cursor (or scrolling, on a phone) sends requests through a small service map behind the page
- `resume-request.js`: the floating Contact and Resume buttons and the "request my resume" form. It emails me, falls back to a second mail service, and queues the request in the browser if both are down
- `notes/`: four short engineering notes (404 vs 403, rate limiting before auth, optimistic locking, idempotency keys)
- `fonts/`: Inter and JetBrains Mono, self-hosted
- `404.html`: the not-found page
- `og.png`: the preview image for shared links

Visits are counted with [GoatCounter](https://www.goatcounter.com/): no cookies, and no personal data is stored.

To run it locally, serve the folder with any static server, for example `npx serve .`.
