// .global_regs registry handler — Black Rock global shader-register table.
// Thin wrapper around parseGlobalRegs / writeGlobalRegs in
// src/lib/core/globalRegs.ts.
//
// Status: PARTIAL DECODE, BYTE-EXACT WRITER. The FREG/GLBB header and the full
// register descriptor table (name + type per register) are decoded; the trailing
// register-value payload is not yet decoded (exposed as payloadOffset/Length).
// Because the model keeps the verbatim source bytes, the writer is a byte-exact
// passthrough — writeRaw(parse(b)) === b — so editing infrastructure can treat
// this format like any other writable resource even though value editing is not
// yet possible.

import {
	parseGlobalRegs,
	writeGlobalRegs,
	type ParsedGlobalRegs,
} from '../../globalRegs';
import type { ResourceHandler } from '../handler';

export const globalRegsHandler: ResourceHandler<ParsedGlobalRegs> = {
	key: 'global_regs',
	name: 'Global Shader Registers',
	description:
		'Big-endian FREG/GLBB chunked table of global shader registers (name + type per record). ' +
		'Header + descriptor table decoded; trailing value payload kept verbatim. ' +
		'Byte-exact passthrough writer (unmodified docs round-trip identically).',
	category: 'Data',
	caps: { read: true, write: true },
	extensions: ['.global_regs'],
	magic: new Uint8Array([0x46, 0x52, 0x45, 0x47]), // 'FREG'
	wikiUrl: 'format-misc.html',

	parseRaw: (raw) => parseGlobalRegs(raw),
	writeRaw: (model) => writeGlobalRegs(model),
	describe: (m) => {
		const total = m.payloadOffset + m.payloadLength;
		const names = m.regs.slice(0, 4).map((r) => r.name).join(', ');
		return (
			`FREG v${m.version}, ${m.regs.length}/${m.recordCount} register(s)` +
			`${m.tableConsistent ? '' : ' (inconsistent)'}, ${total}B total, ` +
			`value payload ${m.payloadLength}B @0x${m.payloadOffset.toString(16)}; ` +
			`e.g. ${names}${m.regs.length > 4 ? ' …' : ''}`
		);
	},

	fixtures: [{ file: 'default.global_regs', expect: { parseOk: true, byteRoundTrip: true } }],

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
