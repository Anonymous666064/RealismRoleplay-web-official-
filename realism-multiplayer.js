/*
 * realism-multiplayer.js  -  Online multiplayer + server browser + character creation
 *  for Realism Roleplay.
 * ============================================================================
 *  Runtime framework. Loaded by index.html AFTER build/sketchbook.min.js.
 *  No webpack rebuild required — same pattern as realism-config.js.
 *
 *  Requires:
 *    - window.SUPABASE_CONFIG          (supabase-config.js)
 *    - window.supabase                 (CDN: @supabase/supabase-js@2)
 *    - window.THREE                    (bundled with the game)
 *    - window.realismWorld             (set by index.html)
 *
 *  Exposes window.RRMP. See ARCHITECTURE.md for the full design.
 *
 *  MIT-style — part of Realism Roleplay by Riley Freeman / Tha Trenches RP.
 */
(function ()
{
        'use strict';

        if (window.RRMP) return;   // double-load guard

        // ======================================================================
        //  Small utils
        // ======================================================================
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
        const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
        const uuid = () =>
        {
                if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) =>
                {
                        const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 0x3 | 0x8);
                        return v.toString(16);
                });
        };
        const log = (...a) => { if (RRMP.config && RRMP.config.verbose) console.log('[RRMP]', ...a); };
        const warn = (...a) => console.warn('[RRMP]', ...a);

        // Detect the role/kind of a Supabase API key. Works with BOTH the legacy
        // JWT keys (anon / service_role) and the new-format keys (sb_publishable_ /
        // sb_secret_). Supabase is migrating to the new format; legacy retires 2027.
        // Returns one of: 'anon' | 'service_role' | 'publishable' | 'secret' | null
        function keyRole(key)
        {
                const k = String(key || '');
                // New format: prefix-based
                if (k.indexOf('sb_publishable_') === 0) return 'publishable';
                if (k.indexOf('sb_secret_') === 0) return 'secret';
                // Legacy format: decode JWT, read role claim
                try
                {
                        const parts = k.split('.');
                        if (parts.length < 2) return null;
                        let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                        while (b.length % 4) b += '=';
                        const json = decodeURIComponent(escape(atob(b)));
                        const payload = JSON.parse(json);
                        return payload && payload.role ? String(payload.role) : null;
                } catch (e) { return null; }
        }
        // Back-compat alias
        const jwtRole = keyRole;

        const RRMP = window.RRMP = {
                config: { verbose: false, sendRateHz: 20, heartbeatSeconds: 5, browserRefreshSeconds: 5, maxAvatars: 32 },
                supabase: null,
                world: null,
                ready: false,
                disabled: false,
                disabledReason: null,
                // Public: call RRMP.diagnose() from the console to print a full
                // config + connection diagnostic.
                diagnose: null,
        };

        // ======================================================================
        //  Config + Supabase client
        // ======================================================================
        function initConfig()
        {
                const cfg = window.SUPABASE_CONFIG || {};
                if (!cfg.url || !cfg.anonKey ||
                        cfg.url.indexOf('YOUR-PROJECT') >= 0 ||
                        cfg.anonKey.indexOf('YOUR-ANON') >= 0 ||
                        cfg.anonKey.indexOf('YOUR-PUBLISHABLE') >= 0)
                {
                        warn('Supabase not configured. Fill in supabase-config.js (url + anonKey) to enable multiplayer.');
                        RRMP.disabled = true;
                        RRMP.disabledReason = 'not configured (open supabase-config.js)';
                        return false;
                }
                // Guard: catch the most common mistake — pasting a server-side secret key
                // instead of a browser-safe public key. Supabase blocks these in the browser
                // with "Forbidden use of secret API key in browser". We surface a clearer
                // message up front. Handles BOTH the legacy and new key formats:
                //   legacy:  service_role  (JWT)   ← blocked
                //   new:     sb_secret_…           ← blocked
                //   legacy:  anon          (JWT)   ← OK
                //   new:     sb_publishable_…      ← OK (the new anon equivalent)
                const role = keyRole(cfg.anonKey);
                if (role === 'service_role' || role === 'secret')
                {
                        console.error('[RRMP] You pasted a Supabase SECRET key into supabase-config.js → anonKey. ' +
                                'That key must NEVER be in a browser — it bypasses RLS and Supabase blocks it. ' +
                                'Open Supabase → Project Settings → API Keys and copy the PUBLISHABLE key ' +
                                '(sb_publishable_…) — that is the browser-safe one. (Legacy equivalent: the "anon" JWT.) ' +
                                'Paste it into supabase-config.js → anonKey, save, and hard refresh.');
                        RRMP.disabled = true;
                        RRMP.disabledReason = 'wrong key (' + role + ' in browser — use publishable/anon instead)';
                        return false;
                }
                if (role && role !== 'anon' && role !== 'publishable')
                {
                        warn('Unexpected Supabase key role "' + role + '". Expected "anon" or "publishable". Multiplayer disabled.');
                        RRMP.disabled = true;
                        RRMP.disabledReason = 'unexpected key role: ' + role;
                        return false;
                }
                const mp = cfg.multiplayer || {};
                RRMP.config.verbose = !!mp.verbose;
                RRMP.config.sendRateHz = clamp(mp.sendRateHz || 20, 1, 60);
                RRMP.config.heartbeatSeconds = clamp(mp.heartbeatSeconds || 5, 2, 25);
                RRMP.config.browserRefreshSeconds = clamp(mp.browserRefreshSeconds || 5, 2, 60);
                RRMP.config.maxAvatars = clamp(mp.maxAvatars || 32, 1, 128);
                if (!window.supabase || typeof window.supabase.createClient !== 'function')
                {
                        warn('Supabase JS client not found. Did index.html load the @supabase/supabase-js CDN?');
                        RRMP.disabled = true;
                        return false;
                }
                RRMP.supabase = window.supabase.createClient(cfg.url, cfg.anonKey, {
                        realtime: { params: { eventsPerSecond: 50 } },
                });
                log('Supabase client ready');
                return true;
        }

        // Public diagnostic. Call RRMP.diagnose() from the console to print a full
        // config + connection check. Returns the same info as an object too.
        function diagnose()
        {
                const cfg = window.SUPABASE_CONFIG || {};
                const out = { url: cfg.url, anonKey: null, keyRef: null, urlRef: null, role: null, match: null, rrmpLoaded: true, disabled: RRMP.disabled, disabledReason: RRMP.disabledReason, sbClientLoaded: !!(window.supabase && typeof window.supabase.createClient === 'function'), expires: null, issued: null, keyFormat: null };
                console.group('%c[RRMP] Diagnostic', 'color:#ffd27a;font-weight:bold');
                console.log('URL:', out.url);
                if (!cfg.anonKey) { console.log('Anon key: MISSING'); console.groupEnd(); return out; }
                out.anonKey = cfg.anonKey.substring(0, 28) + '… (' + cfg.anonKey.length + ' chars)';
                console.log('Anon key:', out.anonKey);
                const role = keyRole(cfg.anonKey);
                out.role = role;
                // Detect key format (new sb_* vs legacy JWT)
                out.keyFormat = (cfg.anonKey.indexOf('sb_publishable_') === 0) ? 'new (publishable)' :
                        (cfg.anonKey.indexOf('sb_secret_') === 0) ? 'new (secret)' :
                        (cfg.anonKey.split('.').length >= 3) ? 'legacy (JWT)' : 'unknown';
                console.log('Key format:', out.keyFormat);
                console.log('Key role:', role || 'could not decode');
                // Decode the JWT payload (legacy keys only) to get ref / iat / exp
                if (out.keyFormat === 'legacy (JWT)')
                {
                        try
                        {
                                const parts = String(cfg.anonKey).split('.');
                                if (parts.length >= 2)
                                {
                                        let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                                        while (b.length % 4) b += '=';
                                        const payload = JSON.parse(decodeURIComponent(escape(atob(b))));
                                        out.keyRef = payload.ref || null;
                                        out.issued = payload.iat ? new Date(payload.iat * 1000).toISOString() : null;
                                        out.expires = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
                                        console.log('Key project ref:', out.keyRef);
                                        console.log('Key issued:', out.issued);
                                        console.log('Key expires:', out.expires);
                                }
                        } catch (e) { console.log('JWT decode failed:', e.message); }
                }
                const m = cfg.url && cfg.url.match(/https?:\/\/([^.]+)\.supabase\.co/);
                out.urlRef = m ? m[1] : null;
                console.log('URL project ref:', out.urlRef);
                if (out.keyRef && out.urlRef)
                {
                        out.match = out.keyRef === out.urlRef;
                        console.log('%cKey matches URL? ' + (out.match ? 'YES ✓' : 'NO ✗ — key is from a different Supabase project'), out.match ? 'color:#46d27a' : 'color:#ff9a9a;font-weight:bold');
                }
                console.log('RRMP loaded:', out.rrmpLoaded, '| disabled:', out.disabled, out.disabledReason ? '| reason: ' + out.disabledReason : '');
                console.log('supabase-js loaded:', out.sbClientLoaded);
                // Friendly verdict
                if (role === 'service_role' || role === 'secret')
                        console.log('%c→ You pasted a SECRET key (sb_secret_ or service_role). NEVER put that in a browser. Copy the PUBLISHABLE key (sb_publishable_…) instead — or the legacy "anon" JWT.', 'color:#ff9a9a;font-weight:bold');
                else if (role === 'publishable' || role === 'anon')
                        console.log('%c→ Key is browser-safe (' + role + '). Config looks correct. If you still get 401s, the key may have been rotated — regenerate it in Supabase → Settings → API Keys.', 'color:#46d27a');
                else if (out.match === false)
                        console.log('%c→ URL and key are from different projects. Open the dashboard for project ' + out.urlRef + ' and copy THAT project\'s publishable/anon key.', 'color:#ff9a9a;font-weight:bold');
                else if (RRMP.disabled)
                        console.log('%c→ Multiplayer is disabled. See reason above.', 'color:#ff9a9a;font-weight:bold');
                else
                        console.log('%c→ Config looks correct. If you still get 401s, the key may have been rotated in the Supabase dashboard.', 'color:#ffd27a');
                console.groupEnd();
                return out;
        }
        RRMP.diagnose = diagnose;

        // ======================================================================
        //  Identity + character (localStorage)
        // ======================================================================
        const LS_ID = 'rrmp_player_id';
        const LS_CHAR = 'rrmp_character';

        const identity = RRMP.identity = {
                id: null,
                name: 'Player',
                skinColor: '#c68642',
                load()
                {
                        let id = localStorage.getItem(LS_ID);
                        if (!id) { id = uuid(); localStorage.setItem(LS_ID, id); }
                        this.id = id;
                        try
                        {
                                const c = JSON.parse(localStorage.getItem(LS_CHAR) || '{}');
                                if (c.name) this.name = String(c.name).slice(0, 16);
                                if (c.skinColor) this.skinColor = String(c.skinColor);
                        } catch (e) { /* ignore */ }
                },
                saveCharacter(name, skinColor)
                {
                        this.name = String(name || 'Player').trim().slice(0, 16) || 'Player';
                        this.skinColor = skinColor || '#c68642';
                        localStorage.setItem(LS_CHAR, JSON.stringify({ name: this.name, skinColor: this.skinColor }));
                },
        };

        // ======================================================================
        //  DB helpers
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
                async createServer(name, isPublic, code, maxPlayers, seed)
                {
                        const row = {
                                name: String(name).trim().slice(0, 40) || 'New Server',
                                is_public: !!isPublic,
                                join_code: isPublic ? null : (code || genCode()).toUpperCase(),
                                owner_id: identity.id,
                                max_players: clamp(parseInt(maxPlayers, 10) || 16, 1, 64),
                                seed: parseInt(seed, 10) || 1337,
                                is_default: false,
                        };
                        const { data, error } = await RRMP.supabase.from('servers').insert(row).select().single();
                        if (error) throw error;
                        return data;
                },
                async deleteServer(id)
                {
                        const { error } = await RRMP.supabase.from('servers').delete().eq('id', id);
                        if (error) throw error;
                },
                // joinSession / heartbeat / leaveSession all key on connId (a fresh UUID
                // per join, generated by session.join). This lets the same player have
                // multiple connections (e.g. two tabs for testing) without colliding.
                async joinSession(server, connId)
                {
                        const row = {
                                id: connId,                          // connection UUID (NOT player_id)
                                server_id: server.id,
                                player_id: identity.id,              // persistent player identity
                                player_name: identity.name,
                                skin_color: identity.skinColor,
                                last_seen: new Date().toISOString(),
                                joined_at: new Date().toISOString(),
                        };
                        const { error } = await RRMP.supabase.from('server_sessions').insert(row);
                        if (error) throw error;
                },
                async heartbeat(serverId, connId)
                {
                        await RRMP.supabase.from('server_sessions')
                                .update({ last_seen: new Date().toISOString(), player_name: identity.name, skin_color: identity.skinColor })
                                .eq('id', connId).eq('server_id', serverId);
                },
                async leaveSession(serverId, connId)
                {
                        await RRMP.supabase.from('server_sessions').delete()
                                .eq('id', connId).eq('server_id', serverId);
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
        //  Local-player helpers (read transform, apply skin)
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

        function getPlayerObject3D(ch)
        {
                if (!ch) return null;
                return ch.model || ch.threeObject || ch.mesh || (ch.isObject3D ? ch : null);
        }

        function readLocalTransform()
        {
                const ch = getLocalPlayer();
                if (!ch) return null;
                let x = 0, y = 0, z = 0, yaw = 0;
                try
                {
                        const cap = ch.characterCapsule;
                        if (cap && cap.body && cap.body.position) { x = cap.body.position.x; y = cap.body.position.y; z = cap.body.position.z; }
                        else if (ch.position) { x = ch.position.x; y = ch.position.y; z = ch.position.z; }
                } catch (e) { /* ignore */ }
                try
                {
                        const obj = getPlayerObject3D(ch);
                        if (obj && obj.rotation) yaw = obj.rotation.y;
                        else if (ch.rotation) yaw = ch.rotation.y;
                } catch (e) { /* ignore */ }
                // motion from horizontal velocity
                let motion = 'idle';
                try
                {
                        const cap = ch.characterCapsule;
                        if (cap && cap.body && cap.body.velocity)
                        {
                                const v = cap.body.velocity;
                                const sp = Math.sqrt(v.x * v.x + v.z * v.z);
                                motion = sp < 0.6 ? 'idle' : (sp < 3.2 ? 'walk' : 'run');
                        }
                } catch (e) { /* ignore */ }
                return { t: [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)], r: +yaw.toFixed(3), m: motion };
        }

        // Apply skin color to the local player's meshes (clone materials so NPCs are unaffected).
        function applySkinColor(color)
        {
                const ch = getLocalPlayer();
                if (!ch) return false;
                const obj = getPlayerObject3D(ch);
                if (!obj) return false;
                let touched = 0;
                obj.traverse((node) =>
                {
                        if (!node.isMesh || !node.material) return;
                        // clone once per mesh on first touch so we never mutate shared materials (NPCs stay unaffected)
                        if (!node.__rrmpOwned)
                        {
                                node.__rrmpOwned = true;
                                if (Array.isArray(node.material)) node.material = node.material.map((mm) => mm.clone());
                                else node.material = node.material.clone();
                        }
                        const cur = Array.isArray(node.material) ? node.material : [node.material];
                        cur.forEach((m) =>
                        {
                                if (m && m.color) { try { m.color.set(color); touched++; } catch (e) { /* ignore */ } }
                        });
                });
                ch.__rrmpSkin = color;
                log('skin applied', color, 'meshes:', touched);
                return touched > 0;
        }

        // Re-apply skin whenever the local player object changes (e.g. after respawn).
        let _lastPlayerRef = null;
        let _lastSkinApplied = null;
        function maintainSkin()
        {
                const ch = getLocalPlayer();
                if (!ch) { _lastPlayerRef = null; return; }
                if (ch === _lastPlayerRef && ch.__rrmpSkin === identity.skinColor) return;
                _lastPlayerRef = ch;
                applySkinColor(identity.skinColor);
                _lastSkinApplied = identity.skinColor;
        }

        // ======================================================================
        //  Remote avatars
        // ======================================================================
        const avatars = RRMP.avatars = {
                map: new Map(),   // playerId -> { group, head, body, label, target:{x,y,z,yaw,motion}, last, phase }
                scene: null,
                ensureScene()
                {
                        if (this.scene) return this.scene;
                        const w = RRMP.world;
                        if (w && w.graphicsWorld) this.scene = w.graphicsWorld;
                        return this.scene;
                },
                spawn(playerId, info)
                {
                        if (this.map.has(playerId)) { this.updateInfo(playerId, info); return; }
                        if (this.map.size >= RRMP.config.maxAvatars) { log('avatar cap reached, skipping', playerId); return; }
                        const THREE = window.THREE;
                        if (!THREE || !this.ensureScene()) { log('no THREE/scene for avatar'); return; }
                        const skin = (info && info.skinColor) || '#c68642';
                        const group = new THREE.Group();

                        const bodyMat = new THREE.MeshLambertMaterial({ color: skin });
                        const headMat = new THREE.MeshLambertMaterial({ color: lighten(skin, 1.12) });
                        const body = new THREE.Mesh(new THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(0.28, 0.7, 4, 8) : new THREE.CylinderGeometry(0.28, 0.28, 1.0, 8), bodyMat);
                        body.position.y = 0.7;
                        const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), headMat);
                        head.position.y = 1.45;
                        group.add(body); group.add(head);

                        const label = makeLabel((info && info.name) || 'Player');
                        label.position.y = 1.95;
                        group.add(label);

                        this.scene.add(group);
                        this.map.set(playerId, {
                                group, body, head, label,
                                target: { x: 0, y: 0, z: 0, yaw: 0, motion: 'idle' },
                                last: 0, phase: Math.random() * Math.PI * 2,
                                skin,
                        });
                        log('avatar spawn', playerId, info);
                },
                updateInfo(playerId, info)
                {
                        const a = this.map.get(playerId);
                        if (!a) return;
                        if (info && info.skinColor && info.skinColor !== a.skin)
                        {
                                a.skin = info.skinColor;
                                if (a.body.material) a.body.material.color.set(info.skinColor);
                                if (a.head.material) a.head.material.color.set(lighten(info.skinColor, 1.12));
                        }
                        if (info && info.name) updateLabel(a.label, info.name);
                },
                setTarget(playerId, t)
                {
                        const a = this.map.get(playerId);
                        if (!a) return;
                        a.target.x = t.t[0]; a.target.y = t.t[1]; a.target.z = t.t[2];
                        a.target.yaw = t.r; a.target.motion = t.m || 'idle'; a.last = now();
                },
                remove(playerId)
                {
                        const a = this.map.get(playerId);
                        if (!a) return;
                        if (a.group && a.group.parent) a.group.parent.remove(a.group);
                        disposeGroup(a.group);
                        this.map.delete(playerId);
                        log('avatar remove', playerId);
                },
                clear()
                {
                        this.map.forEach((_, id) => this.remove(id));
                },
                // per-frame lerp + motion bob
                tick(dt)
                {
                        const t = now();
                        this.map.forEach((a) =>
                        {
                                const g = a.group;
                                // teleport if very far (spawn / server change), else lerp
                                const dx = a.target.x - g.position.x;
                                const dz = a.target.z - g.position.z;
                                const dist = Math.sqrt(dx * dx + dz * dz);
                                if (dist > 40) { g.position.set(a.target.x, a.target.y, a.target.z); }
                                else
                                {
                                        const k = 1 - Math.pow(0.001, dt);   // frame-rate independent lerp
                                        g.position.x = lerp(g.position.x, a.target.x, k);
                                        g.position.y = lerp(g.position.y, a.target.y, k);
                                        g.position.z = lerp(g.position.z, a.target.z, k);
                                }
                                // yaw (shortest arc)
                                let dyaw = a.target.yaw - g.rotation.y;
                                while (dyaw > Math.PI) dyaw -= Math.PI * 2;
                                while (dyaw < -Math.PI) dyaw += Math.PI * 2;
                                g.rotation.y = g.rotation.y + dyaw * (1 - Math.pow(0.001, dt));
                                // motion bob
                                if (a.target.motion !== 'idle')
                                {
                                        a.phase += dt * (a.target.motion === 'run' ? 12 : 7);
                                        a.body.position.y = 0.7 + Math.sin(a.phase) * 0.04;
                                }
                                else { a.body.position.y = 0.7; }
                                // hide label if stale (no updates in 4s)
                                if (a.label) a.label.visible = (t - a.last) < 4000 || a.last === 0;
                        });
                },
        };

        function lighten(hex, factor)
        {
                try
                {
                        const c = hex.replace('#', '');
                        const r = clamp(Math.round(parseInt(c.substring(0, 2), 16) * factor), 0, 255);
                        const g = clamp(Math.round(parseInt(c.substring(2, 4), 16) * factor), 0, 255);
                        const b = clamp(Math.round(parseInt(c.substring(4, 6), 16) * factor), 0, 255);
                        return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
                } catch (e) { return hex; }
        }

        function makeLabel(text)
        {
                const THREE = window.THREE;
                const canvas = document.createElement('canvas');
                canvas.width = 256; canvas.height = 64;
                const ctx = canvas.getContext('2d');
                drawLabel(ctx, text);
                const tex = new THREE.CanvasTexture(canvas);
                tex.minFilter = THREE.LinearFilter;
                const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
                const spr = new THREE.Sprite(mat);
                spr.scale.set(1.2, 0.3, 1);
                spr.userData.canvas = canvas;
                spr.userData.ctx = ctx;
                spr.userData.tex = tex;
                return spr;
        }
        function drawLabel(ctx, text)
        {
                ctx.clearRect(0, 0, 256, 64);
                ctx.font = 'bold 30px Solway, Arial, sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
                ctx.strokeText(text, 128, 32);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(text, 128, 32);
        }
        function updateLabel(spr, text)
        {
                if (!spr || !spr.userData || !spr.userData.ctx) return;
                drawLabel(spr.userData.ctx, text);
                spr.userData.tex.needsUpdate = true;
        }
        function disposeGroup(g)
        {
                if (!g) return;
                g.traverse((n) =>
                {
                        if (n.geometry) try { n.geometry.dispose(); } catch (e) { /* ignore */ }
                        if (n.material)
                        {
                                const mats = Array.isArray(n.material) ? n.material : [n.material];
                                mats.forEach((m) =>
                                {
                                        if (m && m.map) try { m.map.dispose(); } catch (e) { /* ignore */ }
                                        if (m) try { m.dispose(); } catch (e) { /* ignore */ }
                                });
                        }
                });
        }

        // ======================================================================
        //  P2P (WebRTC) — used for LAN mode. Direct peer-to-peer data channels.
        //  Supabase Realtime is used ONLY for signaling (exchanging SDP offer /
        //  answer / ICE candidates). Once the data channel is open, position
        //  updates flow directly between browsers — on a LAN this means local
        //  network speeds, no internet roundtrip.
        // ======================================================================
        const ICE_CONFIG = {
                iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                ],
        };

        const p2p = RRMP.p2p = {
                connections: new Map(),   // remoteConnId -> { pc, dc, state }
                enabled: false,           // set true when LAN mode is chosen

                // Called when a new peer appears in Presence. The side with the
                // "smaller" connId initiates the offer — avoids both sides offering.
                onPeerSeen(remoteConnId)
                {
                        if (!this.enabled || !session.connId) return;
                        if (this.connections.has(remoteConnId)) return;
                        if (session.connId < remoteConnId) this.createOffer(remoteConnId);
                },

                async createOffer(remoteConnId)
                {
                        if (this.connections.has(remoteConnId)) return;
                        try
                        {
                                const pc = new RTCPeerConnection(ICE_CONFIG);
                                const dc = pc.createDataChannel('pos', { ordered: false, maxRetransmits: 0 });
                                this.connections.set(remoteConnId, { pc, dc: null, state: 'connecting' });
                                this.wirePC(remoteConnId, pc);
                                this.wireDC(remoteConnId, dc);
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                session.channel.send({ type: 'broadcast', event: 'webrtc-offer', payload: { to: remoteConnId, from: session.connId, sdp: offer } });
                                log('P2P offer sent to', remoteConnId.substring(0, 8));
                        } catch (e) { warn('P2P offer failed', e); }
                },

                async onOffer(from, sdp)
                {
                        if (!this.enabled) return;
                        try
                        {
                                let conn = this.connections.get(from);
                                if (!conn)
                                {
                                        const pc = new RTCPeerConnection(ICE_CONFIG);
                                        conn = { pc, dc: null, state: 'connecting' };
                                        this.connections.set(from, conn);
                                        this.wirePC(from, pc);
                                }
                                await conn.pc.setRemoteDescription(sdp);
                                const answer = await conn.pc.createAnswer();
                                await conn.pc.setLocalDescription(answer);
                                session.channel.send({ type: 'broadcast', event: 'webrtc-answer', payload: { to: from, from: session.connId, sdp: answer } });
                                log('P2P answer sent to', from.substring(0, 8));
                        } catch (e) { warn('P2P answer failed', e); }
                },

                async onAnswer(from, sdp)
                {
                        const conn = this.connections.get(from);
                        if (!conn) return;
                        try { await conn.pc.setRemoteDescription(sdp); } catch (e) { warn('P2P setRemoteDescription failed', e); }
                },

                async onIce(from, candidate)
                {
                        const conn = this.connections.get(from);
                        if (!conn) return;
                        try { await conn.pc.addIceCandidate(candidate); } catch (e) { /* ignore — can race with setRemoteDescription */ }
                },

                wirePC(remoteConnId, pc)
                {
                        pc.onicecandidate = (e) =>
                        {
                                if (e.candidate && session.channel)
                                {
                                        session.channel.send({ type: 'broadcast', event: 'webrtc-ice', payload: { to: remoteConnId, from: session.connId, candidate: e.candidate } });
                                }
                        };
                        pc.ondatachannel = (e) => this.wireDC(remoteConnId, e.channel);
                        pc.onconnectionstatechange = () =>
                        {
                                const c = this.connections.get(remoteConnId);
                                if (!c) return;
                                c.state = pc.connectionState;
                                if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected')
                                {
                                        log('P2P', pc.connectionState, 'with', remoteConnId.substring(0, 8));
                                }
                        };
                },

                wireDC(remoteConnId, dc)
                {
                        dc.binaryType = 'arraybuffer';
                        const c = this.connections.get(remoteConnId);
                        if (c) c.dc = dc;
                        dc.onopen = () => { if (c) c.state = 'connected'; log('P2P data channel open with', remoteConnId.substring(0, 8)); };
                        dc.onclose = () => { if (c) c.state = 'closed'; log('P2P data channel closed with', remoteConnId.substring(0, 8)); };
                        dc.onmessage = (e) =>
                        {
                                try
                                {
                                        const data = JSON.parse(e.data);
                                        if (data.type === 'pos')
                                        {
                                                avatars.spawn(remoteConnId, { name: data.n, skinColor: data.s });
                                                avatars.setTarget(remoteConnId, data);
                                        }
                                } catch (err) { /* ignore malformed */ }
                        };
                },

                // Send position via all open data channels. Returns true if at least
                // one channel was open (so the caller can skip the Supabase broadcast).
                sendTransform(tr)
                {
                        if (!this.enabled || this.connections.size === 0) return false;
                        const msg = JSON.stringify({ type: 'pos', n: identity.name, s: identity.skinColor, t: tr.t, r: tr.r, m: tr.m });
                        let sent = false;
                        this.connections.forEach((conn) =>
                        {
                                if (conn.dc && conn.dc.readyState === 'open')
                                {
                                        try { conn.dc.send(msg); sent = true; } catch (e) { /* ignore */ }
                                }
                        });
                        return sent;
                },

                closePeer(remoteConnId)
                {
                        const conn = this.connections.get(remoteConnId);
                        if (!conn) return;
                        try { if (conn.dc) conn.dc.close(); } catch (e) { /* ignore */ }
                        try { conn.pc.close(); } catch (e) { /* ignore */ }
                        this.connections.delete(remoteConnId);
                },

                closeAll()
                {
                        this.connections.forEach((_, id) => this.closePeer(id));
                },
        };

        // ======================================================================
        //  Session (join / leave / presence / broadcast / heartbeat)
        //  connId is a FRESH UUID per join (in-memory, not localStorage) so that
        //  two tabs of the same browser get two different session rows, two
        //  different Presence keys, and can see each other's avatars.
        // ======================================================================
        const session = RRMP.session = {
                server: null,
                channel: null,
                connId: null,            // fresh UUID per join (connection identity)
                mode: 'global',          // 'global' (Supabase broadcast) | 'lan' (WebRTC P2P)
                heartbeatTimer: null,
                sendTimer: null,
                lastSend: 0,
                leaving: false,

                async join(server, mode)
                {
                        if (this.server) await this.leave();
                        this.leaving = false;
                        this.server = server;
                        this.mode = mode || 'global';
                        this.connId = uuid();             // fresh connection UUID
                        p2p.enabled = this.mode === 'lan';
                        log('joining server', server.name, 'mode=' + this.mode, 'connId=' + this.connId.substring(0, 8));

                        // 1. DB session row (so the player counts toward the server's player_count)
                        await db.joinSession(server, this.connId);

                        // 2. Realtime channel: presence + broadcast (and P2P signaling in LAN mode)
                        const ch = RRMP.supabase.channel('server:' + server.id, {
                                config: { presence: { key: this.connId } },
                        });
                        this.channel = ch;

                        ch.on('presence', { event: 'sync' }, () => this.onPresenceSync());
                        ch.on('presence', { event: 'join' }, ({ key, newPresences }) =>
                        {
                                (newPresences || []).forEach((p) =>
                                {
                                        if (!p || !p.id || p.id === this.connId) return;
                                        avatars.spawn(p.id, p);
                                        if (p2p.enabled) p2p.onPeerSeen(p.id);
                                });
                        });
                        ch.on('presence', { event: 'leave' }, ({ key, leftPresences }) =>
                        {
                                (leftPresences || []).forEach((p) =>
                                {
                                        if (!p || !p.id || p.id === this.connId) return;
                                        avatars.remove(p.id);
                                        if (p2p.enabled) p2p.closePeer(p.id);
                                });
                        });

                        // Position updates via Supabase broadcast (Global mode, and P2P fallback)
                        ch.on('broadcast', { event: 'pos' }, ({ payload }) =>
                        {
                                if (!payload || !payload.id || payload.id === this.connId) return;
                                avatars.spawn(payload.id, { name: payload.n, skinColor: payload.s });
                                avatars.setTarget(payload.id, payload);
                        });

                        // WebRTC signaling (LAN mode only — ignored in global mode)
                        ch.on('broadcast', { event: 'webrtc-offer' }, ({ payload }) =>
                        {
                                if (!payload || payload.to !== this.connId) return;
                                p2p.onOffer(payload.from, payload.sdp);
                        });
                        ch.on('broadcast', { event: 'webrtc-answer' }, ({ payload }) =>
                        {
                                if (!payload || payload.to !== this.connId) return;
                                p2p.onAnswer(payload.from, payload.sdp);
                        });
                        ch.on('broadcast', { event: 'webrtc-ice' }, ({ payload }) =>
                        {
                                if (!payload || payload.to !== this.connId) return;
                                p2p.onIce(payload.from, payload.candidate);
                        });

                        ch.subscribe(async (status) =>
                        {
                                if (status === 'SUBSCRIBED')
                                {
                                        await ch.track({ id: this.connId, playerId: identity.id, name: identity.name, skinColor: identity.skinColor });
                                        log('presence tracked', this.connId.substring(0, 8));
                                }
                                else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
                                {
                                        warn('realtime channel', status);
                                }
                        });

                        // 3. heartbeat (keeps the session row fresh for the player count)
                        this.heartbeatTimer = setInterval(() => { if (this.connId) db.heartbeat(server.id, this.connId).catch(() => { /* non-fatal */ }); }, RRMP.config.heartbeatSeconds * 1000);

                        // 4. broadcast loop
                        const interval = 1000 / RRMP.config.sendRateHz;
                        this.sendTimer = setInterval(() => this.sendTransform(), interval);

                        // 5. start the game (same path as Free Roam's Play button)
                        startGame();

                        ui.showStatus(server, this.mode);
                        log('joined server', server.name, server.id, 'mode=' + this.mode);
                },

                sendTransform()
                {
                        if (this.leaving || !this.channel) return;
                        const tr = readLocalTransform();
                        if (!tr) return;
                        const t = now();
                        if (t - this.lastSend < (1000 / RRMP.config.sendRateHz) - 2) return;
                        this.lastSend = t;

                        // In LAN mode, try P2P data channels first. If at least one channel
                        // is open, skip the Supabase broadcast (positions go direct P2P).
                        // If no channels are open yet (still negotiating), fall back to
                        // Supabase broadcast so movement is visible during the handoff.
                        if (p2p.enabled && p2p.sendTransform(tr)) return;

                        // Global mode, or P2P fallback
                        this.channel.send({
                                type: 'broadcast', event: 'pos',
                                payload: { id: this.connId, n: identity.name, s: identity.skinColor, t: tr.t, r: tr.r, m: tr.m },
                        });
                },

                onPresenceSync()
                {
                        if (!this.channel) return;
                        const state = this.channel.presenceState() || {};
                        const ids = new Set();
                        for (const key in state)
                        {
                                const arr = state[key];
                                if (!arr) continue;
                                arr.forEach((p) =>
                                {
                                        if (!p || !p.id) return;
                                        if (p.id === this.connId) return;
                                        ids.add(p.id);
                                        avatars.spawn(p.id, p);
                                        if (p2p.enabled) p2p.onPeerSeen(p.id);
                                });
                        }
                        // remove avatars for players no longer present
                        avatars.map.forEach((_, id) => { if (!ids.has(id)) { avatars.remove(id); if (p2p.enabled) p2p.closePeer(id); } });
                        // update HUD count
                        ui.updateStatusCount(Object.keys(state).length);
                },

                async leave()
                {
                        this.leaving = true;
                        const srv = this.server;
                        const cid = this.connId;
                        try
                        {
                                if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
                                if (this.sendTimer) { clearInterval(this.sendTimer); this.sendTimer = null; }
                                p2p.closeAll();
                                if (this.channel)
                                {
                                        try { await this.channel.unsubscribe(); } catch (e) { /* ignore */ }
                                        try { RRMP.supabase.removeChannel(this.channel); } catch (e) { /* ignore */ }
                                        this.channel = null;
                                }
                                if (srv && cid) await db.leaveSession(srv.id, cid);
                        } catch (e) { warn('leave error', e); }
                        avatars.clear();
                        this.server = null;
                        this.connId = null;
                        ui.hideStatus();
                        log('left server');
                },
        };

        // hard cleanup on tab close / navigate — delete the session row by connId
        window.addEventListener('beforeunload', () =>
        {
                if (!session.server || !session.connId) return;
                const url = (window.SUPABASE_CONFIG.url || '') + '/rest/v1/server_sessions?id=eq.' + encodeURIComponent(session.connId) + '&server_id=eq.' + encodeURIComponent(session.server.id);
                const headers = { 'apikey': window.SUPABASE_CONFIG.anonKey, 'Authorization': 'Bearer ' + window.SUPABASE_CONFIG.anonKey };
                try { fetch(url, { method: 'DELETE', headers, keepalive: true }); } catch (e) { /* ignore */ }
                try { session.channel && session.channel.unsubscribe(); } catch (e) { /* ignore */ }
                try { p2p.closeAll(); } catch (e) { /* ignore */ }
        });
        document.addEventListener('visibilitychange', () =>
        {
                if (!document.hidden && session.server && session.connId) db.heartbeat(session.server.id, session.connId).catch(() => { /* non-fatal */ });
        });

        function startGame()
        {
                const w = RRMP.world;
                const ui_ = w && w.realismUI;
                if (ui_ && typeof ui_.play === 'function' && ui_.state === 'start') ui_.play();
        }

        // ======================================================================
        //  UI: CSS + modals
        // ======================================================================
        function injectCSS()
        {
                if (document.getElementById('rrmp-css')) return;
                const s = el('style', null, `
.rrmp-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(6,8,12,.78);backdrop-filter:blur(3px);font-family:Solway,Alfa Slab One,Arial,sans-serif;color:#f4f1ea}
.rrmp-card{width:min(680px,92vw);max-height:86vh;overflow:auto;background:linear-gradient(180deg,#171b24,#0e1117);border:1px solid #2b3242;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.6);padding:26px 28px}
.rrmp-card h2{margin:0 0 6px;font-family:'Alfa Slab One',serif;letter-spacing:.5px;color:#ffd27a;font-size:24px}
.rrmp-sub{color:#9aa3b2;font-size:13px;margin:0 0 18px}
.rrmp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}
.rrmp-row label{flex:0 0 120px;color:#cfd6e3;font-size:13px}
.rrmp-input,.rrmp-select{flex:1;min-width:160px;background:#0c0f15;border:1px solid #2b3242;color:#f4f1ea;border-radius:8px;padding:9px 11px;font-size:14px;font-family:inherit}
.rrmp-input:focus,.rrmp-select:focus{outline:none;border-color:#ffd27a}
.rrmp-btn{background:#222834;color:#f4f1ea;border:1px solid #364056;border-radius:8px;padding:9px 14px;font-size:14px;font-family:inherit;cursor:pointer;transition:.12s}
.rrmp-btn:hover{background:#2c3445;border-color:#4a546b}
.rrmp-btn:disabled{opacity:.45;cursor:not-allowed}
.rrmp-btn.rrmp-primary{background:linear-gradient(180deg,#ffd27a,#e8b25a);color:#1a1206;border:none;font-weight:700}
.rrmp-btn.rrmp-primary:hover{filter:brightness(1.06)}
.rrmp-btn.rrmp-danger{background:#3a1c1c;border-color:#5a2a2a;color:#ffb3b3}
.rrmp-btn.rrmp-ghost{background:transparent}
.rrmp-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}
.rrmp-list{display:flex;flex-direction:column;gap:8px;margin:6px 0 4px}
.rrmp-srv{display:flex;align-items:center;gap:12px;background:#0c0f15;border:1px solid #242b39;border-radius:10px;padding:11px 14px}
.rrmp-srv:hover{border-color:#3a465e}
.rrmp-srv-info{flex:1;min-width:0}
.rrmp-srv-name{font-weight:700;color:#f4f1ea;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rrmp-srv-meta{color:#8b94a5;font-size:12px;margin-top:2px}
.rrmp-srv-count{font-variant-numeric:tabular-nums;color:#ffd27a;font-weight:700;font-size:13px;background:#1a1206;border:1px solid #4a3a1a;border-radius:20px;padding:3px 10px;white-space:nowrap}
.rrmp-srv-count.full{color:#ff9a9a;background:#2a1212;border-color:#5a2a2a}
.rrmp-badge{font-size:10px;letter-spacing:.5px;text-transform:uppercase;background:#1d2533;color:#9fc0ff;border-radius:4px;padding:2px 6px}
.rrmp-badge.priv{background:#2a1f33;color:#d6a9ff}
.rrmp-empty{text-align:center;color:#7f8898;padding:30px 10px}
.rrmp-spin{display:inline-block;width:14px;height:14px;border:2px solid #444;border-top-color:#ffd27a;border-radius:50%;animation:rrmp-spin .7s linear infinite;vertical-align:middle}
@keyframes rrmp-spin{to{transform:rotate(360deg)}}
.rrmp-err{color:#ff9a9a;background:#2a1212;border:1px solid #5a2a2a;border-radius:8px;padding:8px 11px;font-size:13px;margin:8px 0}
.rrmp-swatches{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.rrmp-sw{width:30px;height:30px;border-radius:50%;border:2px solid #2b3242;cursor:pointer}
.rrmp-sw.sel{border-color:#ffd27a;box-shadow:0 0 0 2px rgba(255,210,122,.4)}
.rrmp-preview{width:84px;height:84px;border-radius:50%;border:2px solid #2b3242;margin-left:auto}
.rrmp-status{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:10px;background:rgba(14,17,23,.92);border:1px solid #2b3242;border-radius:20px;padding:6px 14px;font-family:Solway,Arial,sans-serif;font-size:13px;color:#f4f1ea}
.rrmp-dot{width:8px;height:8px;border-radius:50%;background:#46d27a;box-shadow:0 0 6px #46d27a}
.rrmp-hint{font-size:11px;color:#8b94a5;margin-top:10px;text-align:center}
.rrmp-mode-toggle{display:flex;gap:0;background:#0c0f15;border:1px solid #2b3242;border-radius:8px;overflow:hidden;margin:0 0 12px}
.rrmp-mode-toggle button{flex:1;background:transparent;color:#8b94a5;border:none;padding:10px 14px;font-size:13px;font-family:inherit;cursor:pointer;transition:.12s;border-bottom:2px solid transparent}
.rrmp-mode-toggle button.active{color:#ffd27a;background:#1a1206;border-bottom-color:#ffd27a;font-weight:700}
.rrmp-mode-toggle button:hover:not(.active){color:#cfd6e3;background:#11151c}
.rrmp-mode-desc{font-size:12px;color:#6b7585;margin:-6px 0 10px;padding:0 4px}
/* start-screen injected buttons ride along the existing .rr-menu */
.rr-menu .rrmp-btn{margin-top:8px}
                `);
                s.id = 'rrmp-css';
                document.head.appendChild(s);
        }

        const SKIN_PRESETS = ['#f5d5b8', '#e8b48c', '#c68642', '#a56638', '#7a4a2a', '#5a3320', '#3a2218', '#dcb78c'];

        const ui = RRMP.ui = {
                onlineBtn: null, charBtn: null,
                statusEl: null,
                browserTimer: null,

                // Turn a Supabase/PostgREST error into a friendly, actionable message.
                friendlyError(e)
                {
                        const msg = (e && (e.message || e)) || 'Unknown error';
                        const s = String(msg).toLowerCase();
                        if (s.indexOf('forbidden') >= 0 && s.indexOf('secret') >= 0)
                        {
                                return 'You pasted a SECRET key (sb_secret_… or service_role) into supabase-config.js — that is blocked in browsers. Open Supabase → Settings → API Keys and copy the PUBLISHABLE key (sb_publishable_…), or the legacy "anon" JWT, then paste it into supabase-config.js → anonKey. Run RRMP.diagnose() in the console to verify.';
                        }
                        if (s.indexOf('401') >= 0 || s.indexOf('unauthorized') >= 0 || s.indexOf('jwt') >= 0 || s.indexOf('invalid api key') >= 0)
                        {
                                return 'Supabase rejected the key (401). Open the browser console and run RRMP.diagnose() — most likely the URL and key are from different Supabase projects, or the key was rotated. Use the PUBLISHABLE key (sb_publishable_…), not the secret one.';
                        }
                        if (s.indexOf('403') >= 0 || s.indexOf('forbidden') >= 0 || s.indexOf('policy') >= 0)
                        {
                                return 'Supabase blocked the request (403 / RLS). Re-run supabase/schema.sql to make sure the RLS policies are in place.';
                        }
                        if (s.indexOf('404') >= 0 || s.indexOf('not found') >= 0 || s.indexOf('does not exist') >= 0)
                        {
                                return 'A Supabase table or function is missing. Re-run supabase/schema.sql in the Supabase SQL Editor.';
                        }
                        if (s.indexOf('failed to fetch') >= 0 || s.indexOf('network') >= 0)
                        {
                                return 'Could not reach Supabase. Check the URL in supabase-config.js and your network.';
                        }
                        return 'Error: ' + s;
                },

                injectStartButtons()
                {
                        const menu = $('.rr-menu');
                        if (!menu || menu.querySelector('[data-rrmp]')) return;
                        // insert Online + Character right after the Play button
                        const online = el('button', 'rr-btn rrmp-btn', 'Online');
                        online.setAttribute('data-act', 'online');
                        online.setAttribute('data-rrmp', '1');
                        online.disabled = true;
                        const char = el('button', 'rr-btn rrmp-btn', 'Character');
                        char.setAttribute('data-act', 'character');
                        char.setAttribute('data-rrmp', '1');
                        const play = menu.querySelector('[data-act="play"]');
                        if (play && play.nextSibling) { menu.insertBefore(online, play.nextSibling); menu.insertBefore(char, online.nextSibling); }
                        else { menu.appendChild(online); menu.appendChild(char); }
                        online.addEventListener('click', (e) => { e.preventDefault(); this.openServers(); });
                        char.addEventListener('click', (e) => { e.preventDefault(); this.openCharacter(); });
                        this.onlineBtn = online; this.charBtn = char;
                },

                // mirror the Play button's enabled state (game loaded)
                refreshStartButtons()
                {
                        const w = RRMP.world; const u = w && w.realismUI;
                        const loaded = !!(u && u.loaded);
                        if (this.onlineBtn) this.onlineBtn.disabled = !loaded || !!RRMP.disabled;
                        if (this.charBtn) this.charBtn.disabled = !!RRMP.disabled;
                },

                block(on)
                {
                        const w = RRMP.world; const u = w && w.realismUI;
                        if (u && typeof u.setBlocking === 'function') u.setBlocking('multiplayer', !!on);
                },

                // ---------- Servers browser ----------
                openServers()
                {
                        if (RRMP.disabled)
                        {
                                const reason = RRMP.disabledReason ? ('\n\n' + RRMP.disabledReason) : '';
                                this.toast('Multiplayer disabled. Check the browser console (F12) for setup steps.' + reason);
                                return;
                        }
                        this.closeModal();
                        const ov = el('div', 'rrmp-overlay');
                        const card = el('div', 'rrmp-card');
                        card.innerHTML =
                                '<h2>Online — Servers</h2>' +
                                '<p class="rrmp-sub">Pick a public server to drop into, join a private server with a code, or create your own.</p>' +
                                '<div class="rrmp-mode-toggle" id="rrmp-mode">' +
                                        '<button type="button" data-mode="global" class="active">Global</button>' +
                                        '<button type="button" data-mode="lan">LAN (Direct P2P)</button>' +
                                '</div>' +
                                '<div class="rrmp-mode-desc" id="rrmp-mode-desc">Global: all traffic through Supabase. Works across the internet.</div>' +
                                '<div class="rrmp-row" style="margin:0 0 10px"><input class="rrmp-input" id="rrmp-search" placeholder="Filter servers by name…" /></div>' +
                                '<div class="rrmp-list" id="rrmp-list"><div class="rrmp-empty"><span class="rrmp-spin"></span> Loading servers…</div></div>' +
                                '<div class="rrmp-actions">' +
                                        '<button class="rrmp-btn" id="rrmp-code">Join by Code</button>' +
                                        '<button class="rrmp-btn rrmp-primary" id="rrmp-create">Create Server</button>' +
                                        '<button class="rrmp-btn rrmp-ghost" id="rrmp-cancel">Cancel</button>' +
                                '</div>';
                        ov.appendChild(card);
                        document.body.appendChild(ov);
                        this.currentOverlay = ov;
                        this.block(true);

                        // mode toggle
                        let selectedMode = 'global';
                        const modeBar = $('#rrmp-mode', card);
                        const modeDesc = $('#rrmp-mode-desc', card);
                        const modeTexts = {
                                global: 'Global: all traffic through Supabase. Works across the internet.',
                                lan: 'LAN: position data flows direct peer-to-peer (WebRTC). Supabase is only used to find peers. Lower latency on the same network.',
                        };
                        modeBar.querySelectorAll('button').forEach((b) =>
                        {
                                b.addEventListener('click', (e) =>
                                {
                                        e.preventDefault();
                                        selectedMode = b.getAttribute('data-mode');
                                        modeBar.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
                                        b.classList.add('active');
                                        modeDesc.textContent = modeTexts[selectedMode] || '';
                                });
                        });
                        // store on the ui object so joinAndClose / openCreate / openJoinByCode can read it
                        this._selectedMode = () => selectedMode;

                        const list = $('#rrmp-list', card);
                        const search = $('#rrmp-search', card);
                        let servers = [];
                        const render = () =>
                        {
                                const q = (search.value || '').toLowerCase().trim();
                                const shown = servers.filter((s) => s.is_public && (!q || (s.name || '').toLowerCase().indexOf(q) >= 0));
                                if (!shown.length)
                                {
                                        list.innerHTML = '<div class="rrmp-empty">No public servers found.</div>';
                                        return;
                                }
                                list.innerHTML = '';
                                shown.forEach((s) =>
                                {
                                        const full = s.player_count >= s.max_players;
                                        const row = el('div', 'rrmp-srv');
                                        row.innerHTML =
                                                '<div class="rrmp-srv-info">' +
                                                        '<div class="rrmp-srv-name">' + esc(s.name) + (s.is_default ? ' <span class="rrmp-badge">Official</span>' : '') + '</div>' +
                                                        '<div class="rrmp-srv-meta">Max ' + s.max_players + ' players</div>' +
                                                '</div>' +
                                                '<span class="rrmp-srv-count' + (full ? ' full' : '') + '">' + s.player_count + ' / ' + s.max_players + '</span>' +
                                                '<button class="rrmp-btn rrmp-primary" ' + (full ? 'disabled' : '') + '>' + (full ? 'Full' : 'Join') + '</button>';
                                        const btn = row.querySelector('button');
                                        if (!full) btn.addEventListener('click', (e) => { e.preventDefault(); this.joinAndClose(s); });
                                        list.appendChild(row);
                                });
                        };

                        const refresh = async () =>
                        {
                                try
                                {
                                        await db.reap();
                                        servers = await db.listServers();
                                        if (this.currentOverlay === ov) render();
                                } catch (e)
                                {
                                        list.innerHTML = '<div class="rrmp-err">' + esc(this.friendlyError(e)) + '</div>';
                                }
                        };
                        refresh();
                        this.browserTimer = setInterval(refresh, RRMP.config.browserRefreshSeconds * 1000);
                        search.addEventListener('input', render);
                        $('#rrmp-create', card).addEventListener('click', (e) => { e.preventDefault(); this.openCreate(); });
                        $('#rrmp-code', card).addEventListener('click', (e) => { e.preventDefault(); this.openJoinByCode(); });
                        $('#rrmp-cancel', card).addEventListener('click', (e) => { e.preventDefault(); this.closeModal(); });
                        ov.addEventListener('click', (e) => { if (e.target === ov) this.closeModal(); });
                },

                async joinAndClose(server)
                {
                        try
                        {
                                const mode = (this._selectedMode && this._selectedMode()) || 'global';
                                this.closeModal();
                                this.toast('Joining "' + server.name + '"' + (mode === 'lan' ? ' (LAN mode)' : '') + '…');
                                await session.join(server, mode);
                                maintainSkin();
                        } catch (e)
                        {
                                this.toast('Failed to join: ' + (e.message || e));
                                warn('join failed', e);
                        }
                },

                // ---------- Create server ----------
                openCreate()
                {
                        this.closeModal();
                        const ov = el('div', 'rrmp-overlay');
                        const card = el('div', 'rrmp-card');
                        card.innerHTML =
                                '<h2>Create a Server</h2>' +
                                '<p class="rrmp-sub">Public servers appear in the browser for anyone. Private servers need a 6-character code to join.</p>' +
                                '<div class="rrmp-row"><label>Server name</label><input class="rrmp-input" id="rrmp-name" maxlength="40" placeholder="My Hood" /></div>' +
                                '<div class="rrmp-row"><label>Type</label><select class="rrmp-select" id="rrmp-type"><option value="public">Public (free join)</option><option value="private">Private (code required)</option></select></div>' +
                                '<div class="rrmp-row" id="rrmp-code-row" style="display:none"><label>Join code</label><input class="rrmp-input" id="rrmp-code" maxlength="6" style="text-transform:uppercase" /><button class="rrmp-btn" id="rrmp-gencode" type="button">Generate</button></div>' +
                                '<div class="rrmp-row"><label>Max players</label><input class="rrmp-input" id="rrmp-max" type="number" min="1" max="64" value="16" /></div>' +
                                '<div class="rrmp-err" id="rrmp-err" style="display:none"></div>' +
                                '<div class="rrmp-actions"><button class="rrmp-btn rrmp-ghost" id="rrmp-back">Back</button><button class="rrmp-btn rrmp-primary" id="rrmp-go">Create &amp; Join</button></div>';
                        ov.appendChild(card); document.body.appendChild(ov); this.currentOverlay = ov;

                        const typeSel = $('#rrmp-type', card);
                        const codeRow = $('#rrmp-code-row', card);
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
                                if (!isPublic && code.length < 4) { err.textContent = 'Private servers need a code (at least 4 characters).'; err.style.display = ''; return; }
                                try
                                {
                                        $('#rrmp-go', card).disabled = true;
                                        const srv = await db.createServer(name, isPublic, code, max, 1337);
                                        this.closeModal();
                                        this.toast('Created "' + srv.name + '"' + (srv.join_code ? ' • code ' + srv.join_code : ''));
                                        const mode = (this._selectedMode && this._selectedMode()) || 'global';
                                        await session.join(srv, mode);
                                        maintainSkin();
                                } catch (e2)
                                {
                                        err.textContent = this.friendlyError(e2).replace(/^Could not load servers:/, 'Could not create server:');
                                        err.style.display = '';
                                        $('#rrmp-go', card).disabled = false;
                                }
                        });
                },

                // ---------- Join by code ----------
                openJoinByCode()
                {
                        this.closeModal();
                        const ov = el('div', 'rrmp-overlay');
                        const card = el('div', 'rrmp-card');
                        card.innerHTML =
                                '<h2>Join by Code</h2>' +
                                '<p class="rrmp-sub">Enter the 6-character code the server owner shared with you.</p>' +
                                '<div class="rrmp-row"><label>Code</label><input class="rrmp-input" id="rrmp-code" maxlength="6" style="text-transform:uppercase" placeholder="ABC123" /></div>' +
                                '<div class="rrmp-err" id="rrmp-err" style="display:none"></div>' +
                                '<div class="rrmp-actions"><button class="rrmp-btn rrmp-ghost" id="rrmp-back">Back</button><button class="rrmp-btn rrmp-primary" id="rrmp-go">Join</button></div>';
                        ov.appendChild(card); document.body.appendChild(ov); this.currentOverlay = ov;
                        $('#rrmp-back', card).addEventListener('click', (e) => { e.preventDefault(); this.openServers(); });
                        $('#rrmp-go', card).addEventListener('click', async (e) =>
                        {
                                e.preventDefault();
                                const err = $('#rrmp-err', card); err.style.display = 'none';
                                const code = $('#rrmp-code', card).value.trim().toUpperCase();
                                if (code.length < 4) { err.textContent = 'Enter the code the owner gave you.'; err.style.display = ''; return; }
                                try
                                {
                                        $('#rrmp-go', card).disabled = true;
                                        const srv = await db.getByCode(code);
                                        if (!srv) { err.textContent = 'No server with that code.'; err.style.display = ''; $('#rrmp-go', card).disabled = false; return; }
                                        if (srv.player_count >= srv.max_players) { err.textContent = 'That server is full.'; err.style.display = ''; $('#rrmp-go', card).disabled = false; return; }
                                        this.closeModal();
                                        const mode = (this._selectedMode && this._selectedMode()) || 'global';
                                        this.toast('Joining "' + srv.name + '"' + (mode === 'lan' ? ' (LAN mode)' : '') + '…');
                                        await session.join(srv, mode);
                                        maintainSkin();
                                } catch (e2)
                                {
                                        err.textContent = this.friendlyError(e2).replace(/^Could not load servers:/, 'Could not join:');
                                        err.style.display = '';
                                        $('#rrmp-go', card).disabled = false;
                                }
                        });
                },

                // ---------- Character creator ----------
                openCharacter()
                {
                        this.closeModal();
                        const ov = el('div', 'rrmp-overlay');
                        const card = el('div', 'rrmp-card');
                        card.innerHTML =
                                '<h2>Your Character</h2>' +
                                '<p class="rrmp-sub">Your name and skin are used in both Free Roam and Online. Saved on this browser.</p>' +
                                '<div class="rrmp-row"><label>Name</label><input class="rrmp-input" id="rrmp-name" maxlength="16" placeholder="Player" value="' + esc(identity.name) + '" /></div>' +
                                '<div class="rrmp-row"><label>Skin color</label><input class="rrmp-input" id="rrmp-color" type="color" value="' + esc(identity.skinColor) + '" style="flex:0 0 60px;height:38px;padding:2px" /></div>' +
                                '<div class="rrmp-swatches" id="rrmp-swatches"></div>' +
                                '<div class="rrmp-preview" id="rrmp-preview" style="background:' + esc(identity.skinColor) + '"></div>' +
                                '<div class="rrmp-hint">Tip: pick a preset or use the color picker for any shade.</div>' +
                                '<div class="rrmp-actions"><button class="rrmp-btn rrmp-ghost" id="rrmp-cancel">Cancel</button><button class="rrmp-btn rrmp-primary" id="rrmp-save">Save</button></div>';
                        ov.appendChild(card); document.body.appendChild(ov); this.currentOverlay = ov; this.block(true);

                        const colorIn = $('#rrmp-color', card);
                        const nameIn = $('#rrmp-name', card);
                        const preview = $('#rrmp-preview', card);
                        const sw = $('#rrmp-swatches', card);
                        SKIN_PRESETS.forEach((c) =>
                        {
                                const s = el('div', 'rrmp-sw' + (c.toLowerCase() === identity.skinColor.toLowerCase() ? ' sel' : ''));
                                s.style.background = c; s.title = c;
                                s.addEventListener('click', () =>
                                {
                                        colorIn.value = c; preview.style.background = c;
                                        sw.querySelectorAll('.rrmp-sw').forEach((x) => x.classList.remove('sel'));
                                        s.classList.add('sel');
                                });
                                sw.appendChild(s);
                        });
                        colorIn.addEventListener('input', () =>
                        {
                                preview.style.background = colorIn.value;
                                sw.querySelectorAll('.rrmp-sw').forEach((x) => x.classList.remove('sel'));
                        });
                        $('#rrmp-cancel', card).addEventListener('click', (e) => { e.preventDefault(); this.closeModal(); });
                        $('#rrmp-save', card).addEventListener('click', (e) =>
                        {
                                e.preventDefault();
                                identity.saveCharacter(nameIn.value, colorIn.value);
                                maintainSkin();
                                // push updated name/skin to the live session + presence
                                if (session.server && session.connId)
                                {
                                        db.heartbeat(session.server.id, session.connId).catch(() => { /* non-fatal */ });
                                        if (session.channel) session.channel.track({ id: session.connId, playerId: identity.id, name: identity.name, skinColor: identity.skinColor });
                                }
                                this.closeModal();
                                this.toast('Character saved');
                        });
                },

                // ---------- status HUD ----------
                showStatus(server, mode)
                {
                        this.hideStatus();
                        const s = el('div', 'rrmp-status');
                        const modeLabel = mode === 'lan' ? ' <span style="color:#9fc0ff;font-size:11px">LAN</span>' : '';
                        s.innerHTML = '<span class="rrmp-dot"></span><span id="rrmp-stname">' + esc(server.name) + '</span>' + modeLabel + ' • <span id="rrmp-stcount">1</span> online <button class="rrmp-btn rrmp-danger" id="rrmp-leave" style="margin-left:6px;padding:4px 10px">Leave</button>';
                        document.body.appendChild(s);
                        this.statusEl = s;
                        $('#rrmp-leave', s).addEventListener('click', async (e) =>
                        {
                                e.preventDefault();
                                await session.leave();
                                this.toast('Left the server');
                        });
                },
                updateStatusCount(n)
                {
                        if (this.statusEl) { const c = $('#rrmp-stcount', this.statusEl); if (c) c.textContent = String(n); }
                },
                hideStatus() { if (this.statusEl) { this.statusEl.remove(); this.statusEl = null; } },

                // ---------- modal + toast helpers ----------
                closeModal()
                {
                        if (this.browserTimer) { clearInterval(this.browserTimer); this.browserTimer = null; }
                        if (this.currentOverlay) { this.currentOverlay.remove(); this.currentOverlay = null; }
                        this.block(false);
                },
                toast(msg)
                {
                        const t = el('div', 'rrmp-status');
                        t.style.borderRadius = '8px';
                        t.innerHTML = '<span style="color:#ffd27a">' + esc(msg) + '</span>';
                        document.body.appendChild(t);
                        setTimeout(() => t.remove(), 2600);
                },
        };

        // ======================================================================
        //  Per-frame loop (avatar lerp + skin maintenance) — independent of game timeScale
        // ======================================================================
        let _lastFrame = now();
        function frameLoop()
        {
                requestAnimationFrame(frameLoop);
                const t = now();
                let dt = (t - _lastFrame) / 1000; _lastFrame = t;
                if (dt > 0.1) dt = 0.1;        // clamp after tab switch
                try { avatars.tick(dt); } catch (e) { /* ignore */ }
                try { maintainSkin(); } catch (e) { /* ignore */ }
                try { ui.refreshStartButtons(); } catch (e) { /* ignore */ }
        }

        // ======================================================================
        //  Bootstrap: wait for the world + start screen, then wire everything
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
                        if (menu && !wired)
                        {
                                wired = true;
                                ui.injectStartButtons();
                                log('wired into start screen');
                        }
                        ui.refreshStartButtons();
                };
                tryWire();
                setInterval(tryWire, 500);

                if (ok) frameLoop();
                else
                {
                        // even when disabled, still show a disabled Online button + re-apply skin for Free Roam
                        setInterval(() => { try { maintainSkin(); } catch (e) { /* ignore */ } ui.refreshStartButtons(); }, 800);
                        // keep a minimal frame loop for skin only
                        requestAnimationFrame(function skinLoop() { requestAnimationFrame(skinLoop); try { maintainSkin(); } catch (e) { /* ignore */ } });
                }
                log('bootstrap done, enabled=' + ok);
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
        else bootstrap();
})();
