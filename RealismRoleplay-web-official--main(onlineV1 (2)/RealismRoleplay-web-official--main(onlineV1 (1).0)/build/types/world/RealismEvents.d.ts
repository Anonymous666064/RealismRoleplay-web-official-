export interface RealismEventBus {
    on(name: string, cb: (data: any) => void): void;
    off(name: string, cb: (data: any) => void): void;
    emit(name: string, data?: any): void;
}
export declare function ensureEvents(world: any): RealismEventBus;
