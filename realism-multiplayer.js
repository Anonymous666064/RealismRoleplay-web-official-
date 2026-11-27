/*
 * realism-multiplayer.js  -  Online multiplayer + server browser + character creation
 *  for Realism Roleplay.
 * ============================================================================
 *  Built following the proven "Supabase 3D Arena" template patterns:
 *    - createClient(url, key) — no extra realtime config
 *    - channel config: presence.key + broadcast.self=false
 *    - avatars created FROM broadcast data (flat scalars, never origin)
 *    - broadcast on movement (20 Hz max) + initial burst + re-broadcast on peer join
 *
 *  Requires:
 *    - window.SUPABASE_CONFIG   (supabase-config.js)
 *    - window.supabase          (CDN: unpkg @supabase/supabase-js@2)
 *    - window.THREE             (bundled with the game)
 *    - window.realismWorld      (set by index.html)
 *
 *  Console: RRMP.debug()
 */
(function ()
{
	'use strict';

	if (window.RRMP) return;

	const $ = (sel, root) => (root || document).querySelector(sel);
	const el = (tag, cls, html) =>
	{
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html != null) e.innerHTML = html;
		return e;
	};
	const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
	const lerp = (a, b, t) => a + (b - a) * t;
	const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
	const log = (...a) => console.log('[RRMP]', ...a);
	const warn = (...a) => console.warn('[RRMP]', ...a);

	const RRMP = window.RRMP = {
		config: { sendRateHz: 20, heartbeatSeconds: 5, browserRefreshSeconds: 5, maxAvatars: 32 },
		supabase: null,
		world: null,
		disabled: false,
		disabledReason: null,
		stats: { channelStatus: null, presenceCount: 0, sent: 0, recv: 0 },
		combat: { health: 100, kills: 0, deaths: 0 },
	};
	const POLICE_RADIO_CHANNELS = ['County Dispatch', 'Police 1', 'Sheriff 1', 'County Tactical', 'Countywide'];
	const policeRadioListeners = [];

	// ======================================================================
	//  Identity — persistent character (localStorage) + fresh connId per load
	//  (Template pattern: fresh UUID per page load so tabs never collide.)
	// ======================================================================
	const connId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) =>
	{
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	});
	const identity = RRMP.identity = {
		connId: connId,
		name: 'Player_' + connId.slice(0, 4),
		skinColor: '#c68642',
		gender: 'male',
		load()
		{
			try
			{
				const c = JSON.parse(localStorage.getItem('rrmp_character') || '{}');
				if (c.name) this.name = String(c.name).slice(0, 16);
				if (c.skinColor) this.skinColor = String(c.skinColor);
				if (c.gender === 'female' || c.gender === 'male') this.gender = c.gender;
			} catch (e) { /* ignore */ }
		},
		save(name, skin, gender)
		{
			this.name = String(name || 'Player').trim().slice(0, 16) || 'Player';
			this.skinColor = skin || '#c68642';
			this.gender = gender === 'female' ? 'female' : 'male';
			localStorage.setItem('rrmp_character', JSON.stringify({ name: this.name, skinColor: this.skinColor, gender: this.gender }));
			const world = RRMP.world;
			if (world && typeof world.realismSetPlayerGender === 'function') world.realismSetPlayerGender(this.gender);
		},
	};

	// ======================================================================
	//  Config init
	// ======================================================================
	function initConfig()
	{
		const cfg = window.SUPABASE_CONFIG || {};
		if (!cfg.url || !cfg.anonKey ||
			cfg.url.indexOf('YOUR-PROJECT') >= 0 ||
			cfg.anonKey.indexOf('YOUR-') >= 0)
		{
			warn('Supabase not configured — fill in supabase-config.js.');
			RRMP.disabled = true;
			RRMP.disabledReason = 'not configured';
			return false;
		}
		if (!window.supabase || typeof window.supabase.createClient !== 'function')
		{
			warn('supabase-js not loaded. Did index.html load the CDN?');
			RRMP.disabled = true;
			RRMP.disabledReason = 'supabase-js not loaded';
			return false;
		}
		// EXACTLY like the template: no extra realtime config.
		RRMP.supabase = window.supabase.createClient(cfg.url, cfg.anonKey);
		const mp = cfg.multiplayer || {};
		RRMP.config.sendRateHz = clamp(mp.sendRateHz || 20, 1, 60);
		RRMP.config.heartbeatSeconds = clamp(mp.heartbeatSeconds || 5, 2, 25);
		RRMP.config.browserRefreshSeconds = clamp(mp.browserRefreshSeconds || 5, 2, 60);
		RRMP.config.maxAvatars = clamp(mp.maxAvatars || 32, 1, 128);
		log('Supabase client ready');
		return true;
	}

	// ======================================================================
	//  Debug
	// ======================================================================
	RRMP.debug = function ()
	{
		console.group('%c[RRMP] Debug', 'color:#9fc0ff;font-weight:bold');
		console.log('connId:', connId);
		console.log('server:', session.server ? session.server.name : '(not joined)');
		console.log('channel:', session.channel ? 'exists' : 'null');
		console.log('status:', RRMP.stats.channelStatus);
		console.log('presence count:', RRMP.stats.presenceCount);
		console.log('broadcasts sent:', RRMP.stats.sent, '| received:', RRMP.stats.recv);
		console.log('remote avatars:', Object.keys(remotePlayers).length);
		console.log('remote ids:', Object.keys(remotePlayers).map((k) => k.slice(0, 8)));
		if (session.channel)
		{
			try
			{
				const st = session.channel.presenceState();
				console.log('presenceState:', Object.keys(st).length, 'entries');
			} catch (e) { /* ignore */ }
		}
		console.groupEnd();
		return RRMP.stats;
	};

	// ======================================================================
	//  DB helpers (server registry + session rows for player counts)
	// ======================================================================
	const db = RRMP.db = {
		async listServers()
		{
			const { data, error } = await RRMP.supabase.rpc('list_servers');
			if (error) throw error;
			return data || [];
		},
		async getByCode(code)
		{
			const { data, error } = await RRMP.supabase.rpc('get_server_by_code', { p_code: code });
			if (error) throw error;
			return data && data.length ? data[0] : null;
		},
		async createServer(name, isPublic, code, maxPlayers)
		{
			const row = {
				name: String(name).trim().slice(0, 40) || 'New Server',
				is_public: !!isPublic,
				join_code: isPublic ? null : (code || genCode()).toUpperCase(),
				owner_id: null,
				max_players: clamp(parseInt(maxPlayers, 10) || 16, 1, 64),
				seed: 1337,
				is_default: false,
			};
			const { data, error } = await RRMP.supabase.from('servers').insert(row).select().single();
			if (error) throw error;
			return data;
		},
		async joinSession(serverId)
		{
			const { error } = await RRMP.supabase.from('server_sessions')
				.insert({ server_id: serverId, player_id: connId, player_name: identity.name, skin_color: identity.skinColor });
			if (error) throw error;
		},
		async heartbeat(serverId)
		{
			await RRMP.supabase.from('server_sessions')
				.update({ last_seen: new Date().toISOString(), player_name: identity.name, skin_color: identity.skinColor })
				.eq('player_id', connId).eq('server_id', serverId);
		},
		async leaveSession(serverId)
		{
			await RRMP.supabase.from('server_sessions').delete()
				.eq('player_id', connId).eq('server_id', serverId);
		},
		async reap()
		{
			try { await RRMP.supabase.rpc('reap_stale_sessions'); } catch (e) { /* non-fatal */ }
		},
	};

	function genCode()
	{
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
		let s = '';
		for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
		return s;
	}

	// ======================================================================
	//  Local player helpers
	// ======================================================================
	function getLocalPlayer()
	{
		const w = RRMP.world;
		if (!w) return null;
		const im = w.inputManager;
		if (im && im.controllingCharacter) return im.controllingCharacter;
		if (w.characters && w.characters.length) return w.characters[0];
		return null;
	}

	function readLocalTransform()
	{
		const ch = getLocalPlayer();
		if (!ch) return null;
		let x = 0, y = 0, z = 0, ry = 0;
		try
		{
			const THREE = window.THREE;
			const p = new THREE.Vector3();
			const direction = new THREE.Vector3();
			ch.getWorldPosition(p);
			ch.getWorldDirection(direction);
			x = p.x; y = p.y; z = p.z;
			ry = Math.atan2(direction.x, direction.z);
		} catch (e) { /* ignore */ }
		const transform = { x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), ry: +ry.toFixed(3) };
		const seatBlend = Number(ch.seatBlendOverride);
		transform.seatBlend = seatBlend >= 0
			? Math.max(0, Math.min(1, seatBlend))
			: (ch.occupyingSeat && ch.physicsEnabled === false ? 1 : 0);
		const seat = ch.occupyingSeat;
		const vehicle = seat && seat.vehicle;
		if (vehicle)
		{
			const id = vehicleId(vehicle);
			const body = vehicle.collision;
			transform.vehicle = {
				id,
				driver: vehicle.controllingCharacter === ch,
				seat: Array.isArray(vehicle.seats) ? vehicle.seats.indexOf(seat) : -1,
				type: typeof vehicle.realismType === 'string' ? vehicle.realismType :
					(vehicle.entityType === 1 ? 'airplane' : vehicle.entityType === 3 ? 'heli' : 'car'),
				x: body.position.x, y: body.position.y, z: body.position.z,
				qx: body.quaternion.x, qy: body.quaternion.y, qz: body.quaternion.z, qw: body.quaternion.w,
				vx: body.velocity.x, vy: body.velocity.y, vz: body.velocity.z,
			};
		}
		transform.gender = ch.realismGender === 'female' ? 'female' : identity.gender;
		transform.modelScale = Number(ch.modelScale) || 1.7;
		return transform;
	}

	function vehicleId(vehicle)
	{
		const w = RRMP.world;
		try
		{
			const owned = w && w.realismOwnedCars && w.realismOwnedCars.recordFor(vehicle);
			if (owned && owned.id) return 'owned:' + owned.id;
		} catch (e) { /* vehicle may not be registered as owned */ }
		const point = vehicle && vehicle.spawnPoint;
		if (point)
		{
			const THREE = window.THREE;
			const pos = new THREE.Vector3();
			point.getWorldPosition(pos);
			return 'spawn:' + (point.name || 'vehicle') + ':' + [pos.x, pos.y, pos.z].map((v) => Math.round(v * 10) / 10).join(',');
		}
		return vehicle && vehicle.name ? 'named:' + vehicle.name : null;
	}

	function setBodyPose(body, pose)
	{
		if (!body || !pose) return;
		body.position.set(pose.x, pose.y, pose.z);
		body.interpolatedPosition.set(pose.x, pose.y, pose.z);
		body.previousPosition.set(pose.x, pose.y, pose.z);
		body.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
		body.interpolatedQuaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
		body.velocity.set(pose.vx || 0, pose.vy || 0, pose.vz || 0);
		body.aabbNeedsUpdate = true;
		if (body.wakeUp) body.wakeUp();
	}

	function applySkinColor(color)
	{
		const ch = getLocalPlayer();
		if (!ch) return;
		const obj = ch.model || ch.threeObject || ch.mesh || (ch.isObject3D ? ch : null);
		if (!obj) return;
		obj.traverse((node) =>
		{
			if (!node.isMesh || !node.material) return;
			if (!node.__rrmpOwned)
			{
				node.__rrmpOwned = true;
				node.material = Array.isArray(node.material) ? node.material.map((m) => m.clone()) : node.material.clone();
			}
			(Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => { if (m && m.color) try { m.color.set(color); } catch (e) { /* ignore */ } });
		});
		ch.__rrmpSkin = color;
	}

	let _lastPlayerRef = null;
	function maintainSkin()
	{
		const ch = getLocalPlayer();
		if (!ch) { _lastPlayerRef = null; return; }
		if (ch === _lastPlayerRef && ch.__rrmpSkin === identity.skinColor) return;
		_lastPlayerRef = ch;
		applySkinColor(identity.skinColor);
	}

	// ======================================================================
	//  Remote players — created FROM broadcast data (template pattern)
	// ======================================================================
	function makeTextSprite(text)
	{
		const THREE = window.THREE;
		const c = document.createElement('canvas');
		c.width = 256; c.height = 64;
		const g = c.getContext('2d');
		g.font = 'bold 30px Solway, Arial, sans-serif';
		g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 5;
		g.textAlign = 'center'; g.textBaseline = 'middle';
		g.strokeText(text, 128, 32);
		g.fillStyle = '#fff';
		g.fillText(text, 128, 32);
		const tex = new THREE.CanvasTexture(c);
		const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
		const s = new THREE.Sprite(mat);
		s.scale.set(1.4, 0.35, 1);
		return s;
	}

	const remotePlayers = RRMP.remotePlayers = Object.create(null);
	const remoteVehicles = RRMP.remoteVehicles = Object.create(null);
	const remoteVehicleTargets = Object.create(null);

	function normalizeGender(value)
	{
		return value === 'female' ? 'female' : 'male';
	}

	function cloneModelMaterials(model)
	{
		model.traverse((node) =>
		{
			if (!node.isMesh || !node.material) return;
			node.frustumCulled = false;
			node.material = Array.isArray(node.material) ? node.material.map((material) => material.clone()) : node.material.clone();
		});
	}

	function applyRemoteSkin(rp)
	{
		if (!rp.model) return;
		rp.model.traverse((node) =>
		{
			if (!node.isMesh || !node.material) return;
			(Array.isArray(node.material) ? node.material : [node.material]).forEach((material) =>
			{
				if (material && material.color) material.color.set(rp.skin);
			});
		});
	}

	function fitRemoteModel(rp)
	{
		if (!rp.model || !rp.modelHeight) return;
		const settingsByGender = RRMP.world && RRMP.world.realismPlayerModelSettings || {};
		const settings = settingsByGender[rp.gender] || {};
		const height = Number(settings.height) > 0 ? Number(settings.height) : 1.7;
		const modelScale = Number(settings.scale) > 0 ? clamp(Number(settings.scale), 0.01, 5) : 1;
		const seatedScale = Number(settings.seatedScale) > 0 ? clamp(Number(settings.seatedScale), 0.01, 5) : 0.72;
		const blend = clamp(Number(rp.seatBlend) || 0, 0, 1);
		const scale = (height / rp.modelHeight) * modelScale * (1 + (seatedScale - 1) * blend);
		const y = Number.isFinite(Number(settings.y)) ? Number(settings.y) : 0;
		const seatedY = Number.isFinite(Number(settings.seatedY)) ? Number(settings.seatedY) : 0;
		const yOffset = y + (seatedY - y) * blend;
		rp.model.scale.setScalar(scale);
		rp.model.position.y = -0.57 * rp.modelScale - rp.modelMinY * scale + yOffset;
		rp.label.position.y = height * modelScale * (1 + (seatedScale - 1) * blend) - 0.57 * rp.modelScale + yOffset + 0.1;
	}

	function setRemoteAnimation(rp, state)
	{
		if (!rp.mixer || rp.animationState === state) return;
		const preferred = state === 'idle' ? ['idle', 'walk', 'run'] : state === 'run' ? ['run', 'walk'] : ['walk', 'run'];
		let clip = null;
		for (let i = 0; i < preferred.length && !clip; i++)
		{
			clip = (rp.animations || []).find((item) => item && String(item.name).toLowerCase() === preferred[i]);
		}
		if (!clip) return;
		const isFrozenIdle = state === 'idle' && String(clip.name).toLowerCase() !== 'idle';
		const action = rp.mixer.clipAction(clip);
		rp.mixer.stopAllAction();
		action.reset();
		action.fadeIn(0.15);
		action.play();
		action.setEffectiveTimeScale(isFrozenIdle ? 0 : 1);
		rp.animationState = state;
	}

	function loadRemotePlayerModel(id, rp, gender)
	{
		const world = RRMP.world;
		if (!world || typeof world.realismLoadPlayerModel !== 'function')
		{
			warn('remote player model loader is unavailable');
			return;
		}
		const token = rp.modelRequest = (rp.modelRequest || 0) + 1;
		rp.modelLoading = gender;
		world.realismLoadPlayerModel(gender, (asset) =>
		{
			if (remotePlayers[id] !== rp || rp.modelRequest !== token || rp.gender !== gender) return;
			const model = asset.scene;
			cloneModelMaterials(model);
			model.updateMatrixWorld(true);
			const bounds = new window.THREE.Box3().setFromObject(model);
			const height = bounds.max.y - bounds.min.y;
			if (!Number.isFinite(height) || height <= 0)
			{
				warn('remote player model has invalid bounds:', gender);
				return;
			}
			if (rp.mixer) rp.mixer.stopAllAction();
			if (rp.model)
			{
				rp.group.remove(rp.model);
				disposeRemoteGroup(rp.model);
			}
			const visual = new window.THREE.Group();
			visual.add(model);
			rp.model = visual;
			rp.modelHeight = height;
			rp.modelMinY = bounds.min.y;
			rp.animations = asset.animations || [];
			rp.mixer = new window.THREE.AnimationMixer(model);
			rp.animationState = null;
			rp.modelLoading = null;
			rp.group.add(visual);
			fitRemoteModel(rp);
			applyRemoteSkin(rp);
			setRemoteAnimation(rp, 'idle');
		}, () => warn('could not load remote player model:', gender));
	}

	function createRemotePlayer(data)
	{
		const THREE = window.THREE;
		const w = RRMP.world;
		if (!THREE || !w || !w.graphicsWorld) { warn('createRemotePlayer: no THREE/scene'); return; }
		const group = new THREE.Group();
		const label = makeTextSprite(data.name || 'Player');
		group.add(label);
		// Position comes FROM the broadcast data — never origin.
		group.position.set(Number(data.x) || 0, Number(data.y) || 0, Number(data.z) || 0);
		w.graphicsWorld.add(group);
		const rp = remotePlayers[data.id] = {
			group, label, name: data.name || 'Player', skin: data.skin || '#c68642',
			gender: normalizeGender(data.gender), modelScale: clamp(Number(data.modelScale) || 1.7, 0.3, 3),
			seatBlend: clamp(Number(data.seatBlend) || 0, 0, 1),
			tx: Number(data.x) || 0, ty: Number(data.y) || 0, tz: Number(data.z) || 0,
			tryaw: Number(data.ry) || 0, model: null, modelHeight: 0, modelMinY: 0,
			mixer: null, animations: [], animationState: null, modelRequest: 0, modelLoading: null,
		};
		loadRemotePlayerModel(data.id, rp, rp.gender);
		log('remote player created:', (data.id || '').slice(0, 8), data.name, 'at', (data.x || 0).toFixed(1), (data.y || 0).toFixed(1), (data.z || 0).toFixed(1));
	}

	function updateRemotePlayer(data)
	{
		if (!data || typeof data.id !== 'string' || data.id === connId ||
			![data.x, data.y, data.z].every((v) => Number.isFinite(Number(v)))) return;
		data = Object.assign({}, data, { x: Number(data.x), y: Number(data.y), z: Number(data.z), ry: Number(data.ry) || 0 });
		if (!remotePlayers[data.id]) createRemotePlayer(data);
		const rp = remotePlayers[data.id];
		if (!rp) return;
		rp.tx = Number(data.x) || 0; rp.ty = Number(data.y) || 0; rp.tz = Number(data.z) || 0; rp.tryaw = Number(data.ry) || 0;
		if (Number.isFinite(Number(data.seatBlend))) rp.seatBlend = clamp(Number(data.seatBlend), 0, 1);
		if (data.name && rp.name !== data.name)
		{
			rp.name = data.name;
			rp.group.remove(rp.label);
			if (rp.label.material.map) rp.label.material.map.dispose();
			rp.label.material.dispose();
			rp.label = makeTextSprite(data.name);
			rp.group.add(rp.label);
			fitRemoteModel(rp);
		}
		const gender = normalizeGender(data.gender);
		if (rp.gender !== gender)
		{
			rp.gender = gender;
			loadRemotePlayerModel(data.id, rp, gender);
		}
		const modelScale = clamp(Number(data.modelScale) || rp.modelScale, 0.3, 3);
		if (modelScale !== rp.modelScale) { rp.modelScale = modelScale; fitRemoteModel(rp); }
		if (data.skin && rp.skin !== data.skin) { rp.skin = data.skin; applyRemoteSkin(rp); }
		if (data.vehicle && data.vehicle.driver) updateRemoteVehicle(data.id, data.vehicle);
	}

	function normalizeVehicleType(type)
	{
		if (type === 1 || type === '1') return 'airplane';
		if (type === 3 || type === '3') return 'heli';
		if (type === 2 || type === '2') return 'car';
		return typeof type === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(type) ? type : 'car';
	}

	function createRemoteVehicle(id, vehicleType)
	{
		const THREE = window.THREE;
		const w = RRMP.world;
		if (!THREE || !w || !w.graphicsWorld) return null;
		if (remoteVehicles[id]) return remoteVehicles[id];
		const group = new THREE.Group();
		group.name = 'RRMP vehicle ' + id;
		w.graphicsWorld.add(group);
		remoteVehicles[id] = group;
		const type = normalizeVehicleType(vehicleType);
		if (typeof w.realismLoadVehicleModel !== 'function')
		{
			warn('remote vehicle model loader is unavailable:', type);
			return group;
		}
		w.realismLoadVehicleModel(type, (model) =>
		{
			if (remoteVehicles[id] !== group) return;
			group.add(model);
		}, () => warn('could not load remote vehicle model:', type));
		return group;
	}

	function updateRemoteVehicle(owner, vehicle)
	{
		if (!vehicle || !vehicle.id || ![vehicle.x, vehicle.y, vehicle.z, vehicle.qx, vehicle.qy, vehicle.qz, vehicle.qw].every(Number.isFinite)) return;
		const data = Object.assign({}, vehicle, { owner, receivedAt: Date.now() });
		remoteVehicleTargets[vehicle.id] = data;
		if (!findWorldVehicle(vehicle.id) && !remoteVehicles[vehicle.id]) createRemoteVehicle(vehicle.id, data.type);
	}

	function disposeRemoteGroup(group)
	{
		group.traverse((node) =>
		{
			if (!node.material) return;
			const materials = Array.isArray(node.material) ? node.material : [node.material];
			materials.forEach((material) =>
			{
				if (node.isSprite && material.map) material.map.dispose();
				material.dispose();
			});
		});
	}

	function findWorldVehicle(id)
	{
		const w = RRMP.world;
		if (!w || !Array.isArray(w.vehicles)) return null;
		for (const vehicle of w.vehicles)
		{
			if (vehicleId(vehicle) === id) return vehicle;
		}
		return null;
	}

	function removeRemotePlayer(id)
	{
		const rp = remotePlayers[id];
		if (!rp) return;
		const w = RRMP.world;
		if (w && w.graphicsWorld) w.graphicsWorld.remove(rp.group);
		disposeRemoteGroup(rp.group);
		delete remotePlayers[id];
		for (const vehicleIdValue in remoteVehicleTargets)
		{
			if (remoteVehicleTargets[vehicleIdValue].owner !== id) continue;
			const localVehicle = findWorldVehicle(vehicleIdValue);
			if (localVehicle && localVehicle.controllingCharacter && localVehicle.controllingCharacter !== getLocalPlayer()) continue;
			delete remoteVehicleTargets[vehicleIdValue];
			const proxy = remoteVehicles[vehicleIdValue];
			if (proxy)
			{
				if (w && w.graphicsWorld) w.graphicsWorld.remove(proxy);
				disposeRemoteGroup(proxy);
				delete remoteVehicles[vehicleIdValue];
			}
		}
		log('remote player removed:', id.slice(0, 8));
	}

	let shotSequence = 0;
	const receivedShotSequences = {};
	const shotRate = {};
	let playerDead = false;

	function rayHitsLocalPlayer(origin, direction, range)
	{
		const ch = getLocalPlayer();
		const w = RRMP.world;
		if (!ch || playerDead) return null;
		const THREE = window.THREE;
		const pos = new THREE.Vector3();
		ch.getWorldPosition(pos);
		const t = (pos.x - origin.x) * direction.x + (pos.y + 0.45 - origin.y) * direction.y + (pos.z - origin.z) * direction.z;
		if (t < 0 || t > range) return null;
		const y = origin.y + direction.y * t;
		const targetY = clamp(y, pos.y - 0.12, pos.y + 1.15);
		const dx = origin.x + direction.x * t - pos.x;
		const dy = origin.y + direction.y * t - targetY;
		const dz = origin.z + direction.z * t - pos.z;
		if (dx * dx + dy * dy + dz * dz > 0.45 * 0.45) return null;

		try
		{
			const from = { x: origin.x, y: origin.y, z: origin.z };
			const to = { x: origin.x + direction.x * t, y: origin.y + direction.y * t, z: origin.z + direction.z * t };
			const cannon = window.CANNON;
			const result = cannon && new cannon.RaycastResult();
			if (result && w.physicsWorld)
			{
				const a = new cannon.Vec3(from.x, from.y, from.z);
				const b = new cannon.Vec3(to.x, to.y, to.z);
				// Character capsules are collision group 2; check walls and vehicle bodies only.
				// tslint:disable-next-line: no-bitwise
				const targetVehicle = ch.occupyingSeat && ch.occupyingSeat.vehicle && ch.occupyingSeat.vehicle.collision;
				if (w.physicsWorld.raycastClosest(a, b, { collisionFilterMask: ~2, skipBackfaces: true }, result) &&
					result.hasHit && result.body !== targetVehicle && result.distance < t - 0.2) return null;
			}
		} catch (e) { /* the hit still works if physics raycasting is unavailable */ }
		return t;
	}

	function receiveShot(payload)
	{
		if (!payload || payload.id === connId || typeof payload.id !== 'string') return;
		const seq = Number(payload.seq);
		if (!Number.isInteger(seq) || seq <= (receivedShotSequences[payload.id] || 0)) return;
		receivedShotSequences[payload.id] = seq;
		const now = performance.now();
		if (now - (shotRate[payload.id] || 0) < 30) return;
		shotRate[payload.id] = now;
		const shots = Array.isArray(payload.shots) ? payload.shots.slice(0, 16) : [payload];
		let totalDamage = 0;
		for (const shot of shots)
		{
			const origin = shot.origin, direction = shot.direction;
			if (!origin || !direction || ![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, shot.range, shot.damage].every(Number.isFinite)) continue;
			const range = clamp(shot.range, 0, 250);
			const damage = clamp(shot.damage, 0, 100);
			const len = Math.hypot(direction.x, direction.y, direction.z);
			if (range <= 0 || damage <= 0 || len < 0.0001) continue;
			const dir = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
			const distance = rayHitsLocalPlayer(origin, dir, range);
			if (distance === null) continue;
			const falloff = distance < range * 0.5 ? 1 : 1 - 0.5 * Math.min(1, (distance - range * 0.5) / (range * 0.5));
			totalDamage += damage * falloff;
		}
		if (totalDamage <= 0) return;
		RRMP.combat.health = Math.max(0, RRMP.combat.health - totalDamage);
		ui.updateHealth();
		if (RRMP.combat.health <= 0) eliminatePlayer(payload.id);
	}

	function eliminatePlayer(attackerId)
	{
		if (playerDead) return;
		playerDead = true;
		RRMP.combat.deaths++;
		ui.updateHealth();
		ui.toast('You were eliminated by ' + (remotePlayers[attackerId] ? remotePlayers[attackerId].name : 'another player'));
		if (session.channel)
		{
			session.channel.send({ type: 'broadcast', event: 'death', payload: { victim: connId, attacker: attackerId } });
		}
		const ch = getLocalPlayer();
		if (ch)
		{
			if (ch.resetControls) ch.resetControls();
			if (ch.occupyingSeat && ch.exitVehicle) ch.exitVehicle();
			ch.visible = false;
			if (RRMP.world && RRMP.world.inputManager && RRMP.world.cameraOperator)
			{
				RRMP.world.inputManager.setInputReceiver(RRMP.world.cameraOperator);
			}
		}
		setTimeout(() =>
		{
			const character = getLocalPlayer();
			const world = RRMP.world;
			if (character && world && world.respawnPosition)
			{
				if (character.controlledObject && character.stopControllingVehicle) character.stopControllingVehicle();
				if (character.parent !== world.graphicsWorld) world.graphicsWorld.attach(character);
				if (character.occupyingSeat && character.leaveSeat) character.leaveSeat();
				if (character.vehicleEntryInstance !== undefined) character.vehicleEntryInstance = null;
				if (character.setPhysicsEnabled) character.setPhysicsEnabled(false);
				character.setPosition(world.respawnPosition.x, world.respawnPosition.y + 1, world.respawnPosition.z);
				if (character.setPhysicsEnabled) character.setPhysicsEnabled(true);
				character.setPosition(world.respawnPosition.x, world.respawnPosition.y + 1, world.respawnPosition.z);
				if (character.resetVelocity) character.resetVelocity();
				character.visible = true;
				if (character.takeControl) character.takeControl();
			}
			playerDead = false;
			RRMP.combat.health = 100;
			ui.updateHealth();
			ui.toast('Respawned');
		}, 2500);
	}

	function receiveDeath(payload)
	{
		if (payload && payload.attacker === connId && payload.victim !== connId)
		{
			RRMP.combat.kills++;
			ui.updateHealth();
			ui.toast('Player eliminated');
		}
	}

	function maybeStartOnline()
	{
		const world = RRMP.world;
		const uiState = world && world.realismUI;
		if (!session.connected || !uiState || !uiState.loaded || uiState.state !== 'start') return;
		if (typeof uiState.play === 'function') uiState.play();
	}

	// ======================================================================
	//  Realtime — EXACTLY the template pattern
	// ======================================================================
	const session = RRMP.session = {
		server: null,
		channel: null,
		connected: false,
		lastSeenTransform: null,
		lastBroadcast: 0,
		heartbeatTimer: null,

		join(server)
		{
			if (this.channel) this.leave();
			this.server = server;
			// EXACTLY like the template:
			const channel = RRMP.supabase.channel('server:' + server.id, {
				config: {
					presence: { key: connId },
					broadcast: { self: false },
				},
			});
			this.channel = channel;

			channel
				.on('presence', { event: 'sync' }, () => this.onPresenceSync())
				.on('presence', { event: 'leave' }, ({ leftPresences }) =>
				{
					for (const p of leftPresences || []) removeRemotePlayer(p.key);
					this.updateCount();
				})
				.on('broadcast', { event: 'move' }, ({ payload }) =>
				{
					RRMP.stats.recv++;
					if (payload.id === connId) return;
					updateRemotePlayer(payload);
				})
				.on('broadcast', { event: 'shot' }, ({ payload }) => receiveShot(payload))
				.on('broadcast', { event: 'death' }, ({ payload }) => receiveDeath(payload))
				.on('broadcast', { event: 'police_radio' }, ({ payload }) =>
				{
					if (!payload || payload.id === connId || !payload.id || !this.server || payload.serverId !== this.server.id) return;
					if (POLICE_RADIO_CHANNELS.indexOf(payload.channel) < 0 ||
						(payload.department !== 'police' && payload.department !== 'sheriff')) return;
					if (typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 240) return;
					if (typeof payload.timestamp !== 'number' || Math.abs(Date.now() - payload.timestamp) > 60000) return;
					const safe = {
						id: String(payload.id).slice(0, 64),
						name: String(payload.name || 'Officer').slice(0, 16),
						channel: payload.channel,
						department: payload.department,
						unit: String(payload.unit || 'Unknown unit').slice(0, 24),
						message: payload.message.trim(),
						timestamp: payload.timestamp,
					};
					for (const listener of policeRadioListeners.slice())
					{
						try { listener(safe); } catch (e) { warn('police radio listener failed', e); }
					}
				})
				.subscribe(async (status, err) =>
				{
					console.log('[Realtime] status:', status, 'err:', err || '');
					RRMP.stats.channelStatus = status;
					ui.updateDebug();
					if (status === 'SUBSCRIBED')
					{
						try
						{
							await channel.track({ id: connId, name: identity.name, skin: identity.skinColor });
						}
						catch (trackError)
						{
							warn('presence track failed', trackError);
							return;
						}
						// Initial broadcast — same as template
						const payload = this.currentPayload();
						if (payload)
						{
							channel.send({ type: 'broadcast', event: 'move', payload });
							RRMP.stats.sent++;
						}
						db.joinSession(server.id).catch((e) => warn('session insert failed', e));
						if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
						this.heartbeatTimer = setInterval(() => db.heartbeat(server.id).catch(() => { /* non-fatal */ }), RRMP.config.heartbeatSeconds * 1000);
						this.connected = true;
						ui.showStatus(server);
						ui.showDebug();
						maybeStartOnline();
						log('SUBSCRIBED — connected to', server.name);
					}
					else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
					{
						this.connected = false;
						ui.updateStatusCount(RRMP.stats.presenceCount);
						warn('Realtime:', status, '— players will not sync');
					}
				});

			this.updateCount();
		},

		currentPayload()
		{
			const tr = readLocalTransform();
			if (!tr) return null;
			return {
				id: connId, name: identity.name, skin: identity.skinColor,
				gender: tr.gender, modelScale: tr.modelScale, seatBlend: tr.seatBlend,
				x: tr.x, y: tr.y, z: tr.z, ry: tr.ry, vehicle: tr.vehicle || null,
			};
		},

		onPresenceSync()
		{
			const state = this.channel ? this.channel.presenceState() : {};
			const online = Object.keys(state || {});
			RRMP.stats.presenceCount = online.length;
			// Remove avatars for players no longer online (template pattern)
			for (const id of Object.keys(remotePlayers)) if (!online.includes(id)) removeRemotePlayer(id);
			// When a NEW peer appears, re-broadcast our position so they can see us.
			// (The template misses this — standing-still players were invisible to joiners.)
			for (const id of online)
			{
				if (id === connId) continue;
				if (!remotePlayers[id] && !this._greeted) { /* noop */ }
				if (!this['seen_' + id])
				{
					this['seen_' + id] = true;
					log('new peer detected:', id.slice(0, 8), '— sending our position');
					const payload = this.currentPayload();
					if (payload)
					{
						this.channel.send({ type: 'broadcast', event: 'move', payload });
						RRMP.stats.sent++;
					}
				}
			}
			this.updateCount();
			ui.updateDebug();
		},

		updateCount()
		{
			try
			{
				const state = this.channel ? this.channel.presenceState() : {};
				const n = Object.keys(state || {}).length;
				RRMP.stats.presenceCount = n;
				ui.updateStatusCount(n);
			} catch (e) { /* ignore */ }
		},

		// Called every frame from the game loop — broadcast on movement (template pattern)
		tick()
		{
			if (!this.channel || RRMP.stats.channelStatus !== 'SUBSCRIBED') return;
			const tr = readLocalTransform();
			if (!tr) return;
			const prev = this.lastSeenTransform;
			const moved = !prev || Math.abs(prev.x - tr.x) > 0.05 || Math.abs(prev.y - tr.y) > 0.05 || Math.abs(prev.z - tr.z) > 0.05 || Math.abs(prev.ry - tr.ry) > 0.02;
			const now = performance.now();
			const interval = 1000 / RRMP.config.sendRateHz;
			// Broadcast on movement at sendRateHz, plus a 2s keepalive when idle
			if ((moved && now - this.lastBroadcast > interval) || now - this.lastBroadcast > 2000)
			{
				this.lastBroadcast = now;
				this.lastSeenTransform = tr;
				this.channel.send({ type: 'broadcast', event: 'move', payload: this.currentPayload() });
				RRMP.stats.sent++;
			}
		},

		// Per-frame avatar lerp
		lerpAvatars(dt)
		{
			const k = 1 - Math.pow(0.001, dt);
			for (const id in remotePlayers)
			{
				const rp = remotePlayers[id];
				const oldX = rp.group.position.x, oldZ = rp.group.position.z;
				rp.group.position.x = lerp(rp.group.position.x, rp.tx, k);
				rp.group.position.y = lerp(rp.group.position.y, rp.ty, k);
				rp.group.position.z = lerp(rp.group.position.z, rp.tz, k);
				const speed = Math.hypot(rp.group.position.x - oldX, rp.group.position.z - oldZ) / Math.max(dt, 0.001);
				setRemoteAnimation(rp, speed > 3.2 ? 'run' : speed > 0.25 ? 'walk' : 'idle');
				if (rp.mixer) rp.mixer.update(dt);
				let dyaw = rp.tryaw - rp.group.rotation.y;
				while (dyaw > Math.PI) dyaw -= Math.PI * 2;
				while (dyaw < -Math.PI) dyaw += Math.PI * 2;
				rp.group.rotation.y += dyaw * k;
			}
			for (const id in remoteVehicleTargets)
			{
				const target = remoteVehicleTargets[id];
				const localVehicle = findWorldVehicle(id);
				if (localVehicle)
				{
					if (localVehicle.controllingCharacter && localVehicle.controllingCharacter === getLocalPlayer()) continue;
					const body = localVehicle.collision;
					if (!body) continue;
					const THREE = window.THREE;
					const rotation = new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w)
						.slerp(new THREE.Quaternion(target.qx, target.qy, target.qz, target.qw), k);
					const pose = {
						x: lerp(body.position.x, target.x, k), y: lerp(body.position.y, target.y, k), z: lerp(body.position.z, target.z, k),
						qx: rotation.x, qy: rotation.y, qz: rotation.z, qw: rotation.w,
						vx: target.vx || 0, vy: target.vy || 0, vz: target.vz || 0,
					};
					setBodyPose(body, pose);
					continue;
				}
				const proxy = remoteVehicles[id] || createRemoteVehicle(id, target.type);
				if (proxy)
				{
					proxy.position.set(lerp(proxy.position.x, target.x, k), lerp(proxy.position.y, target.y, k), lerp(proxy.position.z, target.z, k));
					proxy.quaternion.slerp(new window.THREE.Quaternion(target.qx, target.qy, target.qz, target.qw), k);
					proxy.updateMatrixWorld();
				}
			}
		},

		leave()
		{
			this.connected = false;
			if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
			if (this.channel) { try { this.channel.unsubscribe(); } catch (e) { /* ignore */ } this.channel = null; }
			for (const id of Object.keys(remotePlayers)) removeRemotePlayer(id);
			if (this.server) db.leaveSession(this.server.id).catch(() => { /* non-fatal */ });
			this.server = null;
			this.lastSeenTransform = null;
			playerDead = false;
			RRMP.combat.health = 100;
			RRMP.stats = { channelStatus: null, presenceCount: 0, sent: 0, recv: 0 };
			ui.updateHealth();
			ui.hideStatus(); ui.hideDebug();
			log('left server');
		},
	};

	RRMP.broadcastShot = function (shot)
	{
		const channel = session.channel;
		if (!channel || !session.connected || RRMP.stats.channelStatus !== 'SUBSCRIBED') return;
		shotSequence++;
		channel.send({
			type: 'broadcast',
			event: 'shot',
			payload: Object.assign({ id: connId, seq: shotSequence }, shot),
		});
		RRMP.stats.sent++;
	};
	RRMP.broadcastShots = function (shots)
	{
		const channel = session.channel;
		if (!channel || !session.connected || RRMP.stats.channelStatus !== 'SUBSCRIBED' || !Array.isArray(shots) || !shots.length) return;
		shotSequence++;
		channel.send({
			type: 'broadcast',
			event: 'shot',
			payload: { id: connId, seq: shotSequence, shots: shots.slice(0, 16) },
		});
		RRMP.stats.sent++;
	};
	RRMP.getRemoteRadarVehicles = function ()
	{
		const now = Date.now();
		const result = [];
		for (const id in remoteVehicleTargets)
		{
			const vehicle = remoteVehicleTargets[id];
			if (!vehicle || now - vehicle.receivedAt > 2500 ||
				![vehicle.x, vehicle.y, vehicle.z, vehicle.vx, vehicle.vy, vehicle.vz].every(Number.isFinite)) continue;
			result.push({ id: id, x: vehicle.x, y: vehicle.y, z: vehicle.z, vx: vehicle.vx, vy: vehicle.vy, vz: vehicle.vz });
		}
		return result;
	};

	RRMP.onPoliceRadio = function (listener)
	{
		if (typeof listener !== 'function') return function () {};
		policeRadioListeners.push(listener);
		return function ()
		{
			const index = policeRadioListeners.indexOf(listener);
			if (index >= 0) policeRadioListeners.splice(index, 1);
		};
	};
	RRMP.sendPoliceRadio = function (message)
	{
		const channel = session.channel;
		if (!channel || !session.connected || RRMP.stats.channelStatus !== 'SUBSCRIBED' || !session.server || !message) return false;
		if (POLICE_RADIO_CHANNELS.indexOf(message.channel) < 0 ||
			(message.department !== 'police' && message.department !== 'sheriff') ||
			typeof message.message !== 'string' || !message.message.trim()) return false;
		const payload = {
			id: connId,
			name: String(identity.name || 'Officer').slice(0, 16),
			serverId: session.server.id,
			channel: message.channel,
			department: message.department,
			unit: String(message.unit || 'Unknown unit').slice(0, 24),
			message: message.message.trim().slice(0, 240),
			timestamp: Date.now(),
		};
		try
		{
			const result = channel.send({ type: 'broadcast', event: 'police_radio', payload: payload });
			if (result && typeof result.catch === 'function') result.catch((e) => warn('police radio broadcast failed', e));
			RRMP.stats.sent++;
			return true;
		}
		catch (e) { warn('police radio broadcast failed', e); return false; }
	};

	window.addEventListener('beforeunload', () =>
	{
		if (session.channel) { try { session.channel.unsubscribe(); } catch (e) { /* ignore */ } }
		if (session.server) { try { db.leaveSession(session.server.id); } catch (e) { /* ignore */ } }
	});

	// ======================================================================
	//  UI
	// ======================================================================
	function injectCSS()
	{
		if (document.getElementById('rrmp-css')) return;
		const s = el('style', null, `
.rrmp-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(6,8,12,.78);backdrop-filter:blur(3px);font-family:Solway,Arial,sans-serif;color:#f4f1ea}
.rrmp-card{width:min(680px,92vw);max-height:86vh;overflow:auto;background:linear-gradient(180deg,#171b24,#0e1117);border:1px solid #2b3242;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.6);padding:26px 28px}
.rrmp-card h2{margin:0 0 6px;font-family:'Alfa Slab One',serif;color:#ffd27a;font-size:24px}
.rrmp-sub{color:#9aa3b2;font-size:13px;margin:0 0 14px}
.rrmp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}
.rrmp-row label{flex:0 0 120px;color:#cfd6e3;font-size:13px}
.rrmp-input,.rrmp-select{flex:1;min-width:160px;background:#0c0f15;border:1px solid #2b3242;color:#f4f1ea;border-radius:8px;padding:9px 11px;font-size:14px;font-family:inherit}
.rrmp-input:focus{outline:none;border-color:#ffd27a}
.rrmp-btn{background:#222834;color:#f4f1ea;border:1px solid #364056;border-radius:8px;padding:9px 14px;font-size:14px;font-family:inherit;cursor:pointer}
.rrmp-btn:hover{background:#2c3445;border-color:#4a546b}
.rrmp-btn:disabled{opacity:.45;cursor:not-allowed}
.rrmp-btn.rrmp-primary{background:linear-gradient(180deg,#ffd27a,#e8b25a);color:#1a1206;border:none;font-weight:700}
.rrmp-btn.rrmp-danger{background:#3a1c1c;border-color:#5a2a2a;color:#ffb3b3}
.rrmp-btn.rrmp-ghost{background:transparent}
.rrmp-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
.rrmp-list{display:flex;flex-direction:column;gap:8px;margin:6px 0}
.rrmp-srv{display:flex;align-items:center;gap:12px;background:#0c0f15;border:1px solid #242b39;border-radius:10px;padding:11px 14px}
.rrmp-srv-info{flex:1;min-width:0}
.rrmp-srv-name{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rrmp-srv-meta{color:#8b94a5;font-size:12px;margin-top:2px}
.rrmp-srv-count{color:#ffd27a;font-weight:700;font-size:13px;background:#1a1206;border:1px solid #4a3a1a;border-radius:20px;padding:3px 10px}
.rrmp-srv-count.full{color:#ff9a9a;background:#2a1212;border-color:#5a2a2a}
.rrmp-badge{font-size:10px;text-transform:uppercase;background:#1d2533;color:#9fc0ff;border-radius:4px;padding:2px 6px}
.rrmp-empty{text-align:center;color:#7f8898;padding:30px 10px}
.rrmp-spin{display:inline-block;width:14px;height:14px;border:2px solid #444;border-top-color:#ffd27a;border-radius:50%;animation:rrmp-spin .7s linear infinite}
@keyframes rrmp-spin{to{transform:rotate(360deg)}}
.rrmp-err{color:#ff9a9a;background:#2a1212;border:1px solid #5a2a2a;border-radius:8px;padding:8px 11px;font-size:13px;margin:8px 0}
.rrmp-swatches{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.rrmp-sw{width:30px;height:30px;border-radius:50%;border:2px solid #2b3242;cursor:pointer}
.rrmp-sw.sel{border-color:#ffd27a}
.rrmp-preview{width:84px;height:84px;border-radius:50%;border:2px solid #2b3242;margin-left:auto}
.rrmp-status{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:10px;background:rgba(14,17,23,.92);border:1px solid #2b3242;border-radius:20px;padding:6px 14px;font-family:Solway,Arial,sans-serif;font-size:13px;color:#f4f1ea}
.rrmp-dot{width:8px;height:8px;border-radius:50%;background:#3ecf8e;box-shadow:0 0 6px #3ecf8e}
.rrmp-dot.warn{background:#facc15;box-shadow:0 0 6px #facc15}
.rrmp-debug{position:fixed;bottom:12px;left:12px;z-index:9999;background:rgba(14,17,23,.92);border:1px solid #2b3242;border-radius:8px;padding:6px 10px;font-family:monospace;font-size:11px;color:#9fc0ff;pointer-events:none}
.rrmp-debug b{color:#ffd27a}
.rrmp-debug .ok{color:#3ecf8e}
.rrmp-debug .err{color:#ef4444}
.rrmp-debug .warn{color:#facc15}
.rr-menu .rrmp-btn{margin-top:8px}
		`);
		s.id = 'rrmp-css';
		document.head.appendChild(s);
	}

	const SKIN_PRESETS = ['#f5d5b8', '#e8b48c', '#c68642', '#a56638', '#7a4a2a', '#5a3320', '#3a2218', '#dcb78c'];

	const ui = RRMP.ui = {
		onlineBtn: null, charBtn: null, statusEl: null, debugEl: null, browserTimer: null,

		friendlyError(e)
		{
			const s = String((e && (e.message || e)) || 'Unknown error').toLowerCase();
			if (s.indexOf('secret') >= 0 && s.indexOf('forbidden') >= 0) return 'SECRET key pasted — use the PUBLISHABLE key (sb_publishable_…).';
			if (s.indexOf('401') >= 0 || s.indexOf('unauthorized') >= 0) return 'Supabase rejected the key (401). Check supabase-config.js URL + key match the same project.';
			if (s.indexOf('404') >= 0 || s.indexOf('does not exist') >= 0) return 'Table/function missing — re-run supabase/schema.sql.';
			return 'Error: ' + s;
		},

		injectStartButtons()
		{
			const menu = $('.rr-menu');
			if (!menu || menu.querySelector('[data-rrmp]')) return;
			const online = el('button', 'rr-btn rrmp-btn', 'Online');
			online.setAttribute('data-act', 'online'); online.setAttribute('data-rrmp', '1'); online.disabled = true;
			const char = el('button', 'rr-btn rrmp-btn', 'Character');
			char.setAttribute('data-act', 'character'); char.setAttribute('data-rrmp', '1');
			const play = menu.querySelector('[data-act="play"]');
			if (play && play.nextSibling) { menu.insertBefore(online, play.nextSibling); menu.insertBefore(char, online.nextSibling); }
			else { menu.appendChild(online); menu.appendChild(char); }
			online.addEventListener('click', (e) => { e.preventDefault(); this.openServers(); });
			char.addEventListener('click', (e) => { e.preventDefault(); this.openCharacter(); });
			this.onlineBtn = online; this.charBtn = char;
		},

		refreshStartButtons()
		{
			const u = RRMP.world && RRMP.world.realismUI;
			const loaded = !!(u && u.loaded);
			if (this.onlineBtn) this.onlineBtn.disabled = !loaded || !!RRMP.disabled;
			if (this.charBtn) this.charBtn.disabled = !!RRMP.disabled;
		},

		block(on) { const u = RRMP.world && RRMP.world.realismUI; if (u && u.setBlocking) u.setBlocking('multiplayer', !!on); },

		openServers()
		{
			if (RRMP.disabled) { this.toast('Multiplayer disabled: ' + (RRMP.disabledReason || 'check console')); return; }
			this.closeModal();
			const ov = el('div', 'rrmp-overlay'); const card = el('div', 'rrmp-card');
			card.innerHTML =
				'<h2>Online — Servers</h2>' +
				'<p class="rrmp-sub">Join a public server, use a code, or create your own.</p>' +
				'<div class="rrmp-row"><input class="rrmp-input" id="rrmp-search" placeholder="Filter servers by name…" /></div>' +
				'<div class="rrmp-list" id="rrmp-list"><div class="rrmp-empty"><span class="rrmp-spin"></span> Loading…</div></div>' +
				'<div class="rrmp-actions"><button class="rrmp-btn" id="rrmp-code">Join by Code</button><button class="rrmp-btn rrmp-primary" id="rrmp-create">Create Server</button><button class="rrmp-btn rrmp-ghost" id="rrmp-cancel">Cancel</button></div>';
			ov.appendChild(card); document.body.appendChild(ov); this.currentOverlay = ov; this.block(true);
			const list = $('#rrmp-list', card); const search = $('#rrmp-search', card);
			let servers = [];
			const render = () =>
			{
				const q = (search.value || '').toLowerCase().trim();
				const shown = servers.filter((s) => s.is_public && (!q || (s.name || '').toLowerCase().indexOf(q) >= 0));
				if (!shown.length) { list.innerHTML = '<div class="rrmp-empty">No public servers found.</div>'; return; }
				list.innerHTML = '';
				shown.forEach((s) =>
				{
					const full = s.player_count >= s.max_players;
					const row = el('div', 'rrmp-srv');
					row.innerHTML = '<div class="rrmp-srv-info"><div class="rrmp-srv-name">' + esc(s.name) + (s.is_default ? ' <span class="rrmp-badge">Official</span>' : '') + '</div><div class="rrmp-srv-meta">Max ' + s.max_players + '</div></div><span class="rrmp-srv-count' + (full ? ' full' : '') + '">' + s.player_count + ' / ' + s.max_players + '</span><button class="rrmp-btn rrmp-primary" ' + (full ? 'disabled' : '') + '>' + (full ? 'Full' : 'Join') + '</button>';
					if (!full) row.querySelector('button').addEventListener('click', (e) => { e.preventDefault(); this.joinServer(s); });
					list.appendChild(row);
				});
			};
			const refresh = async () => { try { await db.reap(); servers = await db.listServers(); if (this.currentOverlay === ov) render(); } catch (e) { list.innerHTML = '<div class="rrmp-err">' + esc(this.friendlyError(e)) + '</div>'; } };
			refresh(); this.browserTimer = setInterval(refresh, RRMP.config.browserRefreshSeconds * 1000);
			search.addEventListener('input', render);
			$('#rrmp-create', card).addEventListener('click', (e) => { e.preventDefault(); this.openCreate(); });
			$('#rrmp-code', card).addEventListener('click', (e) => { e.preventDefault(); this.openJoinByCode(); });
			$('#rrmp-cancel', card).addEventListener('click', (e) => { e.preventDefault(); this.closeModal(); });
			ov.addEventListener('click', (e) => { if (e.target === ov) this.closeModal(); });
		},

		async joinServer(server)
		{
			try
			{
				this.closeModal();
				this.toast('Joining "' + server.name + '"…');
				session.join(server);
				maintainSkin();
			} catch (e) { this.toast('Failed to join: ' + (e.message || e)); warn('join failed', e); }
		},

		openCreate()
		{
			this.closeModal();
			const ov = el('div', 'rrmp-overlay'); const card = el('div', 'rrmp-card');
			card.innerHTML = '<h2>Create a Server</h2><p class="rrmp-sub">Public = free join. Private = code required.</p><div class="rrmp-row"><label>Server name</label><input class="rrmp-input" id="rrmp-name" maxlength="40" placeholder="My Hood" /></div><div class="rrmp-row"><label>Type</label><select class="rrmp-select" id="rrmp-type"><option value="public">Public (free join)</option><option value="private">Private (code required)</option></select></div><div class="rrmp-row" id="rrmp-code-row" style="display:none"><label>Join code</label><input class="rrmp-input" id="rrmp-code" maxlength="6" style="text-transform:uppercase" /><button class="rrmp-btn" id="rrmp-gencode" type="button">Generate</button></div><div class="rrmp-row"><label>Max players</label><input class="rrmp-input" id="rrmp-max" type="number" min="1" max="64" value="16" /></div><div class="rrmp-err" id="rrmp-err" style="display:none"></div><div class="rrmp-actions"><button class="rrmp-btn rrmp-ghost" id="rrmp-back">Back</button><button class="rrmp-btn rrmp-primary" id="rrmp-go">Create &amp; Join</button></div>';
			ov.appendChild(card); document.body.appendChild(ov); this.currentOverlay = ov;
			const typeSel = $('#rrmp-type', card); const codeRow = $('#rrmp-code-row', card);
			typeSel.addEventListener('change', () => { codeRow.style.display = typeSel.value === 'private' ? '' : 'none'; });
			$('#rrmp-gencode', card).addEventListener('click', () => { $('#rrmp-code', card).value = genCode(); });
			$('#rrmp-back', card).addEventListener('click', (e) => { e.preventDefault(); this.openServers(); });
			$('#rrmp-go', card).addEventListener('click', async (e) =>
			{
				e.preventDefault();
				const err = $('#rrmp-err', card); err.style.display = 'none';
				const name = $('#rrmp-name', card).value.trim();
				const isPublic = typeSel.value === 'public';
				const code = $('#rrmp-code', card).value.trim().toUpperCase();
				const max = parseInt($('#rrmp-max', card).value, 10) || 16;
				if (!name) { err.textContent = 'Enter a server name.'; err.style.display = ''; return; }
				if (!isPublic && code.length < 4) { err.textContent = 'Private servers need a code (4+ characters).'; err.style.display = ''; return; }
				try
				{
					$('#rrmp-go', card).disabled = true;
					const srv = await db.createServer(name, isPublic, code, max);
					this.closeModal();
					this.toast('Created "' + srv.name + '"' + (srv.join_code ? ' • code ' + srv.join_code : ''));
					session.join(srv);
					maintainSkin();
				} catch (e2) { err.textContent = this.friendlyError(e2); err.style.display = ''; $('#rrmp-go', card).disabled = false; }
			});
		},

		openJoinByCode()
		{
			this.closeModal();
			const ov = el('div', 'rrmp-overlay'); const card = el('div', 'rrmp-card');
			card.innerHTML = '<h2>Join by Code</h2><p class="rrmp-sub">Enter the code the server owner shared with you.</p><div class="rrmp-row"><label>Code</label><input class="rrmp-input" id="rrmp-code" maxlength="6" style="text-transform:uppercase" placeholder="ABC123" /></div><div class="rrmp-err" id="rrmp-err" style="display:none"></div><div class="rrmp-actions"><button class="rrmp-btn rrmp-ghost" id="rrmp-back">Back</button><button class="rrmp-btn rrmp-primary" id="rrmp-go">Join</button></div>';
			ov.appendChild(card); document.body.appendChild(ov); this.currentOverlay = ov;
			$('#rrmp-back', card).addEventListener('click', (e) => { e.preventDefault(); this.openServers(); });
			$('#rrmp-go', card).addEventListener('click', async (e) =>
			{
				e.preventDefault();
				const err = $('#rrmp-err', card); err.style.display = 'none';
				const code = $('#rrmp-code', card).value.trim().toUpperCase();
				if (code.length < 4) { err.textContent = 'Enter the code.'; err.style.display = ''; return; }
				try
				{
					$('#rrmp-go', card).disabled = true;
					const srv = await db.getByCode(code);
					if (!srv) { err.textContent = 'No server with that code.'; err.style.display = ''; $('#rrmp-go', card).disabled = false; return; }
					if (srv.player_count >= srv.max_players) { err.textContent = 'That server is full.'; err.style.display = ''; $('#rrmp-go', card).disabled = false; return; }
					this.closeModal();
					this.toast('Joining "' + srv.name + '"…');
					session.join(srv);
					maintainSkin();
				} catch (e2) { err.textContent = this.friendlyError(e2); err.style.display = ''; $('#rrmp-go', card).disabled = false; }
			});
		},

		openCharacter()
		{
			this.closeModal();
			const ov = el('div', 'rrmp-overlay'); const card = el('div', 'rrmp-card');
			card.innerHTML = '<h2>Your Character</h2><p class="rrmp-sub">Used in Free Roam and Online. Saved on this browser.</p><div class="rrmp-row"><label>Name</label><input class="rrmp-input" id="rrmp-name" maxlength="16" value="' + esc(identity.name) + '" /></div><div class="rrmp-row"><label>Gender</label><select class="rrmp-input" id="rrmp-gender"><option value="male">Male</option><option value="female">Female</option></select></div><div class="rrmp-row"><label>Skin color</label><input class="rrmp-input" id="rrmp-color" type="color" value="' + esc(identity.skinColor) + '" style="flex:0 0 60px;height:38px;padding:2px" /></div><div class="rrmp-swatches" id="rrmp-swatches"></div><div class="rrmp-preview" id="rrmp-preview" style="background:' + esc(identity.skinColor) + '"></div><div class="rrmp-actions"><button class="rrmp-btn rrmp-ghost" id="rrmp-cancel">Cancel</button><button class="rrmp-btn rrmp-primary" id="rrmp-save">Save</button></div>';
			ov.appendChild(card); document.body.appendChild(ov); this.currentOverlay = ov; this.block(true);
			const colorIn = $('#rrmp-color', card); const nameIn = $('#rrmp-name', card); const genderIn = $('#rrmp-gender', card); const preview = $('#rrmp-preview', card); const sw = $('#rrmp-swatches', card);
			genderIn.value = identity.gender;
			SKIN_PRESETS.forEach((c) =>
			{
				const s = el('div', 'rrmp-sw' + (c.toLowerCase() === identity.skinColor.toLowerCase() ? ' sel' : ''));
				s.style.background = c;
				s.addEventListener('click', () => { colorIn.value = c; preview.style.background = c; sw.querySelectorAll('.rrmp-sw').forEach((x) => x.classList.remove('sel')); s.classList.add('sel'); });
				sw.appendChild(s);
			});
			colorIn.addEventListener('input', () => { preview.style.background = colorIn.value; sw.querySelectorAll('.rrmp-sw').forEach((x) => x.classList.remove('sel')); });
			$('#rrmp-cancel', card).addEventListener('click', (e) => { e.preventDefault(); this.closeModal(); });
			$('#rrmp-save', card).addEventListener('click', (e) => { e.preventDefault(); identity.save(nameIn.value, colorIn.value, genderIn.value); maintainSkin(); this.closeModal(); this.toast('Character saved'); });
		},

		showStatus(server)
		{
			this.hideStatus();
			const s = el('div', 'rrmp-status');
			s.innerHTML = '<span class="rrmp-dot" id="rrmp-dot"></span><span>' + esc(server.name) + '</span> • <span id="rrmp-stcount">1</span> online • <span id="rrmp-health">HP 100</span> • <span id="rrmp-kd">0 K / 0 D</span><button class="rrmp-btn rrmp-danger" id="rrmp-leave" style="margin-left:6px;padding:4px 10px">Leave</button>';
			document.body.appendChild(s); this.statusEl = s;
			$('#rrmp-leave', s).addEventListener('click', async (e) => { e.preventDefault(); session.leave(); this.toast('Left the server'); });
			this.updateHealth();
		},
		updateStatusCount(n)
		{
			if (!this.statusEl) return;
			const c = $('#rrmp-stcount', this.statusEl); if (c) c.textContent = String(n);
			const dot = $('#rrmp-dot', this.statusEl);
			if (dot) dot.className = 'rrmp-dot' + (RRMP.stats.channelStatus === 'SUBSCRIBED' ? '' : ' warn');
		},
		updateHealth()
		{
			if (!this.statusEl) return;
			const health = $('#rrmp-health', this.statusEl);
			const kd = $('#rrmp-kd', this.statusEl);
			if (health) health.textContent = 'HP ' + Math.ceil(RRMP.combat.health);
			if (kd) kd.textContent = RRMP.combat.kills + ' K / ' + RRMP.combat.deaths + ' D';
		},
		hideStatus() { if (this.statusEl) { this.statusEl.remove(); this.statusEl = null; } },

		showDebug()
		{
			this.hideDebug();
			const d = el('div', 'rrmp-debug');
			d.innerHTML = '<b>RRMP</b> <span id="rrmp-dbg-status">…</span> | online: <span id="rrmp-dbg-pres">0</span> | sent: <span id="rrmp-dbg-sent">0</span> | recv: <span id="rrmp-dbg-recv">0</span> | players: <span id="rrmp-dbg-players">0</span>';
			document.body.appendChild(d); this.debugEl = d;
		},
		updateDebug()
		{
			if (!this.debugEl) return;
			const set = (id, v, cls) => { const e = $('#' + id, this.debugEl); if (e) { e.textContent = String(v); if (cls !== undefined) e.className = cls; } };
			const st = RRMP.stats.channelStatus || '…';
			set('rrmp-dbg-status', st, st === 'SUBSCRIBED' ? 'ok' : (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED' ? 'err' : 'warn'));
			set('rrmp-dbg-pres', RRMP.stats.presenceCount);
			set('rrmp-dbg-sent', RRMP.stats.sent);
			set('rrmp-dbg-recv', RRMP.stats.recv);
			set('rrmp-dbg-players', Object.keys(remotePlayers).length);
		},
		hideDebug() { if (this.debugEl) { this.debugEl.remove(); this.debugEl = null; } },

		closeModal() { if (this.browserTimer) { clearInterval(this.browserTimer); this.browserTimer = null; } if (this.currentOverlay) { this.currentOverlay.remove(); this.currentOverlay = null; } this.block(false); },
		toast(msg) { const t = el('div', 'rrmp-status'); t.style.borderRadius = '8px'; t.innerHTML = '<span style="color:#ffd27a">' + esc(msg) + '</span>'; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); },
	};

	// ======================================================================
	//  Frame loop — movement broadcast + avatar lerp + skin
	// ======================================================================
	let _lastFrame = performance.now();
	function frameLoop()
	{
		requestAnimationFrame(frameLoop);
		const now = performance.now();
		let dt = (now - _lastFrame) / 1000; _lastFrame = now;
		if (dt > 0.1) dt = 0.1;
		try { session.tick(); } catch (e) { /* ignore */ }
		try { session.lerpAvatars(dt); } catch (e) { /* ignore */ }
		try { maintainSkin(); } catch (e) { /* ignore */ }
		try { ui.refreshStartButtons(); } catch (e) { /* ignore */ }
		try { ui.updateDebug(); } catch (e) { /* ignore */ }
	}

	// ======================================================================
	//  Bootstrap
	// ======================================================================
	function bootstrap()
	{
		identity.load();
		injectCSS();
		const ok = initConfig();
		let wired = false;
		const tryWire = () =>
		{
			const w = window.realismWorld;
			if (!w) return;
			RRMP.world = w;
			const menu = $('.rr-menu');
			if (menu && !wired) { wired = true; ui.injectStartButtons(); log('wired into start screen'); }
			ui.refreshStartButtons();
		};
		tryWire();
		setInterval(tryWire, 500);
		if (ok) frameLoop();
		else
		{
			requestAnimationFrame(function skinLoop() { requestAnimationFrame(skinLoop); try { maintainSkin(); } catch (e) { /* ignore */ } });
		}
		log('boot done. enabled=' + ok + '. Debug: RRMP.debug()');
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
	else bootstrap();
})();
