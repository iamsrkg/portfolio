# Portfolio

My portfolio: **https://iamsrkg.github.io/portfolio/** (https://iamsrkg.github.io redirects here).

It follows one request through a backend (edge, rate limiter, auth, service, database, queue) and shows where I've built each part at work. Then there's a live API you can try to break, my public projects, and what I did at each job.

Everything is plain HTML, CSS and JavaScript, written by hand, with no framework and no build step.

- `index.html`, `styles.css`: the page
- `journey.js`: the request's progress bar and the small demo at each stop
- `playground.js`: the live API, a browser port of my [task-management-api](https://github.com/iamsrkg/task-management-api) with real HMAC-signed JWTs and PBKDF2 passwords (Web Crypto)
- `work.js`: the demos in the work section, the phone menu and the folding stops
- `cursor.js`: moving the cursor sends requests through a small service map behind the page
- `og.png`: the preview image for shared links

To run it locally, serve the folder with any static server, for example `npx serve .`.
