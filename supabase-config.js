/*
 * supabase-config.js  -  Realism Roleplay multiplayer backend settings
 * ===========================================================================
 * Loaded by index.html BEFORE realism-multiplayer.js. Edit, save, hard refresh.
 *
 *  1. Create a free project at https://supabase.com
 *  2. Project Settings → API Keys:
 *        Project URL          ->  url
 *        Publishable key      ->  anonKey   (starts with sb_publishable_)
 *                                  OR the legacy "anon" JWT if you click
 *                                  "View legacy API keys"
 *  3. Run supabase/schema.sql in the SQL Editor.
 *  4. Paste the values below, save, hard refresh (Ctrl+Shift+R). Done.
 *
 *  ── Which key do I use? ───────────────────────────────────────────────
 *  Supabase has TWO key systems. Either of the browser-safe ones works:
 *
 *    NEW (recommended, future-proof):
 *       sb_publishable_…        ← paste this. It's the new "anon" key.
 *       (NEVER use sb_secret_…  — that's the new service_role, blocked in browser)
 *
 *    LEGACY (retires early 2027, still works — click "View legacy API keys"):
 *       anon (JWT)              ← paste this.
 *       (NEVER use service_role — blocked in browser)
 *
 *  Browser-safe keys (publishable / anon) are designed to be public — they are
 *  gated by Row Level Security, not secrecy. Never put sb_secret_ or
 *  service_role in a browser; they bypass RLS.
 */
window.SUPABASE_CONFIG = {
	// --- REQUIRED ---------------------------------------------------------
	url: 'https://tnyylkhvzoevznbkctcd.supabase.co',
	// Paste the PUBLISHABLE key (sb_publishable_…) OR the legacy anon JWT.
	anonKey: 'sb_publishable_xSrdhtpPgN4iLdyxakYjVw_Wy17fWcv',

	// --- Optional tuning --------------------------------------------------
	multiplayer: {
		// Times per second the local player broadcasts its position/rotation.
		sendRateHz: 20,

		// Seconds between session heartbeats (keeps the player "online" in the
		// server count). Must be under the 30s freshness window in schema.sql.
		heartbeatSeconds: 5,

		// Seconds the server browser waits between auto-refreshes while open.
		browserRefreshSeconds: 5,

		// Maximum remote avatars drawn at once (safety cap).
		maxAvatars: 32,

		// When true, the console logs join/leave/sync activity for debugging.
		verbose: false,
	},
};
