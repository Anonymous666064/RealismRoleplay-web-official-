import { World } from '../world/World';
import { IInputReceiver } from '../interfaces/IInputReceiver';
import { IUpdatable } from '../interfaces/IUpdatable';
export declare class InputManager implements IUpdatable {
    updateOrder: number;
    world: World;
    domElement: any;
    pointerLock: any;
    isLocked: boolean;
    inputReceiver: IInputReceiver;
    boundOnMouseDown: (evt: any) => void;
    boundOnMouseMove: (evt: any) => void;
    boundOnMouseUp: (evt: any) => void;
    boundOnMouseWheelMove: (evt: any) => void;
    boundOnPointerlockChange: (evt: any) => void;
    boundOnPointerlockError: (evt: any) => void;
    boundOnKeyDown: (evt: any) => void;
    boundOnKeyUp: (evt: any) => void;
    private pressedKeys;
    private pressedButtons;
    private wasBlocking;
    constructor(world: World, domElement: HTMLElement);
    /** True while a Realism menu / the phone / another UI owner blocks gameplay input. */
    get uiBlocking(): boolean;
    /** Releases every key and mouse button the receiver still thinks is held (character stops walking). */
    releaseAll(): void;
    update(timestep: number, unscaledTimeStep: number): void;
    setInputReceiver(receiver: IInputReceiver): void;
    setPointerLock(enabled: boolean): void;
    onPointerlockChange(event: MouseEvent): void;
    onPointerlockError(event: MouseEvent): void;
    onMouseDown(event: MouseEvent): void;
    onMouseMove(event: MouseEvent): void;
    onMouseUp(event: MouseEvent): void;
    onKeyDown(event: KeyboardEvent): void;
    onKeyUp(event: KeyboardEvent): void;
    onMouseWheelMove(event: WheelEvent): void;
}
