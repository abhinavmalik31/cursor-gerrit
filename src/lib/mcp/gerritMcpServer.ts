/**
 * Standalone Gerrit MCP server using raw JSON-RPC over stdio.
 * Run as: node out/lib/mcp/gerritMcpServer.js
 *
 * Reads credentials from env vars:
 *   GERRIT_URL, GERRIT_USERNAME, GERRIT_PASSWORD,
 *   GERRIT_AUTH_COOKIE, GERRIT_AUTH_PREFIX
 *
 * Must NOT import anything from VSCode or extension
 * modules that depend on VSCode.
 */

import * as readline from 'readline';
import got from 'got/dist/source';

// ── Env config ──────────────────────────────────────

const GERRIT_URL = process.env.GERRIT_URL ?? '';
const GERRIT_USERNAME = process.env.GERRIT_USERNAME ?? '';
const GERRIT_PASSWORD = process.env.GERRIT_PASSWORD ?? '';
const GERRIT_AUTH_COOKIE = process.env.GERRIT_AUTH_COOKIE ?? '';
const GERRIT_AUTH_PREFIX = process.env.GERRIT_AUTH_PREFIX ?? 'a/';

const MAGIC_PREFIX = ")]}'";

// ── Gerrit HTTP client ──────────────────────────────

function gerritHeaders(withContent: boolean): Record<string, string> {
	const h: Record<string, string> = {};
	if (withContent) {
		h['Content-Type'] = 'application/json';
	}
	if (GERRIT_USERNAME && GERRIT_PASSWORD) {
		h['Authorization'] =
			'Basic ' +
			Buffer.from(`${GERRIT_USERNAME}:${GERRIT_PASSWORD}`).toString(
				'base64'
			);
	}
	return h;
}

function gerritUrl(path: string): string {
	const base = GERRIT_URL.endsWith('/') ? GERRIT_URL : GERRIT_URL + '/';
	return base + GERRIT_AUTH_PREFIX + path;
}

function stripMagic(body: string): string {
	if (body.startsWith(MAGIC_PREFIX)) {
		return body.slice(MAGIC_PREFIX.length).trim();
	}
	return body.trim();
}

async function gerritGet(path: string): Promise<unknown> {
	const url = gerritUrl(path);
	const cookieJar = buildCookieJar();
	const resp = await got(url, {
		method: 'GET',
		headers: gerritHeaders(false),
		cookieJar,
		https: { rejectUnauthorized: false },
	});
	return JSON.parse(stripMagic(resp.body));
}

async function gerritGetRaw(path: string): Promise<string> {
	const url = gerritUrl(path);
	const cookieJar = buildCookieJar();
	const resp = await got(url, {
		method: 'GET',
		headers: gerritHeaders(false),
		cookieJar,
		https: { rejectUnauthorized: false },
	});
	return resp.body;
}

async function gerritPut(path: string, body: unknown): Promise<unknown> {
	const url = gerritUrl(path);
	const cookieJar = buildCookieJar();
	const resp = await got(url, {
		method: 'PUT',
		headers: gerritHeaders(true),
		body: JSON.stringify(body),
		cookieJar,
		https: { rejectUnauthorized: false },
	});
	return JSON.parse(stripMagic(resp.body));
}

function buildCookieJar():
	| { getCookieString: () => Promise<string>; setCookie: () => Promise<void> }
	| undefined {
	if (!GERRIT_AUTH_COOKIE) {
		return undefined;
	}
	const cookieString = `GerritAccount=${GERRIT_AUTH_COOKIE}`;
	return {
		getCookieString: () => Promise.resolve(cookieString),
		setCookie: () => Promise.resolve(),
	};
}

// ── MCP Tool definitions ────────────────────────────

interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
	{
		name: 'gerrit_get_change',
		description:
			'Get change metadata including subject, owner, ' +
			'branch, status, commit message, insertions, ' +
			'and deletions.',
		inputSchema: {
			type: 'object',
			properties: {
				changeNumber: {
					type: 'string',
					description: 'Gerrit change number',
				},
			},
			required: ['changeNumber'],
		},
	},
	{
		name: 'gerrit_get_changed_files',
		description:
			'List all files changed in the current patchset ' +
			'with lines inserted/deleted.',
		inputSchema: {
			type: 'object',
			properties: {
				changeNumber: {
					type: 'string',
					description: 'Gerrit change number',
				},
			},
			required: ['changeNumber'],
		},
	},
	{
		name: 'gerrit_get_file_content',
		description:
			'Get the full content of a file in the current ' +
			'patchset revision.',
		inputSchema: {
			type: 'object',
			properties: {
				changeNumber: {
					type: 'string',
					description: 'Gerrit change number',
				},
				filePath: {
					type: 'string',
					description: 'Path to the file',
				},
			},
			required: ['changeNumber', 'filePath'],
		},
	},
	{
		name: 'gerrit_get_file_diff',
		description:
			'Get the diff for a single file in the current ' +
			'patchset, including hunk ranges and per-line ' +
			'side info. Use this BEFORE posting any comment ' +
			'to know which exact lines (and which side: ' +
			'PARENT vs REVISION) were actually changed. The ' +
			'response includes a `hunks` array with `aStart`/' +
			'`aLines` (PARENT side, deletions) and `bStart`/' +
			'`bLines` (REVISION side, insertions) so you can ' +
			'pick the correct `line`, `range`, and `side` ' +
			'for gerrit_post_draft_comment.',
		inputSchema: {
			type: 'object',
			properties: {
				changeNumber: {
					type: 'string',
					description: 'Gerrit change number',
				},
				filePath: {
					type: 'string',
					description: 'Path to the file',
				},
			},
			required: ['changeNumber', 'filePath'],
		},
	},
	{
		name: 'gerrit_get_comments',
		description:
			'Get all published comments on a change, ' + 'grouped by file.',
		inputSchema: {
			type: 'object',
			properties: {
				changeNumber: {
					type: 'string',
					description: 'Gerrit change number',
				},
			},
			required: ['changeNumber'],
		},
	},
	{
		name: 'gerrit_get_draft_comments',
		description: 'Get all existing draft comments on a change.',
		inputSchema: {
			type: 'object',
			properties: {
				changeNumber: {
					type: 'string',
					description: 'Gerrit change number',
				},
			},
			required: ['changeNumber'],
		},
	},
	{
		name: 'gerrit_post_draft_comment',
		description:
			'Post a new draft comment on a specific file ' +
			'and line. Use /PATCHSET_LEVEL as filePath ' +
			'for patchset-level comments. Line numbers are ' +
			'1-indexed. By default the comment attaches to ' +
			'the REVISION (post-image) side; pass ' +
			'`side: "PARENT"` to comment on a deleted line ' +
			'using the parent-side line number. To highlight ' +
			'a multi-line region, pass `range` instead of (or ' +
			'in addition to) `line` — when both are given ' +
			'`line` should equal `range.endLine`. Always call ' +
			'`gerrit_get_file_diff` first to confirm the ' +
			'exact line numbers and side.',
		inputSchema: {
			type: 'object',
			properties: {
				changeNumber: {
					type: 'string',
					description: 'Gerrit change number',
				},
				filePath: {
					type: 'string',
					description: 'File path or /PATCHSET_LEVEL',
				},
				line: {
					type: 'number',
					description:
						'1-indexed line number on the chosen ' +
						'side (omit for file-level)',
				},
				side: {
					type: 'string',
					enum: ['REVISION', 'PARENT'],
					description:
						'Which side of the diff the line/range ' +
						'refers to. Defaults to REVISION ' +
						'(post-image). Use PARENT for deleted ' +
						'lines that only exist in the parent.',
				},
				range: {
					type: 'object',
					description:
						'Multi-line region. All fields are ' +
						'1-indexed. `endLine` is inclusive. ' +
						'`startCharacter` and `endCharacter` ' +
						'are 0-indexed column offsets.',
					properties: {
						startLine: { type: 'number' },
						startCharacter: { type: 'number' },
						endLine: { type: 'number' },
						endCharacter: { type: 'number' },
					},
					required: [
						'startLine',
						'startCharacter',
						'endLine',
						'endCharacter',
					],
				},
				message: {
					type: 'string',
					description: 'Comment text',
				},
				unresolved: {
					type: 'boolean',
					description: 'Mark as unresolved',
				},
			},
			required: ['changeNumber', 'filePath', 'message'],
		},
	},
	{
		name: 'gerrit_reply_to_comment',
		description:
			'Reply to an existing comment thread. Uses ' +
			'in_reply_to to chain comments.',
		inputSchema: {
			type: 'object',
			properties: {
				changeNumber: {
					type: 'string',
					description: 'Gerrit change number',
				},
				filePath: {
					type: 'string',
					description: 'File path of the thread',
				},
				message: {
					type: 'string',
					description: 'Reply text',
				},
				inReplyTo: {
					type: 'string',
					description: 'ID of comment to reply to',
				},
			},
			required: ['changeNumber', 'filePath', 'message', 'inReplyTo'],
		},
	},
];

// ── Tool handlers ───────────────────────────────────

type ToolArgs = Record<string, unknown>;

async function handleTool(name: string, args: ToolArgs): Promise<string> {
	switch (name) {
		case 'gerrit_get_change':
			return handleGetChange(args);
		case 'gerrit_get_changed_files':
			return handleGetChangedFiles(args);
		case 'gerrit_get_file_content':
			return handleGetFileContent(args);
		case 'gerrit_get_file_diff':
			return handleGetFileDiff(args);
		case 'gerrit_get_comments':
			return handleGetComments(args);
		case 'gerrit_get_draft_comments':
			return handleGetDraftComments(args);
		case 'gerrit_post_draft_comment':
			return handlePostDraft(args);
		case 'gerrit_reply_to_comment':
			return handleReplyToComment(args);
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

async function handleGetChange(args: ToolArgs): Promise<string> {
	const cn = String(args.changeNumber);
	const data = await gerritGet(
		`changes/${cn}/detail/` +
			'?o=CURRENT_REVISION&o=CURRENT_COMMIT' +
			'&o=DETAILED_ACCOUNTS'
	);
	return JSON.stringify(data, null, 2);
}

async function handleGetChangedFiles(args: ToolArgs): Promise<string> {
	const cn = String(args.changeNumber);
	const data = await gerritGet(`changes/${cn}/revisions/current/files`);
	return JSON.stringify(data, null, 2);
}

async function handleGetFileContent(args: ToolArgs): Promise<string> {
	const cn = String(args.changeNumber);
	const fp = String(args.filePath);
	const encoded = encodeURIComponent(fp);
	const raw = await gerritGetRaw(
		`changes/${cn}/revisions/current/` + `files/${encoded}/content`
	);
	const decoded = Buffer.from(raw, 'base64').toString('utf-8');
	return decoded;
}

// Shape of a single entry in Gerrit's DiffInfo.content array.
// See: Documentation/rest-api-changes.html#diff-content
//   - ab:     lines unchanged on both sides
//   - a:      lines only on side A (parent / pre-image) -> deletions
//   - b:      lines only on side B (revision / post-image) -> additions
//   - skip:   number of common lines elided (used for very large files)
//   - common: when true, a/b are whitespace-only differences that the
//             requested ignore-whitespace setting considers equal, so
//             they should be treated as unchanged (like ab).
// Gerrit does NOT include line numbers anywhere in this payload; they
// must be reconstructed by walking the entries in order and keeping
// running counters for each side. This is the same approach used by
// PolyGerrit's own diff UI.
interface GerritDiffContentEntry {
	a?: string[];
	b?: string[];
	ab?: string[];
	skip?: number;
	common?: boolean;
}

interface GerritDiff {
	change_type?: string;
	content?: GerritDiffContentEntry[];
}

// A contiguous block of changed lines, with 1-indexed starting line
// numbers on each side. Field names (aStart/aLines/bStart/bLines)
// match the Gerrit "side A / side B" convention and are part of this
// MCP tool's public response shape — do not rename without updating
// the tool description in TOOLS as well.
interface SimpleHunk {
	aStart: number;
	aLines: number;
	bStart: number;
	bLines: number;
	deletedLines: string[];
	addedLines: string[];
}

function summarizeDiff(diff: GerritDiff): {
	changeType: string;
	hunks: SimpleHunk[];
} {
	const entries = diff.content ?? [];
	const hunks: SimpleHunk[] = [];

	// 1-indexed running line numbers for each side, advanced as we
	// walk the entries. parentLine corresponds to Gerrit "side A",
	// revisionLine to "side B".
	let parentLine = 1;
	let revisionLine = 1;

	// Consecutive non-common entries (a pure deletion followed by a
	// pure addition, or vice versa) describe a single logical hunk —
	// a "replace" — so we accumulate them into `currentHunk` and only
	// push to `hunks` when we hit an unchanged region.
	let currentHunk: SimpleHunk | null = null;

	const finalizeHunk = (): void => {
		if (currentHunk) {
			hunks.push(currentHunk);
			currentHunk = null;
		}
	};

	for (const entry of entries) {
		// Region is unchanged either explicitly (ab) or because
		// `common: true` says the a/b difference is whitespace-only
		// under the active ignore-whitespace setting.
		const isUnchanged = entry.ab !== undefined || entry.common === true;
		if (isUnchanged) {
			finalizeHunk();
			const length = (entry.ab ?? entry.a ?? entry.b ?? []).length;
			parentLine += length;
			revisionLine += length;
			continue;
		}

		// Skipped common region in a truncated diff — advance both
		// sides by the skip count without emitting a hunk.
		if (entry.skip && entry.skip > 0) {
			finalizeHunk();
			parentLine += entry.skip;
			revisionLine += entry.skip;
			continue;
		}

		const deleted = entry.a ?? [];
		const added = entry.b ?? [];

		if (!currentHunk) {
			currentHunk = {
				aStart: parentLine,
				aLines: 0,
				bStart: revisionLine,
				bLines: 0,
				deletedLines: [],
				addedLines: [],
			};
		}

		currentHunk.aLines += deleted.length;
		currentHunk.bLines += added.length;
		for (const line of deleted) {
			currentHunk.deletedLines.push(line);
		}
		for (const line of added) {
			currentHunk.addedLines.push(line);
		}

		parentLine += deleted.length;
		revisionLine += added.length;
	}
	finalizeHunk();

	return {
		changeType: diff.change_type ?? 'MODIFIED',
		hunks,
	};
}

async function handleGetFileDiff(args: ToolArgs): Promise<string> {
	const cn = String(args.changeNumber);
	const fp = String(args.filePath);
	const encoded = encodeURIComponent(fp);
	const data = (await gerritGet(
		`changes/${cn}/revisions/current/files/${encoded}/diff`
	)) as GerritDiff;

	const summary = summarizeDiff(data);
	const out = {
		filePath: fp,
		changeType: summary.changeType,
		note:
			'Line numbers are 1-indexed. aStart/aLines refer to ' +
			'the PARENT (pre-image) side; bStart/bLines refer to ' +
			'the REVISION (post-image) side. Comment on PARENT ' +
			'for deleted lines (use side="PARENT") and on ' +
			'REVISION for added/modified lines.',
		hunks: summary.hunks,
	};
	return JSON.stringify(out, null, 2);
}

async function handleGetComments(args: ToolArgs): Promise<string> {
	const cn = String(args.changeNumber);
	const data = await gerritGet(`changes/${cn}/comments/`);
	return JSON.stringify(data, null, 2);
}

async function handleGetDraftComments(args: ToolArgs): Promise<string> {
	const cn = String(args.changeNumber);
	const data = await gerritGet(`changes/${cn}/drafts/`);
	return JSON.stringify(data, null, 2);
}

interface CommentRangeArg {
	startLine?: unknown;
	startCharacter?: unknown;
	endLine?: unknown;
	endCharacter?: unknown;
}

function normalizeRange(
	raw: unknown
): {
	start_line: number;
	start_character: number;
	end_line: number;
	end_character: number;
} | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const r = raw as CommentRangeArg;
	if (
		typeof r.startLine !== 'number' ||
		typeof r.endLine !== 'number' ||
		typeof r.startCharacter !== 'number' ||
		typeof r.endCharacter !== 'number'
	) {
		return null;
	}
	return {
		start_line: r.startLine,
		start_character: r.startCharacter,
		end_line: r.endLine,
		end_character: r.endCharacter,
	};
}

function normalizeSide(raw: unknown): 'PARENT' | 'REVISION' | null {
	if (typeof raw !== 'string') {
		return null;
	}
	const upper = raw.toUpperCase();
	if (upper === 'PARENT' || upper === 'REVISION') {
		return upper;
	}
	return null;
}

async function handlePostDraft(args: ToolArgs): Promise<string> {
	const cn = String(args.changeNumber);
	const body: Record<string, unknown> = {
		path: String(args.filePath),
		message: String(args.message),
		unresolved: args.unresolved !== false,
	};

	const range = normalizeRange(args.range);
	if (range) {
		body.range = range;
		body.line = range.end_line;
	}
	if (typeof args.line === 'number') {
		body.line = args.line;
	}

	const side = normalizeSide(args.side);
	if (side) {
		body.side = side;
	}

	const data = await gerritPut(
		`changes/${cn}/revisions/current/drafts`,
		body
	);
	return JSON.stringify(data, null, 2);
}

async function handleReplyToComment(args: ToolArgs): Promise<string> {
	const cn = String(args.changeNumber);
	const body = {
		path: String(args.filePath),
		message: String(args.message),
		in_reply_to: String(args.inReplyTo),
		unresolved: false,
	};
	const data = await gerritPut(
		`changes/${cn}/revisions/current/drafts`,
		body
	);
	return JSON.stringify(data, null, 2);
}

// ── JSON-RPC protocol ───────────────────────────────

interface JsonRpcRequest {
	jsonrpc: string;
	id?: number | string | null;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string };
}

function makeResult(
	id: number | string | null,
	result: unknown
): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result };
}

function makeError(
	id: number | string | null,
	code: number,
	message: string
): JsonRpcResponse {
	return {
		jsonrpc: '2.0',
		id,
		error: { code, message },
	};
}

function sendResponse(resp: JsonRpcResponse): void {
	const json = JSON.stringify(resp);
	process.stdout.write(json + '\n');
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
	if (msg.method === 'notifications/initialized') {
		return;
	}

	if (!msg.id && msg.id !== 0) {
		return;
	}

	try {
		switch (msg.method) {
			case 'initialize':
				sendResponse(
					makeResult(msg.id, {
						protocolVersion: '2024-11-05',
						serverInfo: {
							name: 'gerrit-review',
							version: '1.0.0',
						},
						capabilities: { tools: {} },
					})
				);
				break;

			case 'tools/list':
				sendResponse(
					makeResult(msg.id, {
						tools: TOOLS,
					})
				);
				break;

			case 'tools/call': {
				const p = msg.params as {
					name: string;
					arguments?: ToolArgs;
				};
				try {
					const text = await handleTool(p.name, p.arguments ?? {});
					sendResponse(
						makeResult(msg.id, {
							content: [{ type: 'text', text }],
						})
					);
				} catch (e) {
					const errMsg = e instanceof Error ? e.message : String(e);
					sendResponse(
						makeResult(msg.id, {
							content: [{ type: 'text', text: errMsg }],
							isError: true,
						})
					);
				}
				break;
			}

			default:
				sendResponse(
					makeError(msg.id, -32601, `Method not found: ${msg.method}`)
				);
		}
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		sendResponse(makeError(msg.id, -32603, errMsg));
	}
}

// ── Main ────────────────────────────────────────────

function main(): void {
	if (!GERRIT_URL) {
		process.stderr.write('GERRIT_URL env var is required\n');
		process.exit(1);
	}

	const rl = readline.createInterface({
		input: process.stdin,
		terminal: false,
	});

	rl.on('line', (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		try {
			const msg = JSON.parse(trimmed) as JsonRpcRequest;
			void handleMessage(msg);
		} catch {
			// Ignore malformed lines
		}
	});

	rl.on('close', () => {
		process.exit(0);
	});
}

main();
