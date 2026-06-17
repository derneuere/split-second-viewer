// .params parser/writer — Black Rock's plaintext tuning grammar.
//
// Pure module: imports nothing (text format), NEVER the registry (acyclic rule,
// see registry/handler.ts). Returns a JSON-serializable tree of groups/keys.
//
// GRAMMAR (verified against the devkit, e.g. AreaOfEffects/GlobalParams.params):
//
//   !directory: /AreaOfEffects/GlobalParameters        ← directory header line
//                                                       ← blank line
//   /AreaOfEffects/GlobalParameters:                   ← section header (ends ':')
//   <TAB>'a; Min Car Distance Factor' = 0.75 (0.0, 1.0);   ← key = value (min,max);
//   <TAB>SubjectID = 0;                                ← unquoted key, no range
//   <TAB>'u; disable_danger_zone' = false;             ← bool value, no range
//   <TAB>'b;Forced Effect Type' = 'On Opponent';       ← quoted-string value
//
// A single file may carry SEVERAL `!directory:` blocks (e.g. Cameras.params),
// each followed by its own section + entries.
//
// BYTE-EXACT ROUND-TRIP (the headline requirement of this writer)
// ---------------------------------------------------------------
// Earlier this writer rebuilt the file from the structured tree and normalised
// whitespace / blank lines / line endings — that is NOT byte-exact. The real
// data is far too irregular for a structural rebuild: across 727 devkit files
// we see CRLF (609), bare-LF (117) and one MIXED file (181 LF + a single CRLF
// blank line), 13 files with NO trailing newline, 62 files with consecutive
// blank lines, keys that contain `==` ('… when Skill == 0'), and values laden
// with colons + ESCAPED quotes (':f; Edge Render Tone:color:\'…_r\' …').
//
// So the parser keeps a verbatim LINE MODEL — one record per physical line,
// storing the exact text and the exact terminator (`\r\n` / `\n` / `\r` / '').
// The writer re-emits each line's bytes unchanged, splicing in ONLY the value
// substring of entries the caller actually edited (entry.dirty). Unmodified
// docs therefore round-trip byte-for-byte by construction; an edit touches only
// the value's column span and leaves every surrounding byte (indent, key,
// spacing, the `;`, the EOL) intact.

export type ParamValueKind = 'bool' | 'number' | 'string' | 'unknown';

export type ParamRange = { min: number; max: number };

/**
 * One physical line of the source: the verbatim text (without its terminator)
 * and the verbatim terminator. `text + eol` reproduces the original bytes.
 */
export type ParamLine = {
	/** Line text with the terminator stripped (may be '' for a blank line). */
	text: string;
	/** Verbatim terminator: '\r\n', '\n', '\r', or '' for a final unterminated line. */
	eol: string;
};

export type ParamEntry = {
	/** Key text as written, with surrounding quotes stripped if it was quoted. */
	key: string;
	/** True if the key was wrapped in single quotes in the source. */
	keyQuoted: boolean;
	/** Verbatim value text between '=' and the trailing ';' (untrimmed inner). */
	rawValue: string;
	/** Best-effort decoded kind of the value. */
	kind: ParamValueKind;
	/** Decoded value when kind is bool/number/string; null for unknown. */
	value: boolean | number | string | null;
	/** Optional (min, max) range that followed a numeric value. */
	range?: ParamRange;
	/**
	 * 0-based index into ParsedParams.lines for the physical line this entry lives
	 * on (also the source line number for diagnostics/inspectors).
	 */
	line: number;
	/** Column where rawValue begins in the source line (inclusive). */
	valueStart: number;
	/** Column where rawValue ends in the source line (exclusive). */
	valueEnd: number;
	/**
	 * Set true by an editor to make the writer re-render this entry's value from
	 * `rawValue` into its source line. Untouched entries are emitted verbatim.
	 */
	dirty?: boolean;
};

export type ParamSection = {
	/** Section header text without the trailing ':'. */
	name: string;
	entries: ParamEntry[];
	/** 0-based index into ParsedParams.lines for the section-header line. */
	line: number;
};

export type ParamGroup = {
	/** Path from the `!directory:` header (text after the colon, trimmed). */
	directory: string;
	sections: ParamSection[];
	/** 0-based index into ParsedParams.lines for the `!directory:` line. */
	line: number;
};

export type ParsedParams = {
	/**
	 * Verbatim line model — the writer's source of truth. Reproduces the file
	 * byte-for-byte (each line is text + eol).
	 */
	lines: ParamLine[];
	/** Structured view layered over `lines` for display / editing. */
	groups: ParamGroup[];
	/**
	 * Dominant line ending used by the source (informational; the writer uses the
	 * per-line `eol`, NOT this flag). 'crlf' | 'lf' | 'cr' | 'mixed'.
	 */
	lineEndings: 'crlf' | 'lf' | 'cr' | 'mixed' | 'none';
};

const DIRECTIVE = '!directory:';

/** Strip a single pair of surrounding single quotes, if present. */
function unquote(s: string): { text: string; quoted: boolean } {
	if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
		return { text: s.slice(1, -1), quoted: true };
	}
	return { text: s, quoted: false };
}

/**
 * Decode the verbatim value text into a typed value + optional range.
 * Faithful + tolerant: anything we cannot confidently classify stays 'unknown'
 * with value=null, while rawValue always preserves the original text.
 */
function decodeValue(raw: string): {
	kind: ParamValueKind;
	value: boolean | number | string | null;
	range?: ParamRange;
} {
	const trimmed = raw.trim();

	// Quoted string value, e.g.  'On Opponent'  (may itself contain colons and
	// escaped quotes). Keep it simple + faithful: strip first/last single quote.
	if (trimmed.startsWith("'")) {
		const last = trimmed.lastIndexOf("'");
		if (last > 0) {
			return { kind: 'string', value: trimmed.slice(1, last) };
		}
		return { kind: 'string', value: trimmed };
	}

	// Boolean.
	if (trimmed === 'true') return { kind: 'bool', value: true };
	if (trimmed === 'false') return { kind: 'bool', value: false };

	// Numeric, optionally followed by a "(min, max)" range.
	const m = /^(-?\d+(?:\.\d+)?)\s*(?:\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\))?$/.exec(
		trimmed,
	);
	if (m) {
		const value = Number(m[1]);
		if (m[2] !== undefined && m[3] !== undefined) {
			return { kind: 'number', value, range: { min: Number(m[2]), max: Number(m[3]) } };
		}
		return { kind: 'number', value };
	}

	return { kind: 'unknown', value: null };
}

/**
 * Split the source into a verbatim line model: each physical line with its exact
 * terminator preserved. Concatenating text+eol over every line reproduces the
 * input byte-for-byte (terminators: \r\n, \n, \r; the final line may have '').
 */
function splitLines(text: string): ParamLine[] {
	const lines: ParamLine[] = [];
	let i = 0;
	const n = text.length;
	let start = 0;
	while (i < n) {
		const c = text.charCodeAt(i);
		if (c === 0x0d /* \r */) {
			if (i + 1 < n && text.charCodeAt(i + 1) === 0x0a /* \n */) {
				lines.push({ text: text.slice(start, i), eol: '\r\n' });
				i += 2;
			} else {
				lines.push({ text: text.slice(start, i), eol: '\r' });
				i += 1;
			}
			start = i;
		} else if (c === 0x0a /* \n */) {
			lines.push({ text: text.slice(start, i), eol: '\n' });
			i += 1;
			start = i;
		} else {
			i += 1;
		}
	}
	// Trailing content after the last terminator (a final unterminated line). We
	// only emit it when non-empty so that a file ending in a terminator does NOT
	// gain a spurious empty record (which would still round-trip, but keeps the
	// model tidy and the line count matching the human view).
	if (start < n) {
		lines.push({ text: text.slice(start), eol: '' });
	}
	return lines;
}

/** Classify the dominant line ending for diagnostics. */
function classifyEndings(lines: ParamLine[]): ParsedParams['lineEndings'] {
	let crlf = 0;
	let lf = 0;
	let cr = 0;
	for (const l of lines) {
		if (l.eol === '\r\n') crlf++;
		else if (l.eol === '\n') lf++;
		else if (l.eol === '\r') cr++;
	}
	const kinds = [crlf, lf, cr].filter((x) => x > 0).length;
	if (kinds === 0) return 'none';
	if (kinds > 1) return 'mixed';
	if (crlf) return 'crlf';
	if (lf) return 'lf';
	return 'cr';
}

/**
 * Locate the `=` that separates key from value, respecting a quoted key.
 * A quoted key may contain `=` (e.g. '… when Skill == 0'); we skip past its
 * closing quote (honouring `\'` escapes) before searching. Returns -1 if no
 * usable separator is found.
 */
function findEquals(line: string): number {
	let i = 0;
	const n = line.length;
	// Skip leading whitespace.
	while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
	if (line[i] === "'") {
		// Quoted key: advance to the matching unescaped closing quote.
		i++;
		while (i < n) {
			if (line[i] === '\\' && i + 1 < n) {
				i += 2;
				continue;
			}
			if (line[i] === "'") {
				i++;
				break;
			}
			i++;
		}
	}
	// From here the first '=' is the separator.
	const eq = line.indexOf('=', i);
	return eq;
}

export function parseParams(raw: Uint8Array | string): ParsedParams {
	const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
	const lines = splitLines(text);

	const groups: ParamGroup[] = [];
	let group: ParamGroup | null = null;
	let section: ParamSection | null = null;

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i].text;
		const trimmed = rawLine.trim();
		if (trimmed === '') continue;

		// Directory header — opens a new group.
		if (trimmed.startsWith(DIRECTIVE)) {
			group = {
				directory: trimmed.slice(DIRECTIVE.length).trim(),
				sections: [],
				line: i,
			};
			groups.push(group);
			section = null;
			continue;
		}

		// Key/value entry: contains '=' (outside a quoted key) and ends with ';'.
		const eq = findEquals(rawLine);
		if (eq >= 0 && trimmed.endsWith(';')) {
			// Ensure a group + section exist even for malformed/headerless files.
			if (!group) {
				group = { directory: '', sections: [], line: i };
				groups.push(group);
			}
			if (!section) {
				section = { name: '', entries: [], line: i };
				group.sections.push(section);
			}
			const keyText = rawLine.slice(0, eq).trim();

			// Value spans from after '=' up to the LAST ';' on the line. We measure
			// the column span in the source so the writer can splice an edited value
			// without disturbing surrounding bytes. rawValue is the inner text with
			// the immediate single space after '=' and before ';' preserved as-is.
			const semi = rawLine.lastIndexOf(';');
			const valueRegionStart = eq + 1; // right after '='
			const valueRegionEnd = semi >= 0 ? semi : rawLine.length;
			// Trim leading/trailing whitespace of the value region for the typed
			// decode + rawValue, but remember the trimmed-off span so editing keeps
			// the original spacing (" = " before, " " before ";").
			let vs = valueRegionStart;
			let ve = valueRegionEnd;
			while (vs < ve && (rawLine[vs] === ' ' || rawLine[vs] === '\t')) vs++;
			while (ve > vs && (rawLine[ve - 1] === ' ' || rawLine[ve - 1] === '\t')) ve--;
			const valueText = rawLine.slice(vs, ve);

			const { text: key, quoted } = unquote(keyText);
			const decoded = decodeValue(valueText);
			section.entries.push({
				key,
				keyQuoted: quoted,
				rawValue: valueText,
				kind: decoded.kind,
				value: decoded.value,
				range: decoded.range,
				line: i,
				valueStart: vs,
				valueEnd: ve,
			});
			continue;
		}

		// Section header: ends with ':' and is not a directive.
		if (trimmed.endsWith(':')) {
			if (!group) {
				group = { directory: '', sections: [], line: i };
				groups.push(group);
			}
			section = { name: trimmed.slice(0, -1).trim(), entries: [], line: i };
			group.sections.push(section);
			continue;
		}

		// Anything else is unexpected; ignore it (tolerant parse) but keep going.
	}

	return { lines, groups, lineEndings: classifyEndings(lines) };
}

/**
 * Reserialize a parsed model back to .params bytes — BYTE-EXACT for unmodified
 * documents. The line model is the source of truth: each line is emitted as
 * `text + eol`. For entries flagged `dirty`, the new `rawValue` is spliced into
 * the value column span of that entry's line, leaving everything else untouched.
 */
export function writeParams(model: ParsedParams): Uint8Array {
	// Build a per-line list of edits (sorted by column, applied right-to-left so
	// earlier offsets stay valid). Most lines have zero edits.
	const editsByLine = new Map<number, ParamEntry[]>();
	for (const g of model.groups) {
		for (const s of g.sections) {
			for (const e of s.entries) {
				if (!e.dirty) continue;
				const arr = editsByLine.get(e.line);
				if (arr) arr.push(e);
				else editsByLine.set(e.line, [e]);
			}
		}
	}

	const out: string[] = [];
	for (let i = 0; i < model.lines.length; i++) {
		const line = model.lines[i];
		const edits = editsByLine.get(i);
		if (!edits || edits.length === 0) {
			out.push(line.text + line.eol);
			continue;
		}
		// Apply value splices right-to-left so earlier column offsets are stable.
		let text = line.text;
		edits.sort((a, b) => b.valueStart - a.valueStart);
		for (const e of edits) {
			text = text.slice(0, e.valueStart) + e.rawValue + text.slice(e.valueEnd);
		}
		out.push(text + line.eol);
	}
	return new TextEncoder().encode(out.join(''));
}

/** Count of key/value entries across all groups/sections. */
export function countParamEntries(model: ParsedParams): number {
	let n = 0;
	for (const g of model.groups) for (const s of g.sections) n += s.entries.length;
	return n;
}
