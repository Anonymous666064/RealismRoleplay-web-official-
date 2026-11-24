import { World } from '../world/World';
import { IInputReceiver } from '../interfaces/IInputReceiver';
import { EntityType } from '../enums/EntityType';
import { IUpdatable } from '../interfaces/IUpdatable';

export class InputManager implements IUpdatable
{
	public updateOrder: number = 3;

	public world: World;
	public domElement: any;
	public pointerLock: any;
	public isLocked: boolean;
	public inputReceiver: IInputReceiver;

	public boundOnMouseDown: (evt: any) => void;
	public boundOnMouseMove: (evt: any) => void;
	public boundOnMouseUp: (evt: any) => void;
	public boundOnMouseWheelMove: (evt: any) => void;
	public boundOnPointerlockChange: (evt: any) => void;
	public boundOnPointerlockError: (evt: any) => void;
	public boundOnKeyDown: (evt: any) => void;
	public boundOnKeyUp: (evt: any) => void;

	// Realism: keys / buttons forwarded to the input receiver and not yet released, so they can be
	// released when a menu or the phone opens (world.realismUIBlocking)
	private pressedKeys: { [code: string]: boolean } = {};
	private pressedButtons: { [code: string]: boolean } = {};
	private wasBlocking: boolean = false;
	
	constructor(world: World, domElement: HTMLElement)
	{
		this.world = world;
		this.pointerLock = world.params.Pointer_Lock;
		this.domElement = domElement || document.body;
		this.isLocked = false;
		
		// Bindings for later event use
		// Mouse
		this.boundOnMouseDown = (evt) => this.onMouseDown(evt);
		this.boundOnMouseMove = (evt) => this.onMouseMove(evt);
		this.boundOnMouseUp = (evt) => this.onMouseUp(evt);
		this.boundOnMouseWheelMove = (evt) => this.onMouseWheelMove(evt);

		// Pointer lock
		this.boundOnPointerlockChange = (evt) => this.onPointerlockChange(evt);
		this.boundOnPointerlockError = (evt) => this.onPointerlockError(evt);

		// Keys
		this.boundOnKeyDown = (evt) => this.onKeyDown(evt);
		this.boundOnKeyUp = (evt) => this.onKeyUp(evt);

		// Init event listeners
		// Mouse
		this.domElement.addEventListener('mousedown', this.boundOnMouseDown, false);
		document.addEventListener('wheel', this.boundOnMouseWheelMove, false);
		document.addEventListener('pointerlockchange', this.boundOnPointerlockChange, false);
		document.addEventListener('pointerlockerror', this.boundOnPointerlockError, false);
		
		// Keys
		document.addEventListener('keydown', this.boundOnKeyDown, false);
		document.addEventListener('keyup', this.boundOnKeyUp, false);

		world.registerUpdatable(this);
	}

	/** True while a Realism menu / the phone / another UI owner blocks gameplay input. */
	public get uiBlocking(): boolean
	{
		return !!(this.world as any).realismUIBlocking;
	}

	/** Releases every key and mouse button the receiver still thinks is held (character stops walking). */
	public releaseAll(): void
	{
		const r = this.inputReceiver;
		const fake = (code: string, button: number): any => ({
			code: code, button: button, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
			preventDefault: () => { /* synthetic */ }, stopPropagation: () => { /* synthetic */ },
		});
		const keys = Object.keys(this.pressedKeys), buttons = Object.keys(this.pressedButtons);
		this.pressedKeys = {};
		this.pressedButtons = {};
		if (r === undefined) return;
		for (const code of keys)
		{
			try { r.handleKeyboardEvent(fake(code, -1), code, false); } catch (e) { /* receiver changed */ }
		}
		for (const code of buttons)
		{
			try { r.handleMouseButton(fake(code, parseInt(code.replace('mouse', ''), 10) || 0), code, false); } catch (e) { /* receiver changed */ }
		}
	}

	public update(timestep: number, unscaledTimeStep: number): void
	{
		const blocking = this.uiBlocking;
		if (blocking && !this.wasBlocking) this.releaseAll();
		this.wasBlocking = blocking;

		if (this.inputReceiver === undefined && this.world !== undefined && this.world.cameraOperator !== undefined)
		{
			this.setInputReceiver(this.world.cameraOperator);
		}

		this.inputReceiver?.inputReceiverUpdate(unscaledTimeStep);
	}

	public setInputReceiver(receiver: IInputReceiver): void
	{
		this.inputReceiver = receiver;
		this.inputReceiver.inputReceiverInit();
	}

	public setPointerLock(enabled: boolean): void
	{
		this.pointerLock = enabled;
	}

	public onPointerlockChange(event: MouseEvent): void
	{
		if (document.pointerLockElement === this.domElement)
		{
			this.domElement.addEventListener('mousemove', this.boundOnMouseMove, false);
			this.domElement.addEventListener('mouseup', this.boundOnMouseUp, false);
			this.isLocked = true;
		}
		else
		{
			this.domElement.removeEventListener('mousemove', this.boundOnMouseMove, false);
			this.domElement.removeEventListener('mouseup', this.boundOnMouseUp, false);
			this.isLocked = false;
		}
	}

	public onPointerlockError(event: MouseEvent): void
	{
		console.error('PointerLockControls: Unable to use Pointer Lock API');
	}

	public onMouseDown(event: MouseEvent): void
	{
		if (this.uiBlocking) return;   // a menu / the phone is open: no pointer lock, no gameplay click
		if (this.pointerLock)
		{
			this.domElement.requestPointerLock();
		}
		else
		{
			this.domElement.addEventListener('mousemove', this.boundOnMouseMove, false);
			this.domElement.addEventListener('mouseup', this.boundOnMouseUp, false);
		}

		if (this.inputReceiver !== undefined)
		{
			this.pressedButtons['mouse' + event.button] = true;
			this.inputReceiver.handleMouseButton(event, 'mouse' + event.button, true);
		}
	}

	public onMouseMove(event: MouseEvent): void
	{
		if (this.uiBlocking) return;
		if (this.inputReceiver !== undefined)
		{
			this.inputReceiver.handleMouseMove(event, event.movementX, event.movementY);
		}
	}

	public onMouseUp(event: MouseEvent): void
	{
		if (!this.pointerLock)
		{
			this.domElement.removeEventListener('mousemove', this.boundOnMouseMove, false);
			this.domElement.removeEventListener('mouseup', this.boundOnMouseUp, false);
		}

		const code = 'mouse' + event.button;
		if (this.uiBlocking && !this.pressedButtons[code]) return;
		delete this.pressedButtons[code];
		if (this.inputReceiver !== undefined)
		{
			this.inputReceiver.handleMouseButton(event, code, false);
		}
	}

	public onKeyDown(event: KeyboardEvent): void
	{
		if (this.uiBlocking) return;
		if (this.inputReceiver !== undefined)
		{
			this.pressedKeys[event.code] = true;
			this.inputReceiver.handleKeyboardEvent(event, event.code, true);
		}
	}

	public onKeyUp(event: KeyboardEvent): void
	{
		if (this.uiBlocking && !this.pressedKeys[event.code]) return;
		delete this.pressedKeys[event.code];
		if (this.inputReceiver !== undefined)
		{
			this.inputReceiver.handleKeyboardEvent(event, event.code, false);
		}
	}

	public onMouseWheelMove(event: WheelEvent): void
	{
		if (this.uiBlocking) return;
		if (this.inputReceiver !== undefined)
		{
			this.inputReceiver.handleMouseWheel(event, event.deltaY);
		}
	}
}