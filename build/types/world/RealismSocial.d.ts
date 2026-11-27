import { RealismCtx } from './RealismContext';
export declare const SOCIAL_KEY = "realism.social.v1";
export interface Account {
    h: string;
    n: string;
    hue: number;
    bio: string;
    ch?: string;
    npc: boolean;
}
export interface Comment {
    h: string;
    text: string;
    t: number;
}
export interface Chirp {
    id: string;
    h: string;
    text: string;
    t: number;
    likes: number;
    rt: number;
    liked?: boolean;
    comments: Comment[];
    cc: number;
    pending?: number[];
    player?: boolean;
    tag?: string;
}
export interface Snap {
    id: string;
    h: string;
    kind: string;
    seed: number;
    caption: string;
    t: number;
    likes: number;
    liked?: boolean;
    player?: boolean;
    hour: number;
}
export interface Video {
    id: string;
    h: string;
    title: string;
    kind: string;
    dur: number;
    views: number;
    likes: number;
    seed: number;
    t: number;
    liked?: boolean;
    extra?: string;
}
export interface SocialSettings {
    playerName: string;
    playerHandle: string;
    chirpEvery: number;
    snapEvery: number;
    videoEvery: number;
    maxChirps: number;
    maxSnaps: number;
    maxVideos: number;
}
export declare function socialSettings(cfg: any): SocialSettings;
export declare class RealismSocial {
    settings: SocialSettings;
    accounts: Account[];
    byHandle: {
        [h: string]: Account;
    };
    chirps: Chirp[];
    snaps: Snap[];
    videos: Video[];
    minutes: number;
    generated: {
        chirps: number;
        snaps: number;
        videos: number;
        reactions: number;
    };
    player: Account;
    private ctx;
    private world;
    private rnd;
    private nextId;
    private nextChirp;
    private nextSnap;
    private nextVideo;
    private lastCrimePost;
    private listeners;
    private places;
    private roads;
    private hotels;
    private hoods;
    private dirty;
    /** Car names for reviews (set by the laptop from the dealership catalogue). */
    carNames: string[];
    constructor(ctx: RealismCtx);
    private buildPlaces;
    private buildAccounts;
    private addAccount;
    account(h: string): Account;
    private people;
    private pick;
    /** Fresh install: a backdated feed so the sites are not empty. */
    private seed;
    /** The internet clock lined itself up with the game clock: move "now" and reschedule. */
    setClock(minutes: number): void;
    private scheduleAll;
    private gap;
    clockFromWorld(prev: number): number;
    /** Called by the internet clock with the new absolute game minute. Generates due content. */
    tick(minutes: number): void;
    private timeOfDay;
    private fill;
    private npcChirp;
    private mkChirp;
    private npcSnap;
    private npcVideo;
    private reply;
    onCrime(data: any): void;
    onCarStolen(data: any): void;
    onPropertyBought(data: any): void;
    onCarBought(name: string): void;
    private nearestPlace;
    private addChirp;
    private addSnap;
    private addVideo;
    /** Drops the oldest NPC items first; the player's own posts go last. */
    private cap;
    post(text: string): Chirp | null;
    postSnap(caption: string): Snap;
    comment(id: string, text: string): boolean;
    /** Toggles your like on a chirp / snap / video. Returns the new liked state. */
    like(kind: string, id: string): boolean;
    view(id: string): void;
    find(kind: string, id: string): Chirp | Snap | Video | null;
    channelKind(h: string): string;
    onChange(cb: () => void): void;
    private changed;
    /** "5m", "3h", "2d" in game time. */
    ago(t: number): string;
    private load;
    save(): void;
}
export declare function titleCase(s: string): string;
