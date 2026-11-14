# The web app is a Vite and React single-page app over the App SDK

The web app (spec #37) adds no behaviour: every screen calls the App SDK or the proof-view package. Every screen but the public record needs the device's PIN-locked keys, which live only in the browser, so server rendering buys nothing for them. Next.js was the other candidate, for server-rendering the public record, but its build calls TypeScript's JavaScript compiler API, and the repo's TypeScript 7 has none; it would need a second, older compiler pinned for one package.

- Vite builds the app; React renders it; React Router maps the routes; TanStack Query does every read and polls the jar and draft pages every 10 seconds.
- One React context provides the SDK and the proof reader, so screen tests run the real screens over a recording stand-in.
- The backend is reached at `/api` on the app's own origin: Vite's dev and preview proxy forwards it locally, and the host adds the same rewrite, so the backend needs no CORS.
- One theme file (`app/src/theme.css`) holds every colour, font, size and spacing value, so the landing page's look can replace it without touching a component.

## Consequences

- The public record renders in the browser, so a reader without JavaScript sees nothing there. The landing page (H2) and the README carry the demo's real transactions in plain HTML for them.
