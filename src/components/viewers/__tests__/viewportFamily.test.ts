import { describe, expect, it } from 'vitest';
import { viewportFor, type ViewportFamily } from '../viewportFamily';
import { getHandlerByKey, registry } from '@/lib/core/registry';

// Pins the viewport DISPATCH RULE the WorkspaceEditor relies on: every selection
// resolves to exactly one viewport family, the representative formats land on
// their intended bespoke viewer, and no-handler / unknown maps to the Hex
// fallback ('binary'). The mapping is pure (no React), so it runs headlessly.

const FAMILIES: ViewportFamily[] = ['texture', 'mesh', 'world', 'config', 'binary'];

describe('viewportFor dispatch', () => {
	it('maps a missing handler to the Hex fallback', () => {
		expect(viewportFor(undefined)).toBe('binary');
		expect(viewportFor(null)).toBe('binary');
	});

	it('routes texture formats to the texture viewer', () => {
		expect(viewportFor(getHandlerByKey('textures'))).toBe('texture');
		expect(viewportFor(getHandlerByKey('streamtex'))).toBe('texture');
	});

	it('routes mesh formats to the mesh viewer', () => {
		// 'havok' is a mesh format: vehicle .mainColl/.phys (and prop .hkPPs/.hkRBs)
		// convex hulls render as solid meshes; level .hkColl renders its AABB box.
		for (const key of ['model', 'skel', 'deform', 'mcl', 'havok']) {
			expect(viewportFor(getHandlerByKey(key))).toBe('mesh');
		}
	});

	it('routes World-category formats (incl. telemetry .track) to the world viewer', () => {
		for (const key of ['track', 'entities', 'linkorigins', 'sideways', 'checkpoints', 'nis']) {
			expect(viewportFor(getHandlerByKey(key))).toBe('world');
		}
	});

	it('routes config / shader formats to the config viewer', () => {
		for (const key of ['params', 'xml', 'powerplays', 'triggers', 'names', 'shaders', 'fxc']) {
			expect(viewportFor(getHandlerByKey(key))).toBe('config');
		}
	});

	it('assigns every registered handler to exactly one known family', () => {
		for (const h of registry) {
			const fam = viewportFor(h);
			expect(FAMILIES).toContain(fam);
		}
	});
});
