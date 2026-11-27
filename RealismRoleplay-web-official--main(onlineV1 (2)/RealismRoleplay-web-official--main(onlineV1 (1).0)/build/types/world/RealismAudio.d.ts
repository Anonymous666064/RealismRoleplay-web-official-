export interface ShotVoice {
    crack: number;
    crackFreq: number;
    body: number;
    bodyFreq: number;
    bodyDecay: number;
    thump: number;
    thumpFreq: number;
    thumpDecay: number;
    tail: number;
    tailDecay: number;
    gain: number;
}
/** Built-in voices, per weapon kind. */
export declare const SHOT_VOICES: {
    [kind: string]: ShotVoice;
};
export declare type ReloadKind = 'pistol' | 'smg' | 'shotgun' | 'rifle';
export declare class WeaponAudio {
    ctx: any;
    enabled: boolean;
    volume: number;
    private master;
    private noise;
    private files;
    private world;
    private unlockHandler;
    constructor(world: any, volume: number);
    /** Creates / resumes the AudioContext. Call from a user gesture. */
    unlock(): void;
    private ready;
    private level;
    private noiseBurst;
    private tone;
    private bus;
    /** Metallic click: short highpassed noise + a tiny square blip. */
    private click;
    /** Duller plastic / metal thunk. */
    private thunk;
    /** Sliding scrape (slide / bolt / pump travel). */
    private slide;
    /** Starts decoding a sound file (once). */
    preload(path: string): void;
    private fileBuffer;
    /** Plays a decoded file now. Returns false if it isn't ready (caller uses the built-in sound). */
    private playFile;
    /**
     * A gunshot. `voice` is a key of SHOT_VOICES (pistol / smg / shotgun / rifle) or a ShotVoice.
     * `distance` (metres, optional) attenuates and muffles it: for NPC gunfire.
     */
    shot(voice: string | ShotVoice, file?: string, distance?: number): void;
    /** Trigger pulled on an empty gun. */
    dryFire(file?: string): void;
    /** Weapon switched / drawn. */
    equip(kind: string): void;
    /** Punch swing (and a thud when it lands). */
    punch(hit: boolean): void;
    /** Reload sounds, spread over `duration` seconds. */
    reload(kind: ReloadKind, duration: number, file?: string, shells?: number): void;
    dispose(): void;
}
