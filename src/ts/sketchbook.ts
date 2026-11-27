import '../css/main.css';
import * as THREE from 'three';
import * as CANNON from 'cannon';

(window as any).THREE = THREE;
(window as any).CANNON = CANNON;

export { World } from './world/World';