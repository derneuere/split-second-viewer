// TextureViewer — the "texture" viewport family. Renders a decoded Crayon2
// "TEXS" texture set to a <canvas>: channel toggles, zoom, and the descriptor
// table (width/height/format/mips). Read-only.
//
// Props contract (filled by the Integrate-stage dispatcher):
//   { model, raw, handler }
//     model   — the ParsedTextures model from src/lib/core/textures.ts (or null
//               when the handler failed to parse).
//     raw     — the original file bytes. Required to decode pixels: the model
//               only holds the descriptor table; pixels are decoded on demand
//               via decodeLargestTexture(raw, model).
//     handler — the resolved ResourceHandler (unused for rendering; kept for the
//               common viewer props contract / future writeRaw wiring).
//
// The component tolerates a missing/partial model and an undecodable payload
// (frontend stubs whose pixels live in a sibling .streamtex, or formats we do
// not decode) by showing a clear message instead of throwing — the Hex fallback
// still renders alongside in the dispatcher.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, ZoomIn, ZoomOut, RefreshCw } from 'lucide-react';
import {
	decodeLargestTexture,
	type DecodedTexture,
	type ParsedTextures,
	type TextureDescriptor,
} from '@/lib/core/textures';
import type { ResourceHandler } from '@/lib/core/registry';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

export type TextureViewerProps = {
	/** Parsed TEXS model, or null/undefined when the handler failed to parse. */
	model?: ParsedTextures | null;
	/** Original file bytes — required to decode pixels. */
	raw?: Uint8Array | null;
	/** Resolved handler (not needed to render; part of the common contract). */
	handler?: ResourceHandler;
};

type Channels = { r: boolean; g: boolean; b: boolean; a: boolean };

const ALL_ON: Channels = { r: true, g: true, b: true, a: true };

const ZOOM_STEPS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;

function formatBadge(fmt: string): string {
	return fmt === 'raw' ? 'unknown' : fmt;
}

/** A small empty-state card with an icon + message (graceful fallback). */
function EmptyState({ title, detail }: { title: string; detail?: string }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
			<ImageIcon className="h-8 w-8" />
			<p className="text-sm font-medium text-foreground">{title}</p>
			{detail && <p className="max-w-md text-xs">{detail}</p>}
		</div>
	);
}

/** The descriptor table: one row per texture (format / dims / mips / name). */
function DescriptorTable({
	descriptors,
}: {
	descriptors: TextureDescriptor[];
}) {
	return (
		<div className="overflow-auto rounded-md border border-border">
			<table className="w-full text-left text-xs">
				<thead className="sticky top-0 bg-muted text-muted-foreground">
					<tr>
						<th className="px-2 py-1 font-medium">#</th>
						<th className="px-2 py-1 font-medium">Format</th>
						<th className="px-2 py-1 font-medium">Size</th>
						<th className="px-2 py-1 font-medium">Mips</th>
						<th className="px-2 py-1 font-medium">CRC</th>
						<th className="px-2 py-1 font-medium">Name</th>
					</tr>
				</thead>
				<tbody>
					{descriptors.map((d, i) => (
						<tr key={d.descOff} className="border-t border-border/60">
							<td className="px-2 py-1 text-muted-foreground">{i}</td>
							<td className="px-2 py-1 font-mono">{formatBadge(d.format)}</td>
							<td className="px-2 py-1 font-mono">
								{d.width}&times;{d.height}
							</td>
							<td className="px-2 py-1 font-mono">{d.mipCount}</td>
							<td className="px-2 py-1 font-mono text-muted-foreground">
								0x{(d.crc >>> 0).toString(16).toUpperCase().padStart(8, '0')}
							</td>
							<td className="max-w-[16rem] truncate px-2 py-1" title={d.name}>
								{d.name ?? <span className="text-muted-foreground">—</span>}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/**
 * Build a channel-masked RGBA buffer from a decoded surface. When only a single
 * colour channel is enabled we render it as greyscale so it is legible; when the
 * alpha channel alone is enabled we show alpha as greyscale; otherwise we keep
 * the enabled colour channels and force alpha opaque unless alpha is toggled on.
 */
function applyChannels(src: Uint8ClampedArray, ch: Channels): Uint8ClampedArray {
	const out = new Uint8ClampedArray(src.length);
	const colorCount = (ch.r ? 1 : 0) + (ch.g ? 1 : 0) + (ch.b ? 1 : 0);
	const soloAlpha = ch.a && colorCount === 0;
	const soloColor =
		colorCount === 1 && !ch.a
			? ch.r
				? 0
				: ch.g
					? 1
					: 2
			: -1;

	for (let i = 0; i < src.length; i += 4) {
		if (soloAlpha) {
			const a = src[i + 3];
			out[i] = a;
			out[i + 1] = a;
			out[i + 2] = a;
			out[i + 3] = 255;
			continue;
		}
		if (soloColor >= 0) {
			const v = src[i + soloColor];
			out[i] = v;
			out[i + 1] = v;
			out[i + 2] = v;
			out[i + 3] = 255;
			continue;
		}
		out[i] = ch.r ? src[i] : 0;
		out[i + 1] = ch.g ? src[i + 1] : 0;
		out[i + 2] = ch.b ? src[i + 2] : 0;
		out[i + 3] = ch.a ? src[i + 3] : 255;
	}
	return out;
}

export function TextureViewer({ model, raw }: TextureViewerProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [channels, setChannels] = useState<Channels>(ALL_ON);
	const [zoomIdx, setZoomIdx] = useState(2); // 1x by default
	const zoom = ZOOM_STEPS[zoomIdx];

	// Decode the largest inline texture once per (model, raw) pair. Wrapped in a
	// try so a malformed descriptor never crashes the viewport.
	const decoded = useMemo<{
		tex: DecodedTexture | null;
		error: string | null;
	}>(() => {
		if (!model || !raw) return { tex: null, error: null };
		try {
			const tex = decodeLargestTexture(raw, model);
			return { tex, error: null };
		} catch (err) {
			return { tex: null, error: String((err as Error)?.message ?? err) };
		}
	}, [model, raw]);

	const tex = decoded.tex;

	// Paint the (channel-masked) decoded surface to the canvas at native size;
	// CSS scales it by `zoom` so we keep crisp nearest-neighbour pixels.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !tex || !tex.rgba) return;
		canvas.width = tex.width;
		canvas.height = tex.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const masked = applyChannels(tex.rgba, channels);
		// Build via dimensions then copy in, so we never rely on the ImageData
		// constructor accepting a Uint8ClampedArray backed by an arbitrary
		// ArrayBufferLike (the lib.dom typings reject SharedArrayBuffer-backed views).
		const imageData = ctx.createImageData(tex.width, tex.height);
		imageData.data.set(masked);
		ctx.putImageData(imageData, 0, 0);
	}, [tex, channels]);

	// --- Fallback states -----------------------------------------------------

	if (!model) {
		return (
			<EmptyState
				title="No texture model"
				detail="This resource has no parsed TEXS model. The Hex fallback shows the raw bytes."
			/>
		);
	}

	if (model.textureCount === 0 || model.descriptors.length === 0) {
		return <EmptyState title="Empty texture set" detail="TEXS header lists 0 textures." />;
	}

	const toggle = (key: keyof Channels) =>
		setChannels((c) => ({ ...c, [key]: !c[key] }));

	const channelBtn = (key: keyof Channels, label: string, color: string) => (
		<Button
			variant={channels[key] ? 'default' : 'outline'}
			size="sm"
			className="h-7 w-9 px-0 font-mono text-xs"
			onClick={() => toggle(key)}
			title={`Toggle ${label} channel`}
		>
			<span className={channels[key] ? '' : 'opacity-60'} style={{ color }}>
				{label}
			</span>
		</Button>
	);

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
				<span className="text-xs font-semibold uppercase tracking-wide text-accent">
					Texture
				</span>

				{tex && (
					<>
						<span className="font-mono text-xs text-muted-foreground">
							{tex.width}&times;{tex.height}
						</span>
						<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
							{formatBadge(tex.format)}
						</span>
						<span className="font-mono text-xs text-muted-foreground">
							{tex.mips} mip{tex.mips === 1 ? '' : 's'}
						</span>
					</>
				)}

				<Separator orientation="vertical" className="h-5" />

				{/* Channel toggles */}
				<div className="flex items-center gap-1">
					{channelBtn('r', 'R', '#ff6b6b')}
					{channelBtn('g', 'G', '#51cf66')}
					{channelBtn('b', 'B', '#4dabf7')}
					{channelBtn('a', 'A', '#dee2e6')}
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs"
						onClick={() => setChannels(ALL_ON)}
						title="Reset channels"
					>
						<RefreshCw className="h-3 w-3" />
					</Button>
				</div>

				<Separator orientation="vertical" className="h-5" />

				{/* Zoom */}
				<div className="flex items-center gap-1">
					<Button
						variant="outline"
						size="sm"
						className="h-7 w-7 px-0"
						onClick={() => setZoomIdx((z) => Math.max(0, z - 1))}
						disabled={zoomIdx === 0}
						title="Zoom out"
					>
						<ZoomOut className="h-3 w-3" />
					</Button>
					<span className="w-12 text-center font-mono text-xs text-muted-foreground">
						{zoom < 1 ? `${zoom * 100}%` : `${zoom}x`}
					</span>
					<Button
						variant="outline"
						size="sm"
						className="h-7 w-7 px-0"
						onClick={() => setZoomIdx((z) => Math.min(ZOOM_STEPS.length - 1, z + 1))}
						disabled={zoomIdx === ZOOM_STEPS.length - 1}
						title="Zoom in"
					>
						<ZoomIn className="h-3 w-3" />
					</Button>
				</div>
			</div>

			{/* Canvas / fallback */}
			<div className="relative flex-1 overflow-auto bg-[#0a0a0a] p-4">
				{tex && tex.rgba ? (
					<div className="flex min-h-full min-w-full items-center justify-center">
						<canvas
							ref={canvasRef}
							className="shadow-glow"
							style={{
								width: tex.width * zoom,
								height: tex.height * zoom,
								imageRendering: zoom >= 1 ? 'pixelated' : 'auto',
								// Checkerboard so alpha is visible.
								backgroundColor: '#1a1a1a',
								backgroundImage:
									'linear-gradient(45deg, #2a2a2a 25%, transparent 25%), linear-gradient(-45deg, #2a2a2a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #2a2a2a 75%), linear-gradient(-45deg, transparent 75%, #2a2a2a 75%)',
								backgroundSize: '16px 16px',
								backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
							}}
						/>
					</div>
				) : (
					<div className="flex h-full items-center justify-center">
						<EmptyState
							title={
								decoded.error
									? 'Decode failed'
									: model.isStub
										? 'Pixels live in a sibling .streamtex'
										: 'Texture not decodable inline'
							}
							detail={
								decoded.error ??
								(model.isStub
									? 'This is a frontend stub: it carries descriptors but the swizzled pixel payload is stored in the companion .streamtex file. Open the .streamtex to view the image. The descriptor table is shown below.'
									: 'The largest texture could not be decoded from this file (unsupported format or multi-texture inline layout). The descriptor table is shown below.')
							}
						/>
					</div>
				)}
			</div>

			{/* Descriptor table */}
			<div className="max-h-[40%] overflow-auto border-t border-border p-3">
				<div className="mb-2 flex items-baseline justify-between">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Descriptors
					</h3>
					<span className="font-mono text-xs text-muted-foreground">
						{model.textureCount} texture{model.textureCount === 1 ? '' : 's'}
						{model.isStub && (
							<span className="ml-2 rounded bg-accent/20 px-1.5 py-0.5 text-accent">
								stub
							</span>
						)}
					</span>
				</div>
				<DescriptorTable descriptors={model.descriptors} />
			</div>
		</div>
	);
}

export default TextureViewer;
