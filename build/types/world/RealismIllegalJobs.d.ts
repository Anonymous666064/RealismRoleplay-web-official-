import * as THREE from 'three';
import { IllegalCore, Site } from './RealismIllegalCore';
import { Hideouts } from './RealismHideouts';
export interface Contact {
    id: string;
    name: string;
    role: string;
    site: Site;
    blip: string;
    color: string;
    figure: THREE.Object3D;
    marker: THREE.Object3D;
}
export declare class IllegalJobs {
    api: any;
    contacts: Contact[];
    stations: {
        id: string;
        hideout: string;
        kind: string;
        x: number;
        y: number;
        z: number;
    }[];
    private core;
    private hideouts;
    private acc;
    constructor(core: IllegalCore, hideouts: Hideouts);
    private hoodRect;
    /** A spot beside a building inside a rect (closest to its centre first). */
    private siteIn;
    private placeContacts;
    private addContact;
    contact(id: string): Contact;
    present(c: Contact): boolean;
    price(contact: string, item: string): number;
    buy(item: string, qty: number): boolean;
    private dealerRoom;
    /** Sells qty (<= 0: as many as allowed) of an item; returns the number sold. */
    sell(contact: string, item: string, qty: number): number;
    private openContact;
    private buildStations;
    private bench;
    private kitchenItems;
    lastBatch: {
        cups: number;
        success: boolean;
    };
    startKitchen(id: string): boolean;
    lab(): any;
    private labItems;
    private labAct;
    startMix(): boolean;
    press(): boolean;
    startPack(): boolean;
    collect(): number;
    update(dt: number): void;
}
