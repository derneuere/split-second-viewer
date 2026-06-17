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
// each followed by its own section + entries. Lines use CRLF on the devkit; we
// tolerate LF too.
//
// Value forms observed: bool (true/false), number (int/float, optional sign),
// and quoted strings 'like this'. An optional range `(min, max)` may follow a
// numeric value. Some pathological values contain escaped quotes and colons
// (CameraStyleConfig.params); to stay faithful we ALWAYS keep `rawValue` (the
// verbatim text between '=' and the terminating ';') and decode value/range on
// a best-effort basis, preferring fidelity over a clever-but-fragile regex.

export type ParamValueKind = 'bool' | 'number' | 'string' | 'unknown';

export type ParamRange = { min: number; max: number };

export type ParamEntry = {
	/** Key text as written, with surrounding quotes stripped if it was quoted. */
	key: string;
	/** True if the key was wrapped in single quotes in the source. */
	keyQuoted: boolean;
	/** Verbatim value text between '=' and the trailing ';' (trimmed). */
	rawValue: string;
	/** Best-effort decoded kind of the value. */
	kind: ParamValueKind;
	/** Decoded value when kind is bool/number/string; null for unknown. */
	value: boolean | number | string | null;
	/** Optional (min, max) range that followed a numeric value. */
	range?: ParamRange;
	/** 0-based line index in the source (for diagnostics / inspectors). */
	line: number;
};

export type ParamSection = {
	/** Section header text without the trailing ':'. */
	name: string;
	entries: ParamEntry[];
	line: number;
};

export type ParamGroup = {
	/** Path from the `!directory:` header (text after the colon, trimmed). */
	directory: string;
	sections: ParamSection[];
	line: number;
};

export type ParsedParams = {
	groups: ParamGroup[];
	/** True if the source used CRLF line endings (preserved by the writer). */
	crlf: boolean;
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

	// Quoted string value, e.g.  'On Opponent'  (may itself contain colons).
	if (trimmed.startsWith("'")) {
		// Take up to the last unescaped closing quote we can find; keep it simple
		// and faithful — strip the first and last single quote.
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

export function parseParams(raw: Uint8Array | string): ParsedParams {
	const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
	const crlf = text.includes('\r\n');
	const lines = text.split(/\r\n|\n|\r/);

	const groups: ParamGroup[] = [];
	let group: ParamGroup | null = null;
	let section: ParamSection | null = null;

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
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

		// Key/value entry: contains '=' and ends (after trim) with ';'.
		const eq = rawLine.indexOf('=');
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
			// Value is everything after '=' up to the trailing ';'.
			let valueText = rawLine.slice(eq + 1).trim();
			if (valueText.endsWith(';')) valueText = valueText.slice(0, -1).trim();
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

	return { groups, crlf };
}

/** Reserialize a parsed model back to the .params text grammar. */
export function writeParams(model: ParsedParams): Uint8Array {
	const nl = model.crlf ? '\r\n' : '\n';
	const out: string[] = [];
	for (const group of model.groups) {
		out.push(`${DIRECTIVE} ${group.directory}`);
		out.push('');
		for (const section of group.sections) {
			out.push(`${section.name}:`);
			for (const e of section.entries) {
				const key = e.keyQuoted ? `'${e.key}'` : e.key;
				out.push(`\t${key} = ${e.rawValue};`);
			}
		}
	}
	const text = out.join(nl) + nl;
	return new TextEncoder().encode(text);
}

/** Count of key/value entries across all groups/sections. */
export function countParamEntries(model: ParsedParams): number {
	let n = 0;
	for (const g of model.groups) for (const s of g.sections) n += s.entries.length;
	return n;
}
