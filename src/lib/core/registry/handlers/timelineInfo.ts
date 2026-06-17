// .timelineInfo registry handler — Catnip timeline-particle index.
// Thin wrapper around parseTimelineInfo / writeTimelineInfo.

import {
	parseTimelineInfo,
	writeTimelineInfo,
	type ParsedTimelineInfo,
} from '../../timelineInfo';
import type { ResourceHandler } from '../handler';

export const timelineInfoHandler: ResourceHandler<ParsedTimelineInfo> = {
	key: 'timelineInfo',
	name: 'Timeline-Particle Index',
	description:
		'Big-endian 8-byte header (version=1, count) + count×12-byte records ' +
		'{uint64 controllerHash, uint32 index}. Size law: 8 + count×12.',
	category: 'World',
	caps: { read: true, write: true },
	extensions: ['.timelineinfo'],
	wikiUrl: 'https://burnout.wiki/format-timeline.html',

	parseRaw: (raw) => parseTimelineInfo(raw),
	writeRaw: (model) => writeTimelineInfo(model),
	describe: (m) => {
		const r0 = m.records[0];
		const head = r0 ? ` first hash=${r0.controllerHash}` : '';
		return (
			`v${m.version}, ${m.count} record${m.count === 1 ? '' : 's'}` +
			`${m.sizeLawOk ? '' : ' (size-law MISMATCH)'}${head}`
		);
	},

	fixtures: [
		{
			file: 'Environments/Levels/Downtown/Subtracks/A/Particles/TimelineParticles/Light/Light.timelineInfo',
			expect: { parseOk: true, byteRoundTrip: true },
		},
		{
			// empty 8-byte header-only file (count == 0)
			file: 'Environments/Levels/Downtown/Particles/TimelineParticles/Flare/Flare.timelineInfo',
			expect: { parseOk: true, byteRoundTrip: true },
		},
	],

	stressScenarios: [
		{
			name: 'baseline',
			description: 'no mutation',
			mutate: (m) => m,
			verify: (before, after) =>
				after.count === before.count ? [] : [`count mismatch`],
		},
		{
			name: 'append',
			description: 'append one record reusing the first hash',
			mutate: (m) => {
				const hash = m.records[0]?.controllerHash ?? '0x0000000000000000';
				return {
					...m,
					count: m.count + 1,
					sizeLawOk: true,
					records: [...m.records, { controllerHash: hash, index: m.count }],
				};
			},
			verify: (afterMutate, afterReparse) => {
				const tail = afterReparse.records.at(-1);
				const want = afterMutate.records.at(-1);
				return tail && want && tail.controllerHash === want.controllerHash && tail.index === want.index
					? []
					: [`appended record not preserved`];
			},
		},
	],
};
