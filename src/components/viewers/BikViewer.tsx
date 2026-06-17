// BikViewer — the "video" viewport family. Plays a RAD Bink (.bik) movie fully
// in the browser: video via the pure-TypeScript Bink 1 decoder in
// src/lib/core/bink/ (no ffmpeg, no transcoding, no WASM), and audio via the
// pure-TS binkaudio decoder fed to the Web Audio API. Frames are decoded on
// demand by a requestAnimationFrame driver following a wall-clock playback
// timer; the decoded RGBA is blitted to a <canvas>. Audio is decoded up front
// (off the first paint) into an AudioBuffer and played in sync.
//
// Props contract (filled by ViewportRouter):
//   model   — ParsedBik header metadata (or null when the parse failed).
//   raw     — the original .bik bytes; required to construct the decoders.
//   handler — the resolved handler (unused for rendering; common contract).
//
// Bink 2 (KB2*) and parse failures render a graceful message; the Hex fallback
// still shows the raw bytes in the dispatcher.

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Repeat, Film, AlertTriangle, Volume2, VolumeX } from 'lucide-react';
import { BinkVideo } from '@/lib/core/bink/binkVideo';
import { BinkAudio } from '@/lib/core/bink/binkAudio';
import { formatBikFps, type ParsedBik } from '@/lib/core/bik';
import type { ResourceHandler } from '@/lib/core/registry';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

export type BikViewerProps = {
	model?: ParsedBik | null;
	raw?: Uint8Array | null;
	handler?: ResourceHandler;
};

/** Per-rAF-tick decode time budget (ms) — caps how long one tick blocks the main
 *  thread when catching up after a seek, keeping the UI responsive. */
const DECODE_BUDGET_MS = 24;

type DecodedAudio = { pcm: Int16Array; sampleRate: number; channels: number };

function fmtTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) seconds = 0;
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}

function EmptyState({ title, detail }: { title: string; detail?: string }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
			<Film className="h-8 w-8" />
			<p className="text-sm font-medium text-foreground">{title}</p>
			{detail && <p className="max-w-md text-xs">{detail}</p>}
		</div>
	);
}

export function BikViewer({ model, raw }: BikViewerProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	// Video driver state (refs are mutated by the rAF loop; React state mirrors
	// only what the UI renders).
	const decRef = useRef<BinkVideo | null>(null);
	const imageDataRef = useRef<ImageData | null>(null);
	const playingRef = useRef(false);
	const loopRef = useRef(true);
	const clockRef = useRef<{ t0: number; f0: number } | null>(null);
	const targetRef = useRef(0);
	const lastDrawnRef = useRef(-1);

	// Audio state.
	const audioPcmRef = useRef<DecodedAudio | null>(null);
	const audioCtxRef = useRef<AudioContext | null>(null);
	const audioBufRef = useRef<AudioBuffer | null>(null);
	const audioSrcRef = useRef<AudioBufferSourceNode | null>(null);
	const gainRef = useRef<GainNode | null>(null);
	const mutedRef = useRef(false);

	const [buildError, setBuildError] = useState<string | null>(null);
	const [playing, setPlaying] = useState(false);
	const [loop, setLoop] = useState(true);
	const [muted, setMuted] = useState(false);
	const [displayFrame, setDisplayFrame] = useState(0);
	const [busy, setBusy] = useState(false);
	const [audioReady, setAudioReady] = useState(false);

	const frameCount = model?.numFrames ?? 0;
	const fps = model?.fps && model.fps > 0 ? model.fps : 30;
	const hasAudioTrack = (model?.numAudioTracks ?? 0) > 0;

	// --- Audio helpers (operate on refs so the rAF loop / handlers can call them).
	const stopAudio = () => {
		const src = audioSrcRef.current;
		if (src) {
			try {
				src.onended = null;
				src.stop();
				src.disconnect();
			} catch {
				/* already stopped */
			}
			audioSrcRef.current = null;
		}
	};

	const ensureAudioGraph = () => {
		if (!audioCtxRef.current) {
			const Ctx =
				window.AudioContext ||
				(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			if (!Ctx) return;
			const ctx = new Ctx();
			const gain = ctx.createGain();
			gain.gain.value = mutedRef.current ? 0 : 1;
			gain.connect(ctx.destination);
			audioCtxRef.current = ctx;
			gainRef.current = gain;
		}
		// Build the AudioBuffer from the decoded PCM once.
		if (!audioBufRef.current && audioPcmRef.current) {
			const { pcm, sampleRate, channels } = audioPcmRef.current;
			const frames = Math.floor(pcm.length / channels);
			if (frames > 0) {
				const ctx = audioCtxRef.current;
				const buf = ctx.createBuffer(channels, frames, sampleRate);
				for (let ch = 0; ch < channels; ch++) {
					const data = buf.getChannelData(ch);
					for (let i = 0; i < frames; i++) data[i] = pcm[i * channels + ch] / 32768;
				}
				audioBufRef.current = buf;
			}
		}
	};

	const startAudioAt = (offsetSec: number) => {
		stopAudio();
		ensureAudioGraph();
		const ctx = audioCtxRef.current;
		const buf = audioBufRef.current;
		const gain = gainRef.current;
		if (!ctx || !buf || !gain) return;
		void ctx.resume();
		const src = ctx.createBufferSource();
		src.buffer = buf;
		src.loop = loopRef.current;
		src.connect(gain);
		const off = buf.duration > 0 ? offsetSec % buf.duration : 0;
		src.start(0, Math.max(0, off));
		audioSrcRef.current = src;
	};

	// (Re)build the decoders when the bytes change.
	useEffect(() => {
		decRef.current = null;
		imageDataRef.current = null;
		playingRef.current = false;
		clockRef.current = null;
		targetRef.current = 0;
		lastDrawnRef.current = -1;
		stopAudio();
		audioPcmRef.current = null;
		audioBufRef.current = null;
		setPlaying(false);
		setBusy(false);
		setDisplayFrame(0);
		setBuildError(null);
		setAudioReady(false);

		if (!raw || !model || model.isBink2) return;

		try {
			const dec = new BinkVideo(raw);
			decRef.current = dec;
			if (dec.frameCount > 0) dec.decodeFrame(0);
		} catch (err) {
			setBuildError(String((err as Error)?.message ?? err));
			return;
		}

		// Decode audio off the first paint so the poster shows immediately.
		let cancelled = false;
		if ((model.numAudioTracks ?? 0) > 0) {
			const t = setTimeout(() => {
				if (cancelled) return;
				try {
					const ba = new BinkAudio(raw, 0);
					const decoded = ba.decodeAll();
					if (cancelled) return;
					audioPcmRef.current = decoded;
					setAudioReady(true);
					// If the user already hit play, join in at the current position.
					if (playingRef.current) startAudioAt((decRef.current?.currentFrame ?? 0) / fps);
				} catch {
					/* audio decode failed — play video silently */
				}
			}, 0);
			return () => {
				cancelled = true;
				clearTimeout(t);
			};
		}
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [raw, model]);

	// Stop audio whenever playback stops (pause, seek, or natural end).
	useEffect(() => {
		if (!playing) stopAudio();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [playing]);

	// Tear down the audio context on unmount.
	useEffect(() => {
		return () => {
			stopAudio();
			const ctx = audioCtxRef.current;
			if (ctx) void ctx.close();
			audioCtxRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// The persistent decode + playback driver.
	useEffect(() => {
		let rafId = 0;

		const draw = (dec: BinkVideo) => {
			const canvas = canvasRef.current;
			if (!canvas) return;
			const ctx = canvas.getContext('2d');
			if (!ctx) return;
			let img = imageDataRef.current;
			if (!img || img.width !== dec.width || img.height !== dec.height) {
				img = ctx.createImageData(dec.width, dec.height);
				imageDataRef.current = img;
			}
			img.data.set(dec.rgba);
			ctx.putImageData(img, 0, 0);
		};

		const tick = (now: number) => {
			const dec = decRef.current;
			if (dec) {
				let want: number;
				if (playingRef.current && dec.frameCount > 0) {
					if (!clockRef.current) clockRef.current = { t0: now, f0: Math.max(0, dec.currentFrame) };
					const { t0, f0 } = clockRef.current;
					const rate = dec.fpsDen ? dec.fpsNum / dec.fpsDen : 30;
					want = f0 + Math.floor(((now - t0) / 1000) * rate);
					if (want >= dec.frameCount) {
						if (loopRef.current) {
							clockRef.current = { t0: now, f0: 0 };
							want = 0;
						} else {
							want = dec.frameCount - 1;
							playingRef.current = false;
							setPlaying(false);
							clockRef.current = null;
						}
					}
				} else {
					want = targetRef.current;
				}

				if (want < dec.currentFrame) dec.reset();

				const budgetEnd = performance.now() + DECODE_BUDGET_MS;
				let decoded = false;
				while (dec.currentFrame < want && performance.now() < budgetEnd) {
					dec.decodeFrame(dec.currentFrame + 1);
					decoded = true;
				}
				if (dec.currentFrame < 0 && dec.frameCount > 0) {
					dec.decodeFrame(0);
					decoded = true;
				}

				const stillCatchingUp = dec.currentFrame < want;
				setBusy((b) => (b !== stillCatchingUp ? stillCatchingUp : b));

				if (decoded || dec.currentFrame !== lastDrawnRef.current) {
					if (dec.currentFrame >= 0) {
						draw(dec);
						lastDrawnRef.current = dec.currentFrame;
						setDisplayFrame((f) => (f !== dec.currentFrame ? dec.currentFrame : f));
					}
				}
			}
			rafId = requestAnimationFrame(tick);
		};

		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
	}, []);

	// --- Fallback states -----------------------------------------------------

	if (!model) {
		return (
			<EmptyState
				title="No Bink header"
				detail="This resource did not parse as a .bik movie. The Hex fallback shows the raw bytes."
			/>
		);
	}
	if (model.isBink2) {
		return (
			<EmptyState
				title={`Bink 2 (${model.fourCC}) not supported`}
				detail="This decoder handles Bink 1 (BIKf/g/h/i). Split/Second's movies are all BIKi, so this is unexpected — the Hex fallback shows the raw bytes."
			/>
		);
	}
	if (buildError) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-destructive">
				<AlertTriangle className="h-6 w-6" />
				<p className="text-sm font-medium">Bink decode failed</p>
				<p className="max-w-md text-xs">{buildError}</p>
			</div>
		);
	}

	const togglePlay = () => {
		const dec = decRef.current;
		if (!dec) return;
		const next = !playingRef.current;
		playingRef.current = next;
		if (next && dec.currentFrame >= frameCount - 1) {
			targetRef.current = 0;
			dec.reset();
		}
		clockRef.current = null;
		if (next) {
			ensureAudioGraph();
			if (audioPcmRef.current) startAudioAt(Math.max(0, dec.currentFrame) / fps);
		} else {
			stopAudio();
		}
		setPlaying(next);
	};

	const seekTo = (frame: number) => {
		const f = Math.max(0, Math.min(frameCount - 1, frame));
		playingRef.current = false;
		clockRef.current = null;
		targetRef.current = f;
		stopAudio();
		setPlaying(false);
		setDisplayFrame(f);
	};

	const toggleLoop = () => {
		const next = !loopRef.current;
		loopRef.current = next;
		if (audioSrcRef.current) audioSrcRef.current.loop = next;
		setLoop(next);
	};

	const toggleMute = () => {
		const next = !mutedRef.current;
		mutedRef.current = next;
		if (gainRef.current) gainRef.current.gain.value = next ? 0 : 1;
		// If unmuting mid-playback and audio isn't running yet, start it.
		if (!next && playingRef.current && audioPcmRef.current && !audioSrcRef.current) {
			startAudioAt(Math.max(0, decRef.current?.currentFrame ?? 0) / fps);
		}
		setMuted(next);
	};

	const durationSec = frameCount / fps;
	const currentSec = displayFrame / fps;

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
				<span className="text-xs font-semibold uppercase tracking-wide text-accent">Bink Video</span>
				<span className="font-mono text-xs text-muted-foreground">
					{model.width}&times;{model.height}
				</span>
				<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{model.fourCC}</span>
				<span className="font-mono text-xs text-muted-foreground">{formatBikFps(model)} fps</span>
				<span className="font-mono text-xs text-muted-foreground">
					{model.numFrames} frame{model.numFrames === 1 ? '' : 's'}
				</span>
				<span
					className="rounded bg-accent/20 px-1.5 py-0.5 font-mono text-xs text-accent"
					title="Decoded by a pure-TypeScript Bink decoder — no ffmpeg, no transcoding"
				>
					in-browser decode
				</span>
				<span
					className="font-mono text-xs text-muted-foreground"
					title={
						hasAudioTrack
							? `${model.numAudioTracks} embedded Bink audio track(s) — decoded in-browser`
							: 'No embedded audio'
					}
				>
					{hasAudioTrack ? (audioReady ? '🔊 audio' : 'decoding audio…') : 'silent'}
				</span>
			</div>

			{/* Canvas */}
			<div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#0a0a0a] p-3">
				<canvas
					ref={canvasRef}
					width={model.width}
					height={model.height}
					className="max-h-full max-w-full shadow-glow"
					style={{ objectFit: 'contain', imageRendering: 'auto' }}
				/>
				{busy && (
					<div className="absolute bottom-3 right-3 rounded bg-black/60 px-2 py-1 font-mono text-xs text-white">
						decoding…
					</div>
				)}
			</div>

			{/* Transport */}
			<div className="flex items-center gap-3 border-t border-border px-3 py-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 w-8 px-0"
					onClick={togglePlay}
					title={playing ? 'Pause' : 'Play'}
				>
					{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 w-8 px-0"
					onClick={() => seekTo(0)}
					title="Restart"
				>
					<RotateCcw className="h-4 w-4" />
				</Button>

				<span className="shrink-0 font-mono text-xs text-muted-foreground">
					{fmtTime(currentSec)} / {fmtTime(durationSec)}
				</span>

				<input
					type="range"
					min={0}
					max={Math.max(0, frameCount - 1)}
					value={displayFrame}
					onChange={(e) => seekTo(Number(e.target.value))}
					className="h-1 flex-1 cursor-pointer accent-accent"
					title="Seek"
				/>

				<span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
					{displayFrame + 1}/{frameCount}
				</span>

				<Separator orientation="vertical" className="h-5" />

				{hasAudioTrack && (
					<Button
						variant={muted ? 'outline' : 'default'}
						size="sm"
						className="h-8 w-8 px-0"
						onClick={toggleMute}
						title={muted ? 'Unmute' : 'Mute'}
						disabled={!audioReady}
					>
						{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
					</Button>
				)}

				<Button
					variant={loop ? 'default' : 'outline'}
					size="sm"
					className="h-8 w-8 px-0"
					onClick={toggleLoop}
					title={loop ? 'Looping' : 'Loop off'}
				>
					<Repeat className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}

export default BikViewer;
