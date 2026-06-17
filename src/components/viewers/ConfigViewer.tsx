// ConfigViewer — Standard-family inspector for Split/Second's config /
// physics / shader resources.
//
// Props contract (the Integrate stage wires this into the central viewport
// dispatcher; the viewer NEVER touches that dispatcher itself):
//
//   { model, raw, handler }
//
//     model   — the parsed resource model produced by handler.parseRaw(). May
//               be null/undefined when parsing failed: the viewer renders a
//               graceful message and the Hex fallback still covers the bytes.
//     raw     — the original (already inflated) bytes. Used only for size /
//               diagnostics here; the Hex fallback owns byte inspection.
//     handler — the ResourceHandler that produced the model. Its describe()
//               one-liner and category/name drive the header + the generic
//               key/value table for formats this viewer has no bespoke layout
//               for (physics packfiles, shader sets, etc.).
//
// The viewer renders three model shapes, auto-detected (it does NOT depend on a
// specific handler.category string, so it survives the registry's category
// vocabulary changing):
//
//   1. .params  — ParsedParams { groups[] -> sections[] -> entries[] }. A
//                 collapsible group/section tree; each entry shows key, decoded
//                 value, and its (min,max) range. Large sections are windowed
//                 with @tanstack/react-virtual.
//   2. XML      — ParsedXml { root } (.xml/.powerplays/.triggers). A recursive,
//                 collapsible element tree with attributes + inline text.
//   3. generic  — anything else (physics/shader/names/globalRegs/dct/...). A
//                 best-effort key/value table flattened from the model, headed
//                 by the handler's describe() summary.
//
// Imports are limited to deps already in package.json: React, lucide-react,
// @tanstack/react-virtual, and the existing shadcn primitives (scroll-area,
// separator, button). shadcn has no Accordion component installed and
// @radix-ui/react-accordion is not a dependency, so this file ships a tiny
// self-contained <Collapsible> built on React state — same affordance, zero
// new deps.

import * as React from 'react';
import {
	ChevronRight,
	FolderTree,
	FileCode2,
	Table2,
	AlertTriangle,
	Hash,
	Type as TypeIcon,
	ToggleLeft,
	Braces,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

import type { ParsedParams, ParamSection, ParamEntry } from '@/lib/core/params';
import type { ParsedXml, XmlNode } from '@/lib/core/xmlResource';
import type { ResourceHandler } from '@/lib/core/registry/handler';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ConfigViewerProps = {
	/** Parsed model from handler.parseRaw(); null/undefined when parse failed. */
	model: unknown;
	/** Original (inflated) bytes — used for the size readout only. */
	raw?: Uint8Array | null;
	/** The handler that produced `model` (drives header + generic describe()). */
	handler?: ResourceHandler | null;
};

// ---------------------------------------------------------------------------
// Shape detection (structural — independent of handler.category)
// ---------------------------------------------------------------------------

function isParsedParams(m: unknown): m is ParsedParams {
	return (
		!!m &&
		typeof m === 'object' &&
		Array.isArray((m as ParsedParams).groups) &&
		// distinguish from generic objects that happen to carry a `groups` array
		(m as ParsedParams).groups.every(
			(g) => g && typeof g === 'object' && Array.isArray((g as { sections?: unknown }).sections),
		)
	);
}

function isParsedXml(m: unknown): m is ParsedXml {
	return (
		!!m &&
		typeof m === 'object' &&
		'root' in (m as object) &&
		'source' in (m as object) &&
		typeof (m as ParsedXml).source === 'string'
	);
}

// ---------------------------------------------------------------------------
// Tiny self-contained collapsible (no @radix-ui/react-accordion dependency)
// ---------------------------------------------------------------------------

type CollapsibleProps = {
	title: React.ReactNode;
	subtitle?: React.ReactNode;
	icon?: React.ReactNode;
	defaultOpen?: boolean;
	/** Visual nesting depth (adds left indentation to the header). */
	depth?: number;
	children: React.ReactNode;
};

function Collapsible({
	title,
	subtitle,
	icon,
	defaultOpen = false,
	depth = 0,
	children,
}: CollapsibleProps) {
	const [open, setOpen] = React.useState(defaultOpen);
	return (
		<div className="border-b border-border/60 last:border-b-0">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className={cn(
					'flex w-full items-center gap-2 py-1.5 pr-2 text-left text-sm',
					'transition-colors hover:bg-accent/10 focus-visible:outline-none',
					'focus-visible:ring-1 focus-visible:ring-ring',
				)}
				style={{ paddingLeft: 8 + depth * 14 }}
			>
				<ChevronRight
					className={cn(
						'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
						open && 'rotate-90',
					)}
				/>
				{icon}
				<span className="truncate font-medium">{title}</span>
				{subtitle != null && (
					<span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
						{subtitle}
					</span>
				)}
			</button>
			{open && <div className="pb-1">{children}</div>}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Shared header
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function ViewerHeader({
	handler,
	raw,
	summary,
	shape,
}: {
	handler?: ResourceHandler | null;
	raw?: Uint8Array | null;
	summary?: string | null;
	shape: string;
}) {
	return (
		<div className="space-y-1 px-3 py-2">
			<div className="flex items-baseline gap-2">
				<h3 className="text-sm font-semibold">{handler?.name ?? 'Config Resource'}</h3>
				{handler?.key && (
					<code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
						{handler.key}
					</code>
				)}
				<span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
					{handler?.category && <span>{handler.category}</span>}
					<span className="rounded bg-muted px-1.5 py-0.5">{shape}</span>
					{raw && <span>{formatBytes(raw.byteLength)}</span>}
				</span>
			</div>
			{summary && (
				<p className="font-mono text-xs leading-relaxed text-muted-foreground">{summary}</p>
			)}
		</div>
	);
}

/** Compute the handler's one-line describe() defensively (never throws). */
function safeDescribe(handler: ResourceHandler | null | undefined, model: unknown): string | null {
	if (!handler || model == null) return null;
	try {
		return handler.describe(model as never);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// 1. .params view
// ---------------------------------------------------------------------------

const KIND_ICON: Record<string, React.ReactNode> = {
	number: <Hash className="h-3 w-3 text-sky-500" />,
	bool: <ToggleLeft className="h-3 w-3 text-amber-500" />,
	string: <TypeIcon className="h-3 w-3 text-emerald-500" />,
	unknown: <Braces className="h-3 w-3 text-muted-foreground" />,
};

function formatParamValue(e: ParamEntry): string {
	if (e.kind === 'string' && typeof e.value === 'string') return `"${e.value}"`;
	if (e.value === null || e.value === undefined) return e.rawValue || '(unknown)';
	return String(e.value);
}

/** A single param entry row: key · value · (min,max). */
function ParamRow({ entry, style }: { entry: ParamEntry; style?: React.CSSProperties }) {
	return (
		<div
			style={style}
			className="flex items-center gap-2 px-3 py-1 font-mono text-xs odd:bg-muted/30"
			title={`line ${entry.line + 1} · raw: ${entry.rawValue}`}
		>
			<span className="shrink-0">{KIND_ICON[entry.kind] ?? KIND_ICON.unknown}</span>
			<span className="min-w-0 flex-1 truncate text-foreground">{entry.key}</span>
			<span
				className={cn(
					'shrink-0 tabular-nums',
					entry.kind === 'string' ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400',
				)}
			>
				{formatParamValue(entry)}
			</span>
			{entry.range && (
				<span className="shrink-0 text-muted-foreground">
					({entry.range.min}, {entry.range.max})
				</span>
			)}
		</div>
	);
}

/** Virtualized entry list — only mounts the visible rows for big sections. */
const VIRTUALIZE_THRESHOLD = 60;
const ROW_HEIGHT = 26;

function VirtualParamRows({ entries }: { entries: ParamEntry[] }) {
	const parentRef = React.useRef<HTMLDivElement>(null);
	const rowVirtualizer = useVirtualizer({
		count: entries.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 12,
	});
	const visibleHeight = Math.min(entries.length, 14) * ROW_HEIGHT;
	return (
		<div
			ref={parentRef}
			className="overflow-auto"
			style={{ height: visibleHeight, maxHeight: 360 }}
		>
			<div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
				{rowVirtualizer.getVirtualItems().map((vi) => (
					<ParamRow
						key={vi.key}
						entry={entries[vi.index]}
						style={{
							position: 'absolute',
							top: 0,
							left: 0,
							width: '100%',
							height: vi.size,
							transform: `translateY(${vi.start}px)`,
						}}
					/>
				))}
			</div>
		</div>
	);
}

function ParamSectionBlock({ section, depth }: { section: ParamSection; depth: number }) {
	const count = section.entries.length;
	return (
		<Collapsible
			depth={depth}
			defaultOpen={count > 0 && count <= VIRTUALIZE_THRESHOLD}
			icon={<Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
			title={section.name || '(unnamed section)'}
			subtitle={`${count} ${count === 1 ? 'entry' : 'entries'}`}
		>
			{count === 0 ? (
				<p className="px-3 py-1 text-xs italic text-muted-foreground" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
					(empty)
				</p>
			) : count > VIRTUALIZE_THRESHOLD ? (
				<VirtualParamRows entries={section.entries} />
			) : (
				section.entries.map((e, i) => <ParamRow key={`${e.key}:${e.line}:${i}`} entry={e} />)
			)}
		</Collapsible>
	);
}

function ParamsView({ model }: { model: ParsedParams }) {
	if (model.groups.length === 0) {
		return <EmptyState message="No parameter groups in this file." />;
	}
	return (
		<div>
			{model.groups.map((g, gi) => {
				const sectionCount = g.sections.length;
				const entryCount = g.sections.reduce((n, s) => n + s.entries.length, 0);
				return (
					<Collapsible
						key={`${g.directory}:${g.line}:${gi}`}
						depth={0}
						defaultOpen={model.groups.length <= 2}
						icon={<FolderTree className="h-4 w-4 shrink-0 text-primary" />}
						title={g.directory || '(no directory header)'}
						subtitle={`${sectionCount} sect · ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}`}
					>
						{sectionCount === 0 ? (
							<p className="px-3 py-1 text-xs italic text-muted-foreground" style={{ paddingLeft: 22 }}>
								(no sections)
							</p>
						) : (
							g.sections.map((s, si) => (
								<ParamSectionBlock key={`${s.name}:${s.line}:${si}`} section={s} depth={1} />
							))
						)}
					</Collapsible>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 2. XML view (recursive element tree)
// ---------------------------------------------------------------------------

function XmlAttrs({ attrs }: { attrs: Record<string, string> }) {
	const keys = Object.keys(attrs);
	if (keys.length === 0) return null;
	return (
		<span className="ml-1 inline-flex flex-wrap gap-x-2 font-mono text-[11px]">
			{keys.map((k) => (
				<span key={k} className="text-muted-foreground">
					<span className="text-violet-500">{k}</span>
					<span>=</span>
					<span className="text-emerald-600 dark:text-emerald-400">"{attrs[k]}"</span>
				</span>
			))}
		</span>
	);
}

function XmlNodeView({ node, depth }: { node: XmlNode; depth: number }) {
	const hasChildren = node.children.length > 0;
	const attrCount = Object.keys(node.attrs).length;

	// Leaf node (no children) — render as a single non-collapsible row.
	if (!hasChildren) {
		return (
			<div
				className="flex items-baseline gap-1 py-1 pr-2 font-mono text-xs hover:bg-accent/10"
				style={{ paddingLeft: 8 + depth * 14 + 16 }}
			>
				<span className="font-medium text-sky-600 dark:text-sky-400">&lt;{node.tag}&gt;</span>
				<XmlAttrs attrs={node.attrs} />
				{node.text && (
					<span className="truncate text-foreground" title={node.text}>
						{node.text}
					</span>
				)}
			</div>
		);
	}

	return (
		<Collapsible
			depth={depth}
			defaultOpen={depth < 2}
			icon={<FileCode2 className="h-3.5 w-3.5 shrink-0 text-sky-500" />}
			title={<span className="font-mono">&lt;{node.tag}&gt;</span>}
			subtitle={
				<span className="space-x-2">
					{attrCount > 0 && <span>{attrCount} attr</span>}
					<span>{node.children.length} child</span>
				</span>
			}
		>
			{attrCount > 0 && (
				<div
					className="py-0.5 font-mono text-[11px]"
					style={{ paddingLeft: 8 + (depth + 1) * 14 + 16 }}
				>
					<XmlAttrs attrs={node.attrs} />
				</div>
			)}
			{node.text && (
				<div
					className="truncate py-0.5 font-mono text-xs text-foreground"
					style={{ paddingLeft: 8 + (depth + 1) * 14 + 16 }}
					title={node.text}
				>
					{node.text}
				</div>
			)}
			{node.children.map((c, i) => (
				<XmlNodeView key={`${c.tag}:${i}`} node={c} depth={depth + 1} />
			))}
		</Collapsible>
	);
}

function XmlView({ model }: { model: ParsedXml }) {
	if (!model.root) {
		return <EmptyState message="No XML root element (empty or unparseable document)." />;
	}
	return (
		<div>
			{model.declaration && (
				<p className="px-3 py-1 font-mono text-[11px] text-muted-foreground">{model.declaration}</p>
			)}
			<XmlNodeView node={model.root} depth={0} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// 3. Generic key/value table (physics / shader / names / globalRegs / ...)
// ---------------------------------------------------------------------------

type KV = { key: string; value: string; kind: 'scalar' | 'array' | 'object' | 'bytes' };

/** Flatten a model into a flat list of displayable rows (one level deep, with
 *  array/object items summarized). Faithful + tolerant: never throws. */
function flattenModel(model: Record<string, unknown>): KV[] {
	const rows: KV[] = [];
	for (const [key, v] of Object.entries(model)) {
		if (v == null) {
			rows.push({ key, value: String(v), kind: 'scalar' });
		} else if (v instanceof Uint8Array) {
			rows.push({ key, value: `Uint8Array(${v.byteLength} bytes)`, kind: 'bytes' });
		} else if (Array.isArray(v)) {
			rows.push({ key, value: summarizeArray(v), kind: 'array' });
		} else if (typeof v === 'object') {
			rows.push({ key, value: summarizeObject(v as Record<string, unknown>), kind: 'object' });
		} else if (typeof v === 'number') {
			// Show large round numbers in hex too (CRCs / tags read better that way).
			const hex =
				Number.isInteger(v) && v >= 0 && v > 0xffff
					? ` (0x${(v >>> 0).toString(16).padStart(8, '0')})`
					: '';
			rows.push({ key, value: `${v}${hex}`, kind: 'scalar' });
		} else {
			rows.push({ key, value: String(v), kind: 'scalar' });
		}
	}
	return rows;
}

function summarizeArray(a: unknown[]): string {
	if (a.length === 0) return '[] (0 items)';
	const sample = a
		.slice(0, 6)
		.map((x) => (typeof x === 'object' && x != null ? summarizeObject(x as Record<string, unknown>, 2) : String(x)))
		.join(', ');
	return `[${sample}${a.length > 6 ? ', …' : ''}] (${a.length} items)`;
}

function summarizeObject(o: Record<string, unknown>, maxKeys = 4): string {
	const keys = Object.keys(o);
	const head = keys
		.slice(0, maxKeys)
		.map((k) => {
			const val = o[k];
			if (val == null) return `${k}: ${val}`;
			if (Array.isArray(val)) return `${k}: [${val.length}]`;
			if (val instanceof Uint8Array) return `${k}: <${val.byteLength}B>`;
			if (typeof val === 'object') return `${k}: {…}`;
			return `${k}: ${val}`;
		})
		.join(', ');
	return `{ ${head}${keys.length > maxKeys ? ', …' : ''} }`;
}

const KV_KIND_BADGE: Record<KV['kind'], string> = {
	scalar: 'text-sky-600 dark:text-sky-400',
	array: 'text-amber-600 dark:text-amber-400',
	object: 'text-violet-600 dark:text-violet-400',
	bytes: 'text-muted-foreground',
};

function GenericTable({ model }: { model: unknown }) {
	const rows = React.useMemo<KV[]>(() => {
		if (model == null || typeof model !== 'object') {
			return [{ key: '(value)', value: String(model), kind: 'scalar' }];
		}
		try {
			return flattenModel(model as Record<string, unknown>);
		} catch {
			return [];
		}
	}, [model]);

	if (rows.length === 0) {
		return <EmptyState message="Nothing to display for this model." />;
	}

	return (
		<div className="font-mono text-xs">
			<div className="flex border-b border-border/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
				<span className="w-1/3">Field</span>
				<span className="flex-1">Value</span>
			</div>
			{rows.map((r, i) => (
				<div
					key={`${r.key}:${i}`}
					className="flex items-start gap-3 px-3 py-1 odd:bg-muted/30"
				>
					<span className="w-1/3 shrink-0 truncate text-foreground" title={r.key}>
						{r.key}
					</span>
					<span className={cn('min-w-0 flex-1 break-words', KV_KIND_BADGE[r.kind])} title={r.value}>
						{r.value}
					</span>
				</div>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Empty / error states
// ---------------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
	return (
		<div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
			<AlertTriangle className="h-6 w-6 text-amber-500" />
			<p>{message}</p>
			<p className="text-xs">The Hex fallback still shows the raw bytes.</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

export function ConfigViewer({ model, raw, handler }: ConfigViewerProps) {
	const summary = safeDescribe(handler, model);

	let shape: string;
	let body: React.ReactNode;

	if (model == null) {
		shape = 'unparsed';
		body = (
			<EmptyState message="This resource could not be parsed (partial or unsupported model)." />
		);
	} else if (isParsedParams(model)) {
		shape = 'params';
		body = <ParamsView model={model} />;
	} else if (isParsedXml(model)) {
		shape = 'xml';
		body = <XmlView model={model} />;
	} else {
		shape = 'fields';
		body = <GenericTable model={model} />;
	}

	return (
		<div className="flex h-full flex-col">
			<ViewerHeader handler={handler} raw={raw} summary={summary} shape={shape} />
			<Separator />
			<ScrollArea className="flex-1">{body}</ScrollArea>
		</div>
	);
}

export default ConfigViewer;
