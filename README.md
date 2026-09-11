PROPERTY MANAGER — FINAL ONLINE BUILD

Architecture
- Cloudflare Pages hosts the browser app.
- Supabase provides authentication and the PostgreSQL database.
- The browser keeps a short-lived active session only: every new visit requires a fresh sign-in.
- After sign-in, local IndexedDB/localStorage caches the current user's working records so the app can keep working if the internet disappears.
- Every add/edit/delete is applied to the screen immediately and queued for Supabase in the background.
- Failed cloud writes stay in the offline queue and are retried when the connection returns or when Sync now is pressed.

Setup
1. Create a Supabase project.
2. In Supabase SQL Editor, run supabase-schema.sql in full.
3. Create/confirm a user under Authentication.
4. Put your Supabase URL and browser-safe publishable/anon key in config.js.
5. Test with a local web server (for example VS Code Live Server).
6. Push the folder to GitHub.
7. Connect the repository to Cloudflare Pages using a static/None framework preset and output directory '.'.

Important
- Never put a Supabase service_role or secret key in config.js.
- For the first sign-in, the browser needs internet access.
- Once signed in, changes made while offline are saved locally and sync later.
- Because sessions are intentionally not persisted, closing/reloading the browser requires signing in again. An offline user who has fully closed/reloaded the page cannot authenticate again until internet is available.
