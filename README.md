# footclaim-site

Public pages for Footclaim: home, live map, privacy policy and terms of use. Plain HTML, CSS and JS, served by GitHub Pages.

The live map (`map.html`, `map.js`, `map.css`) reads public game data straight from Supabase with the publishable key: the
database lets visitors read only what players see in the app (`zones_in_view`, `zone_by_id`, `leaderboard`). The map itself is
Google Maps with a browser key restricted to footclaim.app. A zone's page is `footclaim.app/map?z=<zone id>`, which is what the
app's Share button sends.
The game's code lives in the private repository; nothing here is secret.

Fonts (Barlow Condensed, Manrope) are served from this site under the SIL Open Font License (see `fonts/`).
