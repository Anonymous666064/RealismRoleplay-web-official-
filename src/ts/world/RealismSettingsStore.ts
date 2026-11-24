/*
 * RealismSettingsStore.ts
 * -----------------------
 * The player's own settings from the Settings menu (start screen / pause menu), kept in
 * localStorage so they come back on the next visit. They are merged over realism-config.js
 * while the world loads, so localStorage always wins over the config defaults.
 *
 * Key:    'realismRoleplay.settings.v1'
 * Format: JSON, every field optional (see SavedSettings). Delete the key (or press
 *         "Reset to defaults" in Settings) to go back to realism-config.js.
 */

export const SETTINGS_KEY = 'realismRoleplay.settings.v1';

export interface SavedSettings
{
	v?: number;
	/** 'auto' | 'low' | 'medium' | 'high' | 'ultra' */
	preset?: string;
	/** Values changed with the sliders, on top of the preset (any PerformancePreset field). */
	perf?: { [key: string]: any };
	brightness?: number;
	targetFps?: number;
	adaptive?: boolean;
	showFps?: boolean;
	treeNearModels?: number;
	treeNearDistance?: number;
	npcDensity?: number;
	dayNight?: { enabled?: boolean; cycleMinutes?: number; hour?: number };
	/** 0..1 */
	volume?: number;
	mouseSensitivity?: number;
	/** Show Sketchbook's dat.GUI developer panel (top right). */
	devPanel?: boolean;
}

function storage(): any
{
	try
	{
		const w: any = typeof window !== 'undefined' ? window : null;
		const ls = w && w.localStorage ? w.localStorage : (typeof localStorage !== 'undefined' ? localStorage : null);
		return ls && typeof ls.getItem === 'function' ? ls : null;
	}
	catch (e) { return null; }   // privacy mode / file:// can throw
}

export function readSaved(): SavedSettings
{
	const ls = storage();
	if (!ls) return {};
	try
	{
		const raw = ls.getItem(SETTINGS_KEY);
		if (!raw) return {};
		const s = JSON.parse(raw);
		return s && typeof s === 'object' ? s : {};
	}
	catch (e) { return {}; }
}

export function writeSaved(s: SavedSettings): void
{
	const ls = storage();
	if (!ls) return;
	try { s.v = 1; ls.setItem(SETTINGS_KEY, JSON.stringify(s)); }
	catch (e) { /* quota / privacy mode: settings just aren't kept */ }
}

export function clearSaved(): void
{
	const ls = storage();
	if (!ls) return;
	try { ls.removeItem(SETTINGS_KEY); } catch (e) { /* ignore */ }
}

function num(v: any): boolean { return typeof v === 'number' && isFinite(v); }

/**
 * Merges the saved settings into the loaded config (called by loadRealismSettings, before the
 * world is built, so preset, distances and baked shadows are right from the first frame).
 * The config's own performance.overrides are kept as performance.configOverrides, so picking a
 * preset in the menu can start again from "preset + realism-config.js" without the old sliders.
 */
export function applySavedToConfig(s: any, saved?: SavedSettings): void
{
	if (!s || !s.performance) return;
	const sv = saved || readSaved();
	// copies: the merged config can still share objects with DEFAULT_SETTINGS
	s.performance = Object.assign({}, s.performance);
	if (s.vegetation) s.vegetation = Object.assign({}, s.vegetation);
	const perf = s.performance;
	perf.configOverrides = Object.assign({}, perf.overrides || {});
	if (typeof sv.preset === 'string' && (sv.preset === 'auto' || (perf.presets && perf.presets[sv.preset]))) perf.preset = sv.preset;
	if (sv.perf && typeof sv.perf === 'object') perf.overrides = Object.assign({}, perf.overrides || {}, sv.perf);
	if (num(sv.brightness)) perf.brightness = Math.max(0.2, Math.min(1.2, sv.brightness));
	if (num(sv.targetFps)) perf.targetFps = Math.max(15, Math.min(120, sv.targetFps));
	if (typeof sv.adaptive === 'boolean') perf.adaptive = sv.adaptive;
	if (typeof sv.showFps === 'boolean') perf.showFps = sv.showFps;
	if (s.vegetation)
	{
		if (num(sv.treeNearModels)) s.vegetation.nearModels = Math.max(0, Math.round(sv.treeNearModels));
		if (num(sv.treeNearDistance)) s.vegetation.nearDistance = Math.max(0, sv.treeNearDistance);
	}
	if (sv.dayNight && typeof sv.dayNight === 'object')
	{
		const dn: any = Object.assign({}, s.dayNight || {});
		if (typeof sv.dayNight.enabled === 'boolean') dn.enabled = sv.dayNight.enabled;
		if (num(sv.dayNight.cycleMinutes)) dn.cycleMinutes = sv.dayNight.cycleMinutes;
		if (num(sv.dayNight.hour)) dn.startHour = sv.dayNight.hour;
		s.dayNight = dn;
	}
}
