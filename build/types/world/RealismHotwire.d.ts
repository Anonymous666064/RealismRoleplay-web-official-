import { IllegalCore, TimingGame } from './RealismIllegalCore';
export declare class Hotwire {
    api: any;
    active: boolean;
    car: any;
    game: TimingGame;
    last: {
        success: boolean;
        hits: number;
        misses: number;
        tier: number;
    };
    private core;
    private done;
    private audio;
    private hadWorld;
    constructor(core: IllegalCore);
    difficulty(car: any): {
        tier: number;
        zone: number;
        speed: number;
        value: number;
        type: string;
    };
    start(car: any, done: (success: boolean) => void): void;
    private finish;
    private hold;
    update(dt: number): void;
    alarmCount: number;
    /** Car alarm: two-tone square wave for ~2.5 s (WebAudio, realismVolume). */
    alarm(): void;
    /** Tests: use a fake AudioContext. */
    useAudioContext(ac: any): void;
}
