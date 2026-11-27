/*
 * supabase-config.js  -  Realism Roleplay multiplayer backend settings
 *
 * Prefilled from your working "Supabase 3D Arena" template.
 * If you need to change projects: Supabase → Settings → API.
 *   url     = Project URL
 *   anonKey = the PUBLISHABLE key (sb_publishable_…) or legacy anon JWT
 *   NEVER use sb_secret_ or service_role in a browser.
 */
window.SUPABASE_CONFIG = {
	url: 'https://tnyylkhvzoevznbkctcd.supabase.co',
	anonKey: 'sb_publishable_xSrdhtpPgN4iLdyxakYjVw_Wy17fWcv',
	multiplayer: {
		sendRateHz: 20,            // position broadcasts per second (on movement)
		heartbeatSeconds: 5,       // session heartbeat for the player count
		browserRefreshSeconds: 5,  // server browser auto-refresh
		maxAvatars: 32,            // max remote players drawn
	},
};
