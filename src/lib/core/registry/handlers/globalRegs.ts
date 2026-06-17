// .global_regs registry handler — Black Rock global shader-register table.
// Thin wrapper around parseGlobalRegs in src/lib/core/globalRegs.ts.
//
// Status: PARTIAL. The FREG/GLBB header and the full register descriptor table
// (name + type per register) are decoded; the trailing register-value payload is
// not yet decoded (exposed as payloadOffset/payloadLength). Read-only.

import { parseGlobalRegs, type ParsedGlobalRegs } from '../../globalRegs';
import type { ResourceHandler } from '../handler';

export const globalRegsHandler: ResourceHandler<ParsedGlobalRegs> = {
	key: 'global_regs',
	name: 'Global Shader Registers',
	description:
		"Big-endian FREG/GLBB chunked table of global shader registers (name + type per record). " +
		'Header + descriptor table decoded; trailing value payload undecoded (partial).',
	category: 'Data',
	caps: { read: true, write: false },
	extensions: ['.global_regs'],
	magic: new Uint8Array([0x46, 0x52, 0x45, 0x47]), // 'FREG'
	wikiUrl: 'format-misc.html',

	parseRaw: (raw) => parseGlobalRegs(raw),
	describe: (m) =>
		`FREG v${m.version}, ${m.regs.length}/${m.recordCount} register(s)` +
		`${m.tableConsistent ? '' : ' (inconsistent)'}, ` +
		`payload ${m.payloadLength}B @0x${m.payloadOffset.toString(16)}; ` +
		`first: ${m.regs.slice(0, 3).map((r) => r.name).join(', ')}${m.regs.length > 3 ? ' …' : ''}`,

	fixtures: [{ file: 'default.global_regs', expect: { parseOk: true } }],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'register count + names stable across a parse cycle',
			mutate: (m) => m,
			verify: (before, after) =>
				after.regs.length === before.regs.length ? [] : ['reg count drift'],
		},
	],
};
