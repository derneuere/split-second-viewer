// XML resource parser — shared by the .xml / .powerplays / .triggers handlers.
//
// Despite their binary-looking extensions, Split/Second's .powerplays and
// .triggers are plain UTF-8 XML (see wiki format-powerplays.html /
// format-triggers.html), exactly like the .xml config files. The brief says to
// use the browser DOMParser where available and a tiny Node-safe DOM walk
// otherwise — so this module hand-rolls a minimal, dependency-free XML reader
// that runs under Node (CLI + vitest) AND the browser. It produces a
// JSON-serializable element tree; round-trips are text-preserving by storing the
// original source.
//
// Pure module: imports nothing, NEVER the registry (acyclic rule).

export type XmlNode = {
	/** Tag name, e.g. 'Root', 'Powerplay', 'Trigger'. */
	tag: string;
	/** Attributes in source order, preserving original string values. */
	attrs: Record<string, string>;
	/** Child elements (text/comments are not retained as nodes). */
	children: XmlNode[];
	/** Concatenated text content directly inside this element, trimmed. */
	text?: string;
};

export type ParsedXml = {
	root: XmlNode | null;
	/** The XML declaration line if present, e.g. '<?xml version="1.0"?>'. */
	declaration?: string;
	/** Total element count (root included). */
	elementCount: number;
	/** Verbatim source text — the writer reproduces this byte-for-byte. */
	source: string;
};

// --- minimal scanner ---------------------------------------------------------

const NAME_CHARS = /[^\s/>=]/;

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

class XmlScanner {
	private i = 0;
	declaration?: string;
	elementCount = 0;

	constructor(private readonly src: string) {}

	parse(): XmlNode | null {
		this.skipProlog();
		const node = this.parseElement();
		return node;
	}

	private skipProlog() {
		// Skip leading whitespace, an optional <?xml ... ?> declaration, comments,
		// and DOCTYPE/processing instructions until the first real element.
		for (;;) {
			this.skipWs();
			if (this.src.startsWith('<?', this.i)) {
				const end = this.src.indexOf('?>', this.i);
				const stop = end < 0 ? this.src.length : end + 2;
				const text = this.src.slice(this.i, stop);
				if (/^<\?xml/i.test(text)) this.declaration = text;
				this.i = stop;
				continue;
			}
			if (this.src.startsWith('<!--', this.i)) {
				const end = this.src.indexOf('-->', this.i);
				this.i = end < 0 ? this.src.length : end + 3;
				continue;
			}
			if (this.src.startsWith('<!', this.i)) {
				const end = this.src.indexOf('>', this.i);
				this.i = end < 0 ? this.src.length : end + 1;
				continue;
			}
			break;
		}
	}

	private skipWs() {
		while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
	}

	private readName(): string {
		const start = this.i;
		while (this.i < this.src.length && NAME_CHARS.test(this.src[this.i])) this.i++;
		return this.src.slice(start, this.i);
	}

	private parseElement(): XmlNode | null {
		this.skipWs();
		if (this.src[this.i] !== '<') return null;
		this.i++; // consume '<'
		const tag = this.readName();
		if (!tag) return null;
		this.elementCount++;
		const attrs: Record<string, string> = {};

		// Attributes.
		for (;;) {
			this.skipWs();
			const c = this.src[this.i];
			if (c === undefined || c === '>' || c === '/') break;
			const name = this.readName();
			if (!name) {
				this.i++; // defensive: avoid infinite loop on malformed input
				continue;
			}
			this.skipWs();
			let value = '';
			if (this.src[this.i] === '=') {
				this.i++;
				this.skipWs();
				const q = this.src[this.i];
				if (q === '"' || q === "'") {
					this.i++;
					const start = this.i;
					while (this.i < this.src.length && this.src[this.i] !== q) this.i++;
					value = decodeEntities(this.src.slice(start, this.i));
					this.i++; // consume closing quote
				} else {
					const start = this.i;
					while (this.i < this.src.length && NAME_CHARS.test(this.src[this.i])) this.i++;
					value = decodeEntities(this.src.slice(start, this.i));
				}
			}
			attrs[name] = value;
		}

		// Self-closing?
		if (this.src[this.i] === '/') {
			this.i++; // '/'
			if (this.src[this.i] === '>') this.i++;
			return { tag, attrs, children: [] };
		}
		if (this.src[this.i] === '>') this.i++;

		// Children + text until the matching close tag.
		const children: XmlNode[] = [];
		let textBuf = '';
		for (;;) {
			if (this.i >= this.src.length) break;
			if (this.src.startsWith('</', this.i)) {
				this.i += 2;
				this.readName();
				const gt = this.src.indexOf('>', this.i);
				this.i = gt < 0 ? this.src.length : gt + 1;
				break;
			}
			if (this.src.startsWith('<!--', this.i)) {
				const end = this.src.indexOf('-->', this.i);
				this.i = end < 0 ? this.src.length : end + 3;
				continue;
			}
			if (this.src.startsWith('<![CDATA[', this.i)) {
				const end = this.src.indexOf(']]>', this.i);
				const stop = end < 0 ? this.src.length : end;
				textBuf += this.src.slice(this.i + 9, stop);
				this.i = end < 0 ? this.src.length : end + 3;
				continue;
			}
			if (this.src[this.i] === '<') {
				const child = this.parseElement();
				if (child) children.push(child);
				else this.i++; // defensive
				continue;
			}
			// Text run.
			const start = this.i;
			while (this.i < this.src.length && this.src[this.i] !== '<') this.i++;
			textBuf += this.src.slice(start, this.i);
		}

		const node: XmlNode = { tag, attrs, children };
		const text = decodeEntities(textBuf).trim();
		if (text) node.text = text;
		return node;
	}
}

export function parseXmlResource(raw: Uint8Array | string): ParsedXml {
	let source = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
	// Strip a UTF-8 BOM if present (devkit files have none, but be safe).
	if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
	const scanner = new XmlScanner(source);
	const root = scanner.parse();
	return {
		root,
		declaration: scanner.declaration,
		elementCount: scanner.elementCount,
		source,
	};
}

/** Text-preserving writer: emit the original source bytes verbatim. */
export function writeXmlResource(model: ParsedXml): Uint8Array {
	return new TextEncoder().encode(model.source);
}

/** Count direct + nested elements with a given tag name. */
export function countTag(node: XmlNode | null, tag: string): number {
	if (!node) return 0;
	let n = node.tag === tag ? 1 : 0;
	for (const c of node.children) n += countTag(c, tag);
	return n;
}
