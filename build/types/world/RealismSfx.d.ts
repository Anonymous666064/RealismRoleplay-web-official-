export declare class RealismSfx {
    private world;
    private ac;
    private noise;
    private failed;
    private loops;
    played: {
        [name: string]: number;
    };
    constructor(world: any);
    private vol;
    private ctx;
    /** Filtered noise burst: type 'lowpass' | 'bandpass' | 'highpass', freq from f0 to f1 over dur seconds. */
    private burst;
    flush(): void;
    splash(strength: number): void;
    stroke(): void;
    click(): void;
    fridge(): void;
    drink(): void;
    /** Starts / stops a looping effect: 'shower' (falling water) or 'sizzle' (pan). */
    loop(id: string, on: boolean): void;
    stopAll(): void;
}
/** One shared instance per world. */
export declare function sfxFor(world: any): RealismSfx;
