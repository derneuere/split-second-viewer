// Generic hex fallback viewer. Every Resource gets this even without a handler
// (PORT-BRIEF §6 / "Hex fallback"). Virtualized so multi-MB members stay
// responsive. Read-only.

import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const BYTES_PER_ROW = 16;

function toHex(b: number): string {
	return b.toString(16).padStart(2, '0');
}

function toAscii(b: number): string {
	return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
}

export type HexViewProps = {
	data: Uint8Array | null;
	/** Optional label shown above the dump. */
	title?: string;
};

export function HexView({ data, title }: HexViewProps) {
	const parentRef = useRef<HTMLDivElement>(null);

	const rowCount = data ? Math.ceil(data.byteLength / BYTES_PER_ROW) : 0;

	const virtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 20,
		overscan: 24,
	});

	const offsetWidth = useMemo(() => {
		if (!data) return 6;
		return Math.max(6, data.byteLength.toString(16).length);
	}, [data]);

	if (!data) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				No data to display
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-baseline justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
				<span>{title ?? 'Hex view'}</span>
				<span>
					{data.byteLength.toLocaleString()} bytes (0x
					{data.byteLength.toString(16)})
				</span>
			</div>
			<div ref={parentRef} className="flex-1 overflow-auto px-3 py-2 text-xs leading-5">
				<div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
					{virtualizer.getVirtualItems().map((vrow) => {
						const rowStart = vrow.index * BYTES_PER_ROW;
						const rowBytes = data.subarray(rowStart, rowStart + BYTES_PER_ROW);
						const hex: string[] = [];
						let ascii = '';
						for (let i = 0; i < BYTES_PER_ROW; i++) {
							if (i < rowBytes.length) {
								hex.push(toHex(rowBytes[i]));
								ascii += toAscii(rowBytes[i]);
							} else {
								hex.push('  ');
								ascii += ' ';
							}
						}
						return (
							<div
								key={vrow.key}
								className="absolute left-0 flex w-full gap-4 whitespace-pre font-mono"
								style={{ top: vrow.start, height: vrow.size }}
							>
								<span className="text-accent">
									{rowStart.toString(16).padStart(offsetWidth, '0')}
								</span>
								<span className="text-foreground">
									{hex.slice(0, 8).join(' ')} {hex.slice(8).join(' ')}
								</span>
								<span className="text-muted-foreground">{ascii}</span>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

export default HexView;
