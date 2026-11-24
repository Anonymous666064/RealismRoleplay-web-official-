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
export function ownGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry
{
	const g = new THREE.BufferGeometry();
	const attrs: any = src.attributes;
	for (const k in attrs) g.setAttribute(k, attrs[k]);
	if (src.index) g.setIndex(src.index);
	for (let i = 0; i < src.groups.length; i++) g.addGroup(src.groups[i].start, src.groups[i].count, src.groups[i].materialIndex);
	g.drawRange.start = src.drawRange.start; g.drawRange.count = src.drawRange.count;
	if (src.boundingBox) g.boundingBox = src.boundingBox.clone();
	if (src.boundingSphere) g.boundingSphere = src.boundingSphere.clone();
	g.name = (src.name || 'geom') + '#own';
	return g;
}

/**
 * Headless/debug check: InstancedMeshes in `root` that share a geometry object with another
 * InstancedMesh (the condition that triggers the bug above). Returns their names.
 */
export function sharedInstancedGeometry(root: THREE.Object3D): string[]
{
	const seen = new Map<number, string>();
	const bad: string[] = [];
	root.traverse((o: any) =>
	{
		if (!o.isInstancedMesh || !o.geometry) return;
		const id = o.geometry.id;
		if (seen.has(id)) bad.push(seen.get(id) + ' & ' + (o.name || o.uuid));
		else seen.set(id, o.name || o.uuid);
	});
	return bad;
}
