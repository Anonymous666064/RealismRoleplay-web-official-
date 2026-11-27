import * as THREE from 'three';
import * as CANNON from 'cannon';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { RealismJobs } from './RealismJobs';

type LawTab = 'mdt' | 'radio';

interface ConversationQuestion
{
	id: string;
	label: string;
	truth: string[];
	lie: string[];
}

interface LawRecord
{
	id: string;
	type: string;
	title: string;
	detail: string;
	officer: string;
	unit: string;
	location: string;
	status: string;
	createdAt: number;
}

interface DispatchCall
{
	id: string;
	title: string;
	priority: string;
	location: string;
	status: string;
	createdAt: number;
}

interface LawSave
{
	v: number;
	records: LawRecord[];
	calls: DispatchCall[];
	channel: string;
}

const STORAGE_KEY = 'realism.law-enforcement.v1';
const CHANNELS = ['County Dispatch', 'Police 1', 'Sheriff 1', 'County Tactical', 'Countywide'];
const MAX_RECORDS = 100;
const MAX_CALLS = 30;
const QUESTIONS: ConversationQuestion[] = [
	{ id: 'pulled-over', label: 'Do you know why I pulled you over?', truth: ['I think I was going a little fast.', 'I might have missed that stop sign.', 'No, officer. I am not sure.'], lie: ['I was driving normally.', 'I stopped at the sign.', 'I do not think I did anything.'] },
	{ id: 'alcohol', label: 'Have you had any alcohol tonight?', truth: ['No, I have not had anything to drink.', 'I had one drink earlier this evening.', 'I have had a couple of drinks.'], lie: ['No, officer. Nothing at all.', 'I have not had anything tonight.'] },
	{ id: 'firearms', label: 'Are there any firearms in the vehicle or on you?', truth: ['No, there are no firearms with me.', 'There is a legally owned firearm secured in the vehicle.', 'I have a firearm on me.'], lie: ['No, nothing like that.', 'There are no firearms in the vehicle.'] },
	{ id: 'ownership', label: 'Is this your vehicle?', truth: ['Yes, it is registered to me.', 'It belongs to a family member.', 'It is a rental.'], lie: ['Yes, it is mine.', 'I am borrowing it from a friend.'] },
	{ id: 'destination', label: 'Where are you coming from, and where are you headed?', truth: ['I am coming from work and heading home.', 'I was visiting a friend nearby.', 'I am on my way to the shops.'], lie: ['Just running a quick errand.', 'I am heading home.'] },
	{ id: 'identification', label: 'Do you have your identification with you?', truth: ['Yes, it is in my wallet.', 'I am afraid I left it at home.', 'I have my identification with me.'], lie: ['Yes, I have it right here.', 'I left it at home.'] },
	{ id: 'search-consent', label: 'May I search the vehicle?', truth: ['Yes, you may search the vehicle.', 'I would prefer not to consent to a search.', 'I do not consent to a search.'], lie: ['Sure, go ahead.', 'I do not mind if you look.'] },
];

function esc(value: any): string
{
	return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' } as any)[c]);
}

function makeId(prefix: string): string
{
	return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 0x10000).toString(16).toUpperCase();
}

export class RealismLawEnforcement implements IUpdatable
{
	public updateOrder = 9.5;
	public records: LawRecord[] = [];
	public calls: DispatchCall[] = [];
	public channel = CHANNELS[0];
	public activeStopId = '';

	private ctx: RealismCtx;
	private world: any;
	private tab: LawTab = 'mdt';
	private root: HTMLElement = null;
	private panel: HTMLElement = null;
	private body: HTMLElement = null;
	private opened = false;
	private conversationOpen = false;
	private conversationNpc: any = null;
	private conversationNpcId = '';
	private conversationMessages: { speaker: string; text: string }[] = [];
	private consentToSearch = false;
	private taserAmmo = 2;
	private flashlightOn = false;
	private cones: THREE.Group[] = [];
	private coneMaterial = new THREE.MeshBasicMaterial({ color: 0xf47d20 });
	private stripeMaterial = new THREE.MeshBasicMaterial({ color: 0xf4f1e8 });
	private baseMaterial = new THREE.MeshBasicMaterial({ color: 0x24262a });
	private flashlight: THREE.SpotLight = null;
	private flashlightTarget: THREE.Object3D = null;
	private rayResult = new CANNON.RaycastResult();
	private rayFrom = new CANNON.Vec3();
	private rayTo = new CANNON.Vec3();
	private rayOrigin = new THREE.Vector3();
	private rayDirection = new THREE.Vector3();
	private rayHit: any = null;
	private radioUnsubscribe: (() => void) = null;
	private mdtFocusCar: any = null;
	private mdtCameraSaved: { target: THREE.Vector3; radius: number; targetRadius: number; theta: number; phi: number; followMode: boolean } = null;
	private mdtFocusPoint = new THREE.Vector3();
	private radarPanel: HTMLElement = null;
	private radarOpen = false;
	private radarAcc = 0;
	private radarLimitMph = 35;
	private radarForward = new THREE.Vector3();

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.load();
		this.buildUI();
		this.bindInput();
		this.buildFlashlight();
		this.world.realismLawEnforcement = this;
		const mp: any = typeof window !== 'undefined' ? (window as any).RRMP : null;
		if (mp && typeof mp.onPoliceRadio === 'function')
		{
			this.radioUnsubscribe = mp.onPoliceRadio((payload: any) => this.receiveRadio(payload));
		}
		this.world.registerUpdatable(this);
	}

	public update(_timeStep: number, unscaled: number): void
	{
		if (this.opened && (!this.isOfficer() || !this.inPoliceVehicle())) this.close();
		if (this.opened && this.tab === 'mdt') this.updateMdtCameraFocus();
		if (this.conversationOpen && (!this.isOfficer() || !this.conversationNpc || !this.conversationNpc.agent || !this.conversationNpc.agent.alive))
			this.closeConversation();
		if (this.world.realismPaused === true) return;
		if (this.radarOpen)
		{
			if (!this.isOfficer() || !this.inPoliceVehicle()) this.closeRadar();
			else
			{
				this.radarAcc += Math.max(0, unscaled || 0);
				if (this.radarAcc >= 0.2) { this.radarAcc = 0; this.renderRadar(); }
			}
		}
		if (this.flashlightOn && this.flashlight) this.flashlight.visible = true;
	}

	private load(): void
	{
		try
		{
			if (typeof localStorage === 'undefined') return;
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return;
			const data = JSON.parse(raw);
			if (!data || data.v !== 1) return;
			if (Array.isArray(data.records)) this.records = data.records.slice(0, MAX_RECORDS);
			if (Array.isArray(data.calls)) this.calls = data.calls.slice(0, MAX_CALLS);
			if (CHANNELS.indexOf(data.channel) >= 0) this.channel = data.channel;
		}
		catch (e) { console.warn('[Realism] Police records could not be loaded from this browser.', e); }
	}

	private save(): void
	{
		try
		{
			if (typeof localStorage === 'undefined') return;
			localStorage.setItem(STORAGE_KEY, JSON.stringify({
				v: 1, records: this.records.slice(0, MAX_RECORDS), calls: this.calls.slice(0, MAX_CALLS), channel: this.channel,
			} as LawSave));
		}
		catch (e) { console.warn('[Realism] Police records could not be saved to this browser.', e); }
	}

	private buildUI(): void
	{
		if (typeof document === 'undefined' || !document.body) return;
		const style = document.createElement('style');
		style.textContent = [
			'#rr-le-panel{position:fixed;z-index:10001;inset:5vh 5vw;background:rgba(9,15,23,.97);color:#eaf1f7;border:1px solid #334455;border-radius:12px;box-shadow:0 18px 70px #000b;font:14px/1.5 Arial,sans-serif;display:none;overflow:hidden;transition:opacity .32s ease}',
			'#rr-le-panel.rr-le-sheriff{border-color:#80683b}#rr-le-panel.rr-le-sheriff #rr-le-head{background:#282315}#rr-le-panel.rr-le-sheriff .rr-le-btn.primary{background:#645124;border-color:#a48a4a}',
			'#rr-le-panel *{box-sizing:border-box}#rr-le-head{display:flex;align-items:center;justify-content:space-between;padding:15px 20px;background:#111e2b;border-bottom:1px solid #2c3b4a}',
			'#rr-le-head strong{font-size:16px;letter-spacing:.08em}#rr-le-head small{color:#9eafbf;margin-left:10px}',
			'#rr-le-close,.rr-le-btn{border:1px solid #3c5265;border-radius:6px;background:#1a2938;color:#eaf1f7;padding:8px 12px;cursor:pointer;font:inherit}',
			'.rr-le-btn:hover,#rr-le-close:hover{background:#263b50}.rr-le-btn.primary{background:#1b5b79;border-color:#3484a4}.rr-le-btn.warn{background:#71352d;border-color:#a04b3d}',
			'#rr-le-body{height:calc(100% - 112px);overflow:auto;padding:18px 20px}',
			'.rr-le-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.rr-le-card{background:#111c28;border:1px solid #28394a;border-radius:8px;padding:14px;margin-bottom:12px}',
			'.rr-le-card h3{margin:0 0 7px;font-size:15px;color:#d9ebf7}.rr-le-muted{color:#98aaba;font-size:12px}.rr-le-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #263645}',
			'.rr-le-row:last-child{border-bottom:0}.rr-le-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:9px;margin-top:12px}',
			'.rr-le-form input,.rr-le-form select,.rr-le-form textarea,.rr-le-search{width:100%;padding:9px;border:1px solid #3a4b5c;border-radius:6px;background:#0d1620;color:#eaf1f7;font:inherit}',
			'.rr-le-form textarea{min-height:74px;resize:vertical}.rr-le-form .wide{grid-column:1/-1}.rr-le-tag{display:inline-block;padding:2px 7px;border-radius:12px;background:#243a4b;color:#b8d5e8;font-size:11px}',
			'#rr-le-foot{padding:10px 20px;color:#a6b6c4;font-size:11px;background:#111e2b;border-top:1px solid #263645}',
			'#rr-le-chat{position:fixed;z-index:10003;left:50%;bottom:4vh;transform:translateX(-50%);width:min(640px,94vw);max-height:70vh;overflow:auto;background:rgba(8,15,23,.96);color:#eaf1f7;border:1px solid #456;border-radius:12px;box-shadow:0 12px 55px #000b;padding:16px;font:14px/1.45 Arial,sans-serif;display:none}',
			'#rr-le-chat h2{margin:0 0 4px;font-size:16px}#rr-le-chatlog{max-height:24vh;overflow:auto;margin:12px 0;padding:9px;background:#101b27;border-radius:7px}',
			'.rr-le-chatline{padding:4px 0;border-bottom:1px solid #293745}.rr-le-chatline:last-child{border-bottom:0}.rr-le-questions{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:7px}',
			'#rr-le-radar{position:fixed;z-index:10004;top:18px;right:18px;width:270px;padding:13px;border:1px solid #466176;border-radius:8px;background:rgba(8,15,23,.94);color:#eaf1f7;box-shadow:0 8px 30px #0009;font:13px/1.45 Arial,sans-serif;display:none;pointer-events:none}',
			'#rr-le-radar strong{display:block;color:#9be0ff;letter-spacing:.08em;margin-bottom:7px}#rr-le-radar label{display:flex;align-items:center;gap:7px;color:#b9c9d6}',
			'#rr-le-radar input{width:62px;padding:4px;border:1px solid #466176;border-radius:4px;background:#0d1620;color:#fff;pointer-events:auto}#rr-le-radar-list{margin-top:8px}',
			'.rr-le-radar-hit{display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid #243545}.rr-le-radar-hit.over{color:#ff8c78}',
			'@media(max-width:600px){#rr-le-panel{inset:2vh 2vw;border-radius:8px}#rr-le-body{height:calc(100% - 133px);padding:12px}.rr-le-form{grid-template-columns:1fr}#rr-le-chat{bottom:2vh;max-height:78vh}}',
		].join('');
		document.head.appendChild(style);
		this.root = document.createElement('div');
		this.root.innerHTML =
			'<section id="rr-le-panel" role="dialog" aria-modal="true" aria-label="Mobile data terminal">' +
			'<header id="rr-le-head"><div><strong id="rr-le-title"></strong><small id="rr-le-subtitle"></small></div><button id="rr-le-close" type="button" data-action="close">Close&nbsp; Esc</button></header>' +
			'<main id="rr-le-body"></main>' +
			'<footer id="rr-le-foot">LOCAL MDT RECORDS · Radio broadcasts require an active multiplayer server and are not server-authoritative.</footer></section>' +
			'<section id="rr-le-chat" role="dialog" aria-modal="true" aria-label="NPC conversation"></section>' +
			'<section id="rr-le-radar" aria-label="Traffic speed radar"><strong>TRAFFIC RADAR · MPH</strong>' +
			'<label>Speed limit <input type="number" min="5" max="100" step="1" value="35" data-action="radar-limit"> mph</label>' +
			'<div id="rr-le-radar-list">Scanning traffic ahead…</div></section>';
		document.body.appendChild(this.root);
		this.panel = this.root.querySelector('#rr-le-panel') as HTMLElement;
		this.body = this.root.querySelector('#rr-le-body') as HTMLElement;
		this.radarPanel = this.root.querySelector('#rr-le-radar') as HTMLElement;
		this.root.addEventListener('click', (e: any) =>
		{
			const target = e.target && e.target.closest ? e.target.closest('[data-action], [data-question]') : null;
			if (target && target.getAttribute('data-question')) this.askQuestion(target.getAttribute('data-question'));
			else if (target && target.getAttribute('data-action') === 'consent-search') this.searchWithConsent();
			else if (target && target.getAttribute('data-action') === 'release-dialog') this.closeConversation();
			else this.onClick(e);
		});
		this.root.addEventListener('submit', (e: any) => this.onSubmit(e));
		this.root.addEventListener('input', (e: any) =>
		{
			if (e.target && e.target.getAttribute && e.target.getAttribute('data-law-search') !== null)
			{
				const focused = document.activeElement === e.target;
				const cursor = typeof e.target.selectionStart === 'number' ? e.target.selectionStart : null;
				this.render();
				if (focused)
				{
					const input = this.root.querySelector('[data-law-search]') as HTMLInputElement;
					if (input) { input.focus(); if (cursor !== null) input.setSelectionRange(cursor, cursor); }
				}
			}
		});
		this.root.addEventListener('change', (e: any) =>
		{
			if (e.target && e.target.getAttribute && e.target.getAttribute('data-action') === 'channel')
			{
				if (CHANNELS.indexOf(e.target.value) >= 0) { this.channel = e.target.value; this.save(); this.render(); }
			}
			else if (e.target && e.target.getAttribute && e.target.getAttribute('data-action') === 'radar-limit')
			{
				const value = Number(e.target.value);
				if (!isFinite(value) || value < 5 || value > 100)
				{
					e.target.value = String(this.radarLimitMph);
					this.message('Radar speed limit must be between 5 and 100 mph.');
					return;
				}
				this.radarLimitMph = Math.round(value);
				e.target.value = String(this.radarLimitMph);
				this.renderRadar();
			}
		});
	}

	private bindInput(): void
	{
		if (typeof window === 'undefined') return;
		window.addEventListener('keydown', (e: KeyboardEvent) =>
		{
			const target: any = e.target;
			if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
			if (e.code === 'Escape' && this.conversationOpen)
			{
				e.preventDefault(); e.stopPropagation();
				this.closeConversation();
				return;
			}
			if (e.code === 'Escape' && this.opened)
			{
				e.preventDefault(); e.stopPropagation();
				this.close();
				return;
			}
			if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || this.world.realismPaused === true) return;
			if (!this.isOfficer() || this.world.realismUIBlocking === true) return;
			if (e.code === 'F6' && this.inPoliceVehicle())
			{
				e.preventDefault(); e.stopPropagation();
				this.toggleRadar();
				return;
			}
			if (e.code === 'Slash' && this.inPoliceVehicle())
			{
				e.preventDefault(); e.stopPropagation();
				if (this.opened && this.tab === 'mdt') this.close();
				else this.open('mdt');
				return;
			}
			if (e.code === 'KeyR' && this.inPoliceVehicle())
			{
				e.preventDefault(); e.stopPropagation();
				if (this.opened && this.tab === 'radio') this.close();
				else this.open('radio');
				return;
			}
			if (e.code === 'KeyQ' && this.playerOnFoot())
			{
				e.preventDefault(); e.stopPropagation();
				if (this.conversationOpen) this.closeConversation();
				else this.openConversation();
				return;
			}
			if (e.code === 'F7' && this.inPoliceVehicle())
			{
				e.preventDefault(); e.stopPropagation();
				this.requestTrafficStop();
				return;
			}
			if (e.code === 'KeyT' && this.playerOnFoot())
			{
				e.preventDefault(); e.stopPropagation();
				if (e.shiftKey) { this.taserAmmo = 2; this.message('Taser cartridges reloaded.'); }
				else this.fireTaser();
				return;
			}
			if (e.code === 'KeyC' && this.playerOnFoot())
			{
				e.preventDefault(); e.stopPropagation();
				this.cuffOrReleaseTarget();
				return;
			}
			if (e.code === 'KeyL')
			{
				const prompts = this.world.realismPrompt;
				if (prompts && typeof prompts.isActive === 'function' && prompts.isActive('doors')) return;
				e.preventDefault(); e.stopPropagation();
				this.toggleFlashlight();
				return;
			}
			if (e.code === 'KeyB' && this.playerOnFoot())
			{
				e.preventDefault(); e.stopPropagation();
				if (e.shiftKey) this.removeCone();
				else this.deployCone();
			}
		}, true);
	}

	private open(tab: LawTab): void
	{
		if (!this.panel || !this.isOfficer()) return;
		if (tab === 'mdt' && !this.inPoliceVehicle()) { this.message('The MDT is available inside an on-duty police or sheriff vehicle.'); return; }
		if (tab === 'radio' && !this.inPoliceVehicle()) return;
		const beginFocus = tab === 'mdt' && (!this.opened || this.tab !== 'mdt');
		if (this.opened && this.tab === 'mdt' && tab !== 'mdt') this.endMdtCameraFocus();
		this.tab = tab;
		this.opened = true;
		this.panel.style.display = 'flex';
		this.panel.style.flexDirection = 'column';
		this.panel.style.pointerEvents = 'auto';
		this.panel.style.opacity = beginFocus ? '0' : '1';
		this.panel.className = this.department() === 'COUNTY SHERIFF' ? 'rr-le-sheriff' : '';
		if (tab === 'mdt')
		{
			this.beginMdtCameraFocus();
			if (beginFocus) window.setTimeout(() =>
			{
				if (this.opened && this.tab === 'mdt' && this.panel) this.panel.style.opacity = '1';
			}, 360);
		}
		if (typeof this.world.realismSetUIBlocking === 'function') this.world.realismSetUIBlocking('lawEnforcement', true);
		if (this.world.realismUI && typeof this.world.realismUI.exitLock === 'function') this.world.realismUI.exitLock();
		this.render();
	}

	private close(): void
	{
		if (!this.opened) return;
		this.endMdtCameraFocus();
		this.opened = false;
		if (this.panel) this.panel.style.display = 'none';
		if (typeof this.world.realismSetUIBlocking === 'function') this.world.realismSetUIBlocking('lawEnforcement', false);
		if (this.world.realismUI && typeof this.world.realismUI.requestLock === 'function') this.world.realismUI.requestLock();
	}

	public usesVehicleRadioKey(): boolean { return this.isOfficer() && this.inPoliceVehicle(); }

	private beginMdtCameraFocus(): void
	{
		const car = this.policeVehicle();
		const operator: any = this.world.cameraOperator;
		const laptop = car && car.realismPolice && car.realismPolice.mdtLaptop;
		if (!car || !operator || !laptop || this.mdtFocusCar === car) return;
		this.endMdtCameraFocus();
		this.mdtCameraSaved = {
			target: operator.target.clone(), radius: operator.radius, targetRadius: operator.targetRadius,
			theta: operator.theta, phi: operator.phi, followMode: operator.followMode,
		};
		this.mdtFocusCar = car;
		operator.followMode = false;
		operator.theta = car.rotation.y * 180 / Math.PI + 180;
		operator.phi = 12;
		operator.setRadius(0.72, true);
		this.updateMdtCameraFocus();
	}

	private updateMdtCameraFocus(): void
	{
		const operator: any = this.world.cameraOperator;
		const laptop = this.mdtFocusCar && this.mdtFocusCar.realismPolice && this.mdtFocusCar.realismPolice.mdtLaptop;
		if (!operator || !laptop || !this.mdtCameraSaved) return;
		this.mdtFocusCar.updateMatrixWorld(true);
		laptop.getWorldPosition(this.mdtFocusPoint);
		this.mdtFocusPoint.y += 0.09;
		operator.target.copy(this.mdtFocusPoint);
	}

	private endMdtCameraFocus(): void
	{
		if (!this.mdtCameraSaved) { this.mdtFocusCar = null; return; }
		const operator: any = this.world.cameraOperator;
		if (operator)
		{
			operator.target.copy(this.mdtCameraSaved.target);
			operator.radius = this.mdtCameraSaved.radius;
			operator.targetRadius = this.mdtCameraSaved.targetRadius;
			operator.theta = this.mdtCameraSaved.theta;
			operator.phi = this.mdtCameraSaved.phi;
			operator.followMode = this.mdtCameraSaved.followMode;
		}
		this.mdtCameraSaved = null;
		this.mdtFocusCar = null;
	}

	private isOfficer(): boolean
	{
		const job = this.world.realismJob;
		return !!(job && job.onDuty === true && (job.id === 'police' || job.id === 'sheriff'));
	}

	private unit(): string
	{
		const job = this.world.realismJob;
		return job && typeof job.unit === 'string' ? job.unit : 'OFF DUTY';
	}

	private department(): string
	{
		const job = this.world.realismJob;
		return job && job.id === 'sheriff' ? 'COUNTY SHERIFF' : 'SAN VERANO POLICE';
	}

	private policeVehicle(): any
	{
		const p = this.player();
		const vehicle = p && p.occupyingSeat ? p.occupyingSeat.vehicle : null;
		const police = this.world.realismPolice;
		if (!vehicle || !vehicle.realismPolice || vehicle.realismPolice.dept !== (this.world.realismJob && this.world.realismJob.id)) return null;
		if (police && typeof police.isPoliceCar === 'function' && !police.isPoliceCar(vehicle)) return null;
		return vehicle;
	}

	private inPoliceVehicle(): boolean
	{
		return !!this.policeVehicle();
	}

	private render(): void
	{
		if (!this.body || !this.opened) return;
		if (!this.isOfficer())
		{
			this.body.innerHTML = '<div class="rr-le-card"><h3>Police duty ended</h3><p>Close this terminal and select your Police or Sheriff job in the phone.</p></div>';
			return;
		}
		const title = this.root.querySelector('#rr-le-title') as HTMLElement;
		const subtitle = this.root.querySelector('#rr-le-subtitle') as HTMLElement;
		title.textContent = this.tab === 'radio' ? 'IN-CAR RADIO' : (this.department() === 'COUNTY SHERIFF' ? 'SHERIFF MOBILE DATA TERMINAL' : 'POLICE MOBILE DATA TERMINAL');
		subtitle.textContent = this.tab === 'radio' ? this.channel + ' · UNIT ' + this.unit() : 'UNIT ' + this.unit() + ' · LOCAL RECORDS';
		this.panel.className = this.department() === 'COUNTY SHERIFF' ? 'rr-le-sheriff' : '';
		if (this.tab === 'mdt') this.renderMdt();
		else this.renderRadio();
	}

	private renderMdt(): void
	{
		const q = this.root.querySelector('[data-law-search]') as HTMLInputElement;
		const search = q ? q.value.toLowerCase() : '';
		const records = this.records.filter((r) => !search || (r.id + ' ' + r.type + ' ' + r.title + ' ' + r.detail + ' ' + r.unit).toLowerCase().indexOf(search) >= 0);
		const activeStops = this.records.filter((r) => r.type === 'Traffic stop' && r.status === 'Active');
		this.body.innerHTML =
			'<div class="rr-le-grid">' +
			'<article class="rr-le-card"><h3>New incident report</h3><form class="rr-le-form" data-form="incident">' +
			'<select name="category"><option>Traffic</option><option>Disturbance</option><option>Suspicious activity</option><option>Welfare check</option><option>Property</option><option>Other</option></select>' +
			'<input name="location" maxlength="80" placeholder="Location / cross streets">' +
			'<textarea class="wide" name="detail" maxlength="500" required placeholder="Factual report narrative"></textarea>' +
			'<button class="rr-le-btn primary" type="submit">File incident report</button></form></article>' +
			'<article class="rr-le-card"><h3>New citation</h3><form class="rr-le-form" data-form="citation">' +
			'<select name="violation"><option>Speeding</option><option>Failure to stop</option><option>Unsafe turn</option><option>Equipment violation</option><option>Other</option></select>' +
			'<input name="amount" type="number" min="0" max="5000" value="150" aria-label="Fine amount">' +
			'<input name="subject" maxlength="60" placeholder="Subject / vehicle ID">' +
			'<button class="rr-le-btn primary" type="submit">Issue local citation</button></form></article></div>' +
			'<article class="rr-le-card"><h3>Dispatch call</h3><form class="rr-le-form" data-form="call">' +
			'<select name="category"><option>Traffic incident</option><option>Disturbance</option><option>Welfare check</option><option>Suspicious activity</option><option>Property incident</option><option>General assistance</option></select>' +
			'<select name="priority"><option>Routine</option><option>Priority</option><option>Urgent</option></select>' +
			'<input name="location" maxlength="80" placeholder="Location / cross streets"><input name="detail" maxlength="180" required placeholder="Call details">' +
			'<button class="rr-le-btn primary" type="submit">Create local call</button></form></article>' +
			'<article class="rr-le-card"><h3>Traffic stop</h3><p>In a patrol vehicle, press F7 to signal AI traffic ahead to pull over. On foot, aim at a real vehicle and use this button to log the stop.</p>' +
			'<button class="rr-le-btn" data-action="traffic-stop">Record targeted vehicle stop</button></article>' +
			'<div class="rr-le-card"><h3>Dispatch calls</h3>' +
			(this.calls.length ? this.calls.map((c) => '<div class="rr-le-row"><div><strong>' + esc(c.title) + '</strong> <span class="rr-le-tag">' + esc(c.priority) + '</span><div class="rr-le-muted">' + esc(c.id) + ' · ' + esc(c.location) + ' · Unit ' + esc(this.unit()) + '</div></div>' +
			(c.status === 'Active' ? '<button class="rr-le-btn" data-action="close-call" data-id="' + esc(c.id) + '">Close call</button>' : '<span class="rr-le-tag">Closed</span>') + '</div>').join('') : '<p class="rr-le-muted">No calls.</p>') + '</div>' +
			'<div class="rr-le-card"><h3>Active traffic stops</h3>' +
			(activeStops.length ? activeStops.map((r) => '<div class="rr-le-row"><div><strong>' + esc(r.title) + '</strong><div class="rr-le-muted">' + esc(r.id) + ' · ' + esc(r.location) + '</div></div>' +
			'<button class="rr-le-btn" data-action="stop-warning" data-id="' + esc(r.id) + '">Warning</button> <button class="rr-le-btn" data-action="stop-citation" data-id="' + esc(r.id) + '">Citation</button> <button class="rr-le-btn" data-action="stop-clear" data-id="' + esc(r.id) + '">Clear</button></div>').join('') : '<p class="rr-le-muted">No active local stops.</p>') + '</div>' +
			'<div class="rr-le-card"><h3>Records search</h3><input class="rr-le-search" data-law-search placeholder="Search local incident, citation, stop, custody and radio logs"></div>' +
			'<div class="rr-le-card"><h3>Recent records <span class="rr-le-tag">' + records.length + '</span></h3>' +
			(records.length ? records.map((r) => '<div class="rr-le-row"><div><strong>' + esc(r.title) + '</strong> <span class="rr-le-tag">' + esc(r.type) + '</span><div class="rr-le-muted">' + esc(r.id) + ' · ' + esc(new Date(r.createdAt).toLocaleString()) + ' · ' + esc(r.location) + '</div><div>' + esc(r.detail) + '</div></div><span class="rr-le-tag">' + esc(r.status) + '</span></div>').join('') : '<p class="rr-le-muted">No local records yet.</p>') + '</div>';
		const newSearch = this.root.querySelector('[data-law-search]') as HTMLInputElement;
		if (newSearch) newSearch.value = search;
	}

	private renderRadio(): void
	{
		const messages = this.records.filter((r) => r.type === 'Radio' && r.status === this.channel);
		this.body.innerHTML =
			'<div class="rr-le-card"><h3>Text radio · ' + esc(this.channel) + '</h3><div class="rr-le-form">' +
			'<select data-action="channel">' + this.channelsForDepartment().map((c) => '<option' + (c === this.channel ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
			'<span class="rr-le-muted">Call sign: ' + esc(this.unit()) + ' · Voice/CB radio is not configured.</span></div>' +
			'<form class="rr-le-form" data-form="radio"><input class="wide" name="message" maxlength="240" required placeholder="Send a text radio message">' +
			'<button class="rr-le-btn primary" type="submit">Transmit</button></form></div>' +
			'<div class="rr-le-card"><h3>Channel traffic</h3>' +
			(messages.length ? messages.slice(0, 30).map((r) => '<div class="rr-le-row"><div><strong>' + esc(r.unit) + '</strong><div>' + esc(r.detail) + '</div></div><span class="rr-le-muted">' + esc(new Date(r.createdAt).toLocaleTimeString()) + '</span></div>').join('') : '<p class="rr-le-muted">No messages in this local channel.</p>') + '</div>';
	}

	private channelsForDepartment(): string[] { return CHANNELS.slice(); }

	private onClick(e: any): void
	{
		const target = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
		if (!target) return;
		const action = target.getAttribute('data-action');
		if (action === 'close') this.close();
		else if (!this.isOfficer()) this.message('Police duty is required.');
		else if (action === 'traffic-stop') this.startTrafficStop();
		else if (action === 'stop-warning') this.finishTrafficStop(target.getAttribute('data-id'), 'Warning');
		else if (action === 'stop-citation') this.finishTrafficStop(target.getAttribute('data-id'), 'Citation');
		else if (action === 'stop-clear') this.finishTrafficStop(target.getAttribute('data-id'), 'Cleared');
		else if (action === 'close-call') this.closeCall(target.getAttribute('data-id'));
	}

	private onSubmit(e: any): void
	{
		const form = e.target;
		if (!form || !form.getAttribute) return;
		const kind = form.getAttribute('data-form');
		if (!kind) return;
		e.preventDefault();
		if (!this.isOfficer()) { this.message('Police duty is required.'); return; }
		const value = (name: string): string =>
		{
			const el = form.elements.namedItem(name) as any;
			return el ? String(el.value || '').trim() : '';
		};
		if (kind === 'incident')
		{
			const category = value('category'), detail = value('detail');
			if (!detail) return;
			this.addRecord('Incident', category + ' report', detail, 'Filed', value('location'));
			this.message('Incident report filed locally.');
		}
		else if (kind === 'citation')
		{
			const subject = value('subject'), violation = value('violation');
			const amount = Math.max(0, Math.min(5000, Math.floor(Number(value('amount')) || 0)));
			this.addRecord('Citation', violation + ' · $' + amount, subject ? 'Subject / vehicle: ' + subject : 'Subject not entered.', 'Issued');
			this.message('Citation recorded locally.');
		}
		else if (kind === 'radio')
		{
			const text = value('message');
			if (!text) return;
			this.addRecord('Radio', 'Text radio', text, this.channel);
			const mp: any = typeof window !== 'undefined' ? (window as any).RRMP : null;
			const sent = !!(mp && typeof mp.sendPoliceRadio === 'function' && mp.sendPoliceRadio({
				channel: this.channel, department: this.world.realismJob.id, unit: this.unit(), message: text,
			}));
			this.message(sent ? 'Radio transmission sent to this server channel.' : 'Saved locally; join an online server to transmit.');
		}
		else if (kind === 'call')
		{
			const detail = value('detail');
			if (!detail) return;
			const position = this.officerPosition();
			const call: DispatchCall = {
				id: makeId('CALL'), title: value('category') + ': ' + detail, priority: value('priority') || 'Routine',
				location: value('location') || this.locationText(position), status: 'Active', createdAt: Date.now(),
			};
			this.calls.unshift(call);
			this.calls = this.calls.slice(0, MAX_CALLS);
			this.save();
			this.addRecord('Dispatch', 'Call created', call.title + ' · ' + call.priority, 'Active', call.location);
			this.message('Dispatch call created for unit ' + this.unit() + '.');
		}
		this.render();
	}

	private equipGlock(): void
	{
		const weapons = this.world.realismWeapons;
		if (!weapons || typeof weapons.equipById !== 'function') { this.message('Weapon system is unavailable.'); return; }
		weapons.equipById('pistol');
		this.message('Glock 19 equipped.');
		this.render();
	}

	private player(): any
	{
		return RealismJobs.playerCharacter(this.world);
	}

	private officerPosition(): THREE.Vector3
	{
		const p = this.player();
		if (!p) return new THREE.Vector3();
		const vehicle = p.occupyingSeat && p.occupyingSeat.vehicle;
		return (vehicle && vehicle.position ? vehicle.position : p.position).clone();
	}

	private locationText(position: THREE.Vector3): string
	{
		return Math.round(position.x) + ', ' + Math.round(position.z);
	}

	private playerOnFoot(): boolean
	{
		const p = this.player();
		return !!(p && !p.occupyingSeat && p.controlledObject === undefined && !p.vehicleEntryInstance);
	}

	private openConversation(): void
	{
		const npc = this.findNpc(8);
		if (!npc || !npc.agent || !npc.agent.alive)
		{
			this.message('Look toward an NPC within 8 m to start a conversation.');
			return;
		}
		if (this.opened) this.close();
		this.conversationNpc = npc;
		this.conversationNpcId = 'NPC-' + npc.agent.id;
		this.conversationMessages = [{ speaker: 'Officer', text: 'Good evening. I would like to ask you a few questions.' }];
		this.consentToSearch = false;
		this.conversationOpen = true;
		const chat = this.root.querySelector('#rr-le-chat') as HTMLElement;
		chat.style.display = 'block';
		if (typeof this.world.realismSetUIBlocking === 'function') this.world.realismSetUIBlocking('lawEnforcement', true);
		if (this.world.realismUI && typeof this.world.realismUI.exitLock === 'function') this.world.realismUI.exitLock();
		this.addRecord('Interaction', 'NPC interview started', 'Officer began a voluntary roleplay conversation with ' + this.conversationNpcId + '.', 'In progress');
		this.renderConversation();
	}

	private requestTrafficStop(): void
	{
		const vehicle = this.policeVehicle();
		const traffic = this.world.realismTraffic;
		if (!vehicle || !traffic || typeof traffic.requestPullOverNear !== 'function')
		{
			this.message('AI traffic pull-over is unavailable right now.');
			return;
		}
		const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(vehicle.quaternion);
		const targetId = traffic.requestPullOverNear(vehicle.position, forward, 80);
		if (!targetId)
		{
			this.message('No AI traffic vehicle found ahead within 80 m.');
			return;
		}
		const record = this.addRecord(
			'Traffic stop',
			'AI traffic stop requested',
			'Unit ' + this.unit() + ' signaled AI traffic vehicle ' + targetId + ' to pull over.',
			'Active',
			this.locationText(vehicle.position),
		);
		this.activeStopId = record.id;
		this.message('Traffic vehicle ' + targetId + ' is pulling over.');
	}

	private toggleRadar(): void
	{
		this.radarOpen = !this.radarOpen;
		if (this.radarPanel) this.radarPanel.style.display = this.radarOpen ? 'block' : 'none';
		this.radarAcc = 0;
		if (this.radarOpen) this.renderRadar();
	}

	private closeRadar(): void
	{
		this.radarOpen = false;
		if (this.radarPanel) this.radarPanel.style.display = 'none';
	}

	private renderRadar(): void
	{
		if (!this.radarOpen || !this.radarPanel) return;
		const patrol = this.policeVehicle();
		if (!patrol)
		{
			this.closeRadar();
			return;
		}
		this.radarForward.set(0, 0, 1).applyQuaternion(patrol.quaternion);
		this.radarForward.y = 0;
		if (this.radarForward.lengthSq() < 0.01) return;
		this.radarForward.normalize();
		const readings: { label: string; mph: number; distance: number }[] = [];
		const addReading = (position: any, velocity: any, label: string) =>
		{
			if (!position || !velocity) return;
			const dx = position.x - patrol.position.x, dz = position.z - patrol.position.z;
			const distance = Math.sqrt(dx * dx + dz * dz);
			if (distance < 3 || distance > 120) return;
			const ahead = dx * this.radarForward.x + dz * this.radarForward.z;
			const lateral = dx * this.radarForward.z - dz * this.radarForward.x;
			if (ahead < distance * 0.45 || Math.abs(lateral) > 10) return;
			const mph = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z) * 2.236936;
			if (!isFinite(mph) || mph < 2) return;
			readings.push({ label: label, mph: mph, distance: distance });
		};
		const traffic = this.world.realismTraffic;
		if (traffic && typeof traffic.debugCars === 'function')
		{
			const cars = traffic.debugCars();
			for (let i = 0; i < cars.length; i++)
			{
				const car = cars[i];
				if (typeof car.v !== 'number') continue;
				addReading(car, { x: car.hx * car.v, y: 0, z: car.hz * car.v }, 'AI traffic #' + car.id);
			}
		}
		const mp: any = typeof window !== 'undefined' ? (window as any).RRMP : null;
		if (mp && typeof mp.getRemoteRadarVehicles === 'function')
		{
			const remote = mp.getRemoteRadarVehicles();
			for (let i = 0; i < remote.length; i++)
			{
				const car = remote[i];
				addReading(car, { x: car.vx, y: car.vy, z: car.vz }, 'Player vehicle');
			}
		}
		const vehicles: any[] = this.world.vehicles || [];
		for (let i = 0; i < vehicles.length; i++)
		{
			const vehicle = vehicles[i];
			if (!vehicle || vehicle === patrol || !vehicle.position || !vehicle.collision || !vehicle.collision.velocity) continue;
			const name = vehicle.realismType || vehicle.name || 'vehicle';
			addReading(vehicle.position, vehicle.collision.velocity, String(name));
		}
		readings.sort((a, b) => a.distance - b.distance);
		const list = this.radarPanel.querySelector('#rr-le-radar-list') as HTMLElement;
		if (!list) return;
		if (!readings.length)
		{
			list.textContent = 'No moving traffic detected ahead.';
			return;
		}
		list.innerHTML = readings.slice(0, 5).map((reading) =>
			'<div class="rr-le-radar-hit' + (reading.mph > this.radarLimitMph ? ' over' : '') + '">' +
			'<span>' + esc(reading.label) + ' · ' + Math.round(reading.distance) + ' m</span><strong>' +
			Math.round(reading.mph) + ' mph</strong></div>').join('');
	}

	private renderConversation(): void
	{
		const chat = this.root && this.root.querySelector('#rr-le-chat') as HTMLElement;
		if (!chat || !this.conversationOpen || !this.conversationNpc) return;
		const agent = this.conversationNpc.agent;
		const detained = agent.detained === true;
		const dialogue = this.conversationMessages.map((m) =>
			'<div class="rr-le-chatline"><strong>' + esc(m.speaker) + ':</strong> ' + esc(m.text) + '</div>').join('');
		const questions = QUESTIONS.map((q, i) =>
			'<button class="rr-le-btn" data-question="' + esc(q.id) + '">' + (i + 1) + '. ' + esc(q.label) + '</button>').join('');
		const search = this.consentToSearch || detained
			? '<button class="rr-le-btn" data-action="consent-search">Search (consent / detained)</button>'
			: '';
		const custody = detained
			? '<button class="rr-le-btn" data-action="release-dialog">Release</button>'
			: '<span class="rr-le-muted">Use T to deploy the nonlethal taser; C to handcuff a stunned NPC.</span>';
		chat.innerHTML =
			'<h2>NPC Conversation · ' + esc(this.conversationNpcId) + '</h2>' +
			'<div class="rr-le-muted">Responses can be truthful or deceptive; statements are unverified and do not establish guilt.</div>' +
			'<div id="rr-le-chatlog">' + dialogue + '</div>' +
			'<div class="rr-le-questions">' + questions + '</div>' +
			'<div class="rr-le-row">' + search + custody +
			'<button class="rr-le-btn" data-action="release-dialog">End conversation</button></div>';
		const log = chat.querySelector('#rr-le-chatlog') as HTMLElement;
		if (log) log.scrollTop = log.scrollHeight;
	}

	private askQuestion(id: string): void
	{
		const npc = this.conversationNpc;
		if (!this.conversationOpen || !npc || !npc.agent || !npc.agent.alive) { this.closeConversation(); return; }
		let question: ConversationQuestion = null;
		for (let i = 0; i < QUESTIONS.length; i++) if (QUESTIONS[i].id === id) { question = QUESTIONS[i]; break; }
		if (!question) return;
		const seed = Math.abs(npc.agent.look + id.split('').reduce((sum, c) => sum + c.charCodeAt(0), 0));
		const truthIndex = seed % question.truth.length;
		const lying = Math.random() < 0.26;
		const answers = lying ? question.lie : question.truth;
		const answerIndex = lying ? Math.floor(Math.random() * answers.length) : truthIndex;
		const answer = answers[answerIndex];
		this.conversationMessages.push({ speaker: 'Officer', text: question.label });
		this.conversationMessages.push({ speaker: this.conversationNpcId, text: answer });
		this.conversationMessages = this.conversationMessages.slice(-24);
		this.addRecord('Interaction', 'NPC statement · ' + question.label, this.conversationNpcId + ' stated: "' + answer + '". Accuracy not verified.', 'Recorded');
		if (id === 'search-consent') this.consentToSearch = /yes|sure|go ahead|do not mind/i.test(answer);
		this.renderConversation();
	}

	private searchWithConsent(): void
	{
		const npc = this.conversationNpc;
		if (!this.conversationOpen || !npc || !npc.agent || !npc.agent.alive) { this.closeConversation(); return; }
		if (!this.consentToSearch && !npc.agent.detained)
		{
			this.conversationMessages.push({ speaker: 'Officer', text: 'I do not have consent or a recorded detention for a search.' });
			this.renderConversation();
			return;
		}
		const property = ['wallet, phone and keys', 'phone, transit card and keys', 'wallet and keys', 'phone, wallet and a folded receipt'][npc.agent.look % 4];
		const result = 'Simulated NPC inventory: ' + property + '. No contraband finding is implied.';
		this.conversationMessages.push({ speaker: 'Officer', text: result });
		this.addRecord('Search', 'NPC search completed', this.conversationNpcId + ' · ' + result, 'Recorded');
		this.renderConversation();
	}

	private closeConversation(): void
	{
		if (!this.conversationOpen) return;
		this.conversationOpen = false;
		this.conversationNpc = null;
		this.conversationNpcId = '';
		this.consentToSearch = false;
		const chat = this.root && this.root.querySelector('#rr-le-chat') as HTMLElement;
		if (chat) chat.style.display = 'none';
		if (!this.opened && typeof this.world.realismSetUIBlocking === 'function') this.world.realismSetUIBlocking('lawEnforcement', false);
		if (!this.opened && this.world.realismUI && typeof this.world.realismUI.requestLock === 'function') this.world.realismUI.requestLock();
	}

	private receiveRadio(payload: any): void
	{
		if (!this.isOfficer() || !payload || CHANNELS.indexOf(payload.channel) < 0 || payload.channel !== this.channel) return;
		if (payload.department !== 'police' && payload.department !== 'sheriff') return;
		const text = String(payload.message || '').trim().slice(0, 240);
		if (!text) return;
		const unit = String(payload.unit || 'Unknown unit').slice(0, 24);
		this.addRecord('Radio', 'Radio · ' + payload.channel, unit + ': ' + text, payload.channel);
		if (this.opened && this.tab === 'radio') this.render();
	}

	private cuffOrReleaseTarget(): void
	{
		const target = this.findNpc(3.2);
		if (!target) { this.message('Look at a person within 3 m.'); return; }
		if (target.agent.detained) { this.releaseTarget(); return; }
		this.cuffTarget();
	}

	private findNpc(maxDistance: number): any
	{
		if (!this.playerOnFoot() || !this.world.camera) return null;
		const npcs = this.world.realismNPCs;
		if (!npcs || typeof npcs.hitTest !== 'function') return null;
		this.world.camera.getWorldPosition(this.rayOrigin);
		this.world.camera.getWorldDirection(this.rayDirection);
		const hit = npcs.hitTest(this.rayOrigin, this.rayDirection, maxDistance);
		if (!hit || !hit.npc || !hit.npc.agent) return null;
		const p = this.player();
		const dx = hit.npc.root.position.x - p.position.x;
		const dz = hit.npc.root.position.z - p.position.z;
		if (dx * dx + dz * dz > maxDistance * maxDistance) return null;
		this.rayFrom.set(this.rayOrigin.x, this.rayOrigin.y, this.rayOrigin.z);
		this.rayTo.set(this.rayOrigin.x + this.rayDirection.x * hit.distance, this.rayOrigin.y + this.rayDirection.y * hit.distance, this.rayOrigin.z + this.rayDirection.z * hit.distance);
		this.rayResult.reset();
		try
		{
			if (this.world.physicsWorld.raycastClosest(this.rayFrom, this.rayTo, { collisionFilterMask: ~2, skipBackfaces: true }, this.rayResult) &&
				this.rayResult.hasHit && this.rayResult.distance + 0.05 < hit.distance) return null;
		}
		catch (e) { console.warn('[Realism] NPC line-of-sight check failed.', e); }
		return hit.npc;
	}

	private fireTaser(): void
	{
		if (!this.playerOnFoot()) { this.message('Use the taser on foot.'); return; }
		if (this.taserAmmo <= 0) { this.message('Taser empty. Reload a cartridge.'); return; }
		const target = this.findNpc(15);
		this.taserAmmo--;
		if (!target) { this.message('Taser missed. ' + this.taserAmmo + ' cartridge(s) remain.'); this.render(); return; }
		const npcs = this.world.realismNPCs;
		if (!npcs || typeof npcs.stun !== 'function' || !npcs.stun(target, 5))
		{
			this.message('That person cannot be affected by the taser.');
			this.render();
			return;
		}
		this.addRecord('Use of force', 'Taser deployment', 'NPC #' + target.agent.id + ' temporarily stunned; no lethal damage applied.', 'Recorded');
		this.message('NPC #' + target.agent.id + ' stunned for 5 seconds.');
		this.render();
	}

	private cuffTarget(): void
	{
		const target = this.findNpc(3.2);
		if (!target) { this.message('Look at a person within 3 m.'); return; }
		if (target.agent.detained) { this.message('That person is already detained.'); return; }
		if (!(target.agent.stunTimer > 0)) { this.message('The person must be briefly stunned before handcuffing.'); return; }
		const npcs = this.world.realismNPCs;
		if (!npcs || typeof npcs.setDetained !== 'function' || !npcs.setDetained(target, true)) { this.message('Could not restrain this person.'); return; }
		this.addRecord('Custody', 'NPC detained', 'NPC #' + target.agent.id + ' detained by unit ' + this.unit() + '.', 'Detained');
		this.message('NPC #' + target.agent.id + ' detained.');
		this.render();
	}

	private releaseTarget(): void
	{
		const target = this.findNpc(3.2);
		if (!target || !target.agent.detained) { this.message('Look at a detained person within 3 m.'); return; }
		const npcs = this.world.realismNPCs;
		if (!npcs || typeof npcs.setDetained !== 'function' || !npcs.setDetained(target, false)) { this.message('Could not release this person.'); return; }
		this.addRecord('Custody', 'NPC released', 'NPC #' + target.agent.id + ' released by unit ' + this.unit() + '.', 'Released');
		for (let i = 0; i < this.records.length; i++)
		{
			const r = this.records[i];
			if (r.type === 'Custody' && r.status === 'Detained' && r.detail.indexOf('NPC #' + target.agent.id + ' ') === 0) r.status = 'Released';
		}
		this.save();
		this.message('NPC released.');
		this.render();
	}

	private buildFlashlight(): void
	{
		const camera: any = this.world.camera;
		if (!camera || !camera.add) return;
		this.flashlight = new THREE.SpotLight(0xffefc4, 0, 32, Math.PI / 7, 0.35, 1.4);
		this.flashlight.castShadow = false;
		this.flashlight.visible = false;
		this.flashlightTarget = new THREE.Object3D();
		this.flashlight.position.set(0, 0, 0);
		this.flashlightTarget.position.set(0, 0, -1);
		camera.add(this.flashlight);
		camera.add(this.flashlightTarget);
		this.flashlight.target = this.flashlightTarget;
	}

	private toggleFlashlight(): void
	{
		if (!this.flashlight) { this.message('Flashlight is unavailable.'); return; }
		this.flashlightOn = !this.flashlightOn;
		this.flashlight.visible = this.flashlightOn;
		this.flashlight.intensity = this.flashlightOn ? 2.2 : 0;
		this.message(this.flashlightOn ? 'Flashlight on.' : 'Flashlight off.');
		this.render();
	}

	private deployCone(): void
	{
		if (!this.playerOnFoot()) { this.message('Deploy cones on foot.'); return; }
		if (this.cones.length >= 12) { this.message('Maximum of 12 cones deployed.'); return; }
		const camera: THREE.Camera = this.world.camera;
		camera.getWorldPosition(this.rayOrigin);
		camera.getWorldDirection(this.rayDirection);
		const x = this.rayOrigin.x + this.rayDirection.x * 2.8;
		const z = this.rayOrigin.z + this.rayDirection.z * 2.8;
		const y = this.ctx.data.heightAt(x, z);
		const group = new THREE.Group();
		group.name = 'RealismTrafficCone';
		const base = new THREE.Mesh(new THREE.BoxBufferGeometry(0.42, 0.055, 0.42), this.baseMaterial);
		base.position.y = 0.03;
		const body = new THREE.Mesh(new THREE.ConeBufferGeometry(0.17, 0.56, 10), this.coneMaterial);
		body.position.y = 0.33;
		const stripe = new THREE.Mesh(new THREE.CylinderBufferGeometry(0.125, 0.145, 0.09, 10), this.stripeMaterial);
		stripe.position.y = 0.32;
		group.add(base); group.add(body); group.add(stripe);
		group.position.set(x, y, z);
		group.rotation.y = Math.atan2(this.rayDirection.x, this.rayDirection.z);
		this.world.graphicsWorld.add(group);
		this.cones.push(group);
		this.addRecord('Equipment', 'Traffic cone deployed', 'Visual scene prop deployed near ' + this.locationText(new THREE.Vector3(x, y, z)) + '.', 'Placed');
		this.message('Traffic cone deployed.');
		this.render();
	}

	private removeCone(): void
	{
		if (!this.cones.length) { this.message('No deployed cones.'); return; }
		const player = this.officerPosition();
		let best = -1, distance = Infinity;
		for (let i = 0; i < this.cones.length; i++)
		{
			const d = this.cones[i].position.distanceToSquared(player);
			if (d < distance) { distance = d; best = i; }
		}
		if (best < 0 || distance > 36) { this.message('No cone within 6 m.'); return; }
		const group = this.cones.splice(best, 1)[0];
		this.world.graphicsWorld.remove(group);
		group.traverse((o: any) => { if (o.geometry) o.geometry.dispose(); });
		this.message('Nearest traffic cone removed.');
		this.render();
	}

	private findVehicle(): any
	{
		if (!this.world.camera || !this.world.physicsWorld) return null;
		this.world.camera.getWorldPosition(this.rayOrigin);
		this.world.camera.getWorldDirection(this.rayDirection);
		this.rayFrom.set(this.rayOrigin.x, this.rayOrigin.y, this.rayOrigin.z);
		this.rayTo.set(this.rayOrigin.x + this.rayDirection.x * 90, this.rayOrigin.y + this.rayDirection.y * 90, this.rayOrigin.z + this.rayDirection.z * 90);
		this.rayResult.reset();
		try
		{
			if (!this.world.physicsWorld.raycastClosest(this.rayFrom, this.rayTo, { skipBackfaces: true }, this.rayResult) || !this.rayResult.hasHit) return null;
		}
		catch (e) { console.warn('[Realism] Vehicle targeting failed.', e); return null; }
		const vehicles: any[] = this.world.vehicles || [];
		for (let i = 0; i < vehicles.length; i++) if (vehicles[i] && vehicles[i].collision === this.rayResult.body) return vehicles[i];
		return null;
	}

	private startTrafficStop(): void
	{
		const vehicle = this.findVehicle();
		if (!vehicle) { this.message('Aim at a vehicle within 90 m to record a stop.'); return; }
		const position = vehicle.position || this.officerPosition();
		const vehicleName = vehicle.realismType || vehicle.name || 'vehicle';
		const record = this.addRecord('Traffic stop', 'Stop initiated · ' + vehicleName, 'Vehicle targeted by unit ' + this.unit() + '. Local record only; the vehicle is not forced to stop.', 'Active', this.locationText(position));
		this.activeStopId = record.id;
		this.message('Traffic stop recorded. No vehicle behavior was changed.');
		this.render();
	}

	private finishTrafficStop(id: string, outcome: string): void
	{
		for (let i = 0; i < this.records.length; i++)
		{
			const record = this.records[i];
			if (record.id !== id || record.type !== 'Traffic stop' || record.status !== 'Active') continue;
			record.status = 'Completed · ' + outcome;
			this.save();
			if (outcome === 'Citation') this.addRecord('Citation', 'Citation during traffic stop', 'Violation and fine details were not entered in this local record. Stop: ' + record.id, 'Issued', record.location);
			else this.addRecord('Traffic stop', 'Stop completed · ' + outcome, 'Stop ' + record.id + ' completed by unit ' + this.unit() + '.', 'Completed', record.location);
			this.message('Traffic stop completed: ' + outcome + '.');
			this.render();
			return;
		}
		this.message('That traffic stop is no longer active.');
	}

	private closeCall(id: string): void
	{
		for (let i = 0; i < this.calls.length; i++)
		{
			if (this.calls[i].id !== id || this.calls[i].status !== 'Active') continue;
			this.calls[i].status = 'Closed';
			this.save();
			this.addRecord('Dispatch', 'Call closed', this.calls[i].title, 'Closed', this.calls[i].location);
			this.message('Dispatch call closed.');
			this.render();
			return;
		}
		this.message('That dispatch call is no longer active.');
	}

	private addRecord(type: string, title: string, detail: string, status: string, location?: string): LawRecord
	{
		const p = this.officerPosition();
		const r: LawRecord = {
			id: makeId(type.replace(/[^A-Z]/gi, '').toUpperCase().slice(0, 5) || 'LOG'),
			type: type, title: title, detail: detail, officer: this.department(), unit: this.unit(),
			location: location || this.locationText(p), status: status, createdAt: Date.now(),
		};
		this.records.unshift(r);
		this.records = this.records.slice(0, MAX_RECORDS);
		this.save();
		return r;
	}

	private message(text: string): void
	{
		if (!this.body) return;
		let el = this.root.querySelector('#rr-le-message') as HTMLElement;
		if (!el)
		{
			el = document.createElement('div');
			el.id = 'rr-le-message';
			el.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:10002;padding:10px 16px;border:1px solid #456;border-radius:7px;background:#102131;color:#eff8ff;font:13px Arial,sans-serif';
			this.root.appendChild(el);
		}
		el.textContent = text;
		el.style.display = 'block';
		window.setTimeout(() => { if (el) el.style.display = 'none'; }, 2200);
	}
}
