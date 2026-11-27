import * as THREE from 'three';
/**
 * three r113 bug workaround (the "only wheels, no body" NPC car bug).
 *
 * WebGLRenderer.renderBufferDirect only re-binds vertex attributes (setupVertexAttributes) when
 * the geometry id or the program id changes since the previous draw. In r113 the per-instance
 * `instanceMatrix` attribute belongs to the InstancedMesh, NOT to the geometry, so when two
 * InstancedMeshes that share one geometry and compile to the same program are drawn back to
 * back, the second one is drawn with the FIRST mesh's instance matrices (its own buffer is never
 * bound). The unused slots of that buffer are zero matrices, so every body after the first
 * collapses to a point and is invisible. Wheels were one single InstancedMesh, so they drew fine.
 *
 * Fix: every InstancedMesh gets its own BufferGeometry object (own geometry id). The attribute
 * objects (and so the GPU buffers) are shared, so this costs no memory.
 */
export declare function ownGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry;
/**
 * Headless/debug check: InstancedMeshes in `root` that share a geometry object with another
 * InstancedMesh (the condition that triggers the bug above). Returns their names.
 */
export declare function sharedInstancedGeometry(root: THREE.Object3D): string[];
