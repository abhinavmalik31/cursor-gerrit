/**
 * Coordinates inline AI chat bubbles inside Gerrit comment
 * threads. One ChatSession per (changeID, threadRootCommentID),
 * with at most one AiReviewerComment streaming at a time.
 *
 * Re-renders the VS Code CommentThread by reassigning
 * `thread.comments` after each text delta (debounced) so the
 * inline bubble updates live as the agent replies.
 */

import {
	CommentMode,
	CommentThread,
	CommentThreadCollapsibleState,
	Range,
	Uri,
	window,
	workspace,
} from 'vscode';
import { GerritCommentThread } from '../gerrit/gerritAPI/gerritCommentThread';
import { getGerritURLFromReviewFile } from '../credentials/enterCredentials';
import { GerritCommentBase } from '../gerrit/gerritAPI/gerritComment';
import { getGitReviewFileCached } from '../credentials/gitReviewFile';
import { GerritChange } from '../gerrit/gerritAPI/gerritChange';
import { Repository } from '../../types/vscode-extension-git';
import { FileMeta } from '../../providers/fileProvider';
import { AiReviewerComment } from './aiReviewerComment';
import { GerritSecrets } from '../credentials/secrets';
import { GerritCredentials } from '../mcp/mcpManager';
import { getConfiguration } from '../vscode/config';
import { AI_COMMENT_CONTEXT } from '../util/magic';
import { resolveCursorApiKey } from './modelSelector';
import { ChatSession } from './chatSession';
import { log } from '../util/log';

interface ThreadState {
	session: ChatSession;
	liveComment: AiReviewerComment | null;
	hasSentSeed: boolean;
	pendingRender: ReturnType<typeof setTimeout> | null;
	disposed: boolean;
}

const RENDER_DEBOUNCE_MS = 60;

export class AiThreadManager {
	private static _instance: AiThreadManager | null = null;
	private _states = new Map<string, ThreadState>();
	private _extensionPath: string = '';

	private constructor() {}

	public static get instance(): AiThreadManager {
		if (!this._instance) {
			this._instance = new AiThreadManager();
		}
		return this._instance;
	}

	public setExtensionPath(extPath: string): void {
		this._extensionPath = extPath;
	}

	public hasActiveSession(thread: GerritCommentThread): boolean {
		return this._states.has(this._keyFor(thread));
	}

	public async ask(
		thread: GerritCommentThread,
		userMessage: string,
		gerritRepo: Repository
	): Promise<void> {
		const key = this._keyFor(thread);

		const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) {
			void window.showErrorMessage(
				'No workspace folder open; cannot start AI chat.'
			);
			return;
		}

		const apiKey = this._resolveApiKey();
		if (!apiKey) {
			void window
				.showErrorMessage(
					'Cursor API key is not configured. Set' +
						' "gerrit.aiReview.apiKey" or the' +
						' CURSOR_API_KEY env var.',
					'Open Settings'
				)
				.then((pick) => {
					if (pick === 'Open Settings') {
						void window.showInformationMessage(
							'Settings → search' + ' "gerrit.aiReview.apiKey"'
						);
					}
				});
			return;
		}

		let state = this._states.get(key);
		if (!state) {
			const credentials = await this._extractCredentials(gerritRepo);
			if (!credentials) {
				void window.showErrorMessage(
					'Could not extract Gerrit credentials.' +
						' Run "Gerrit: Enter Credentials".'
				);
				return;
			}

			let session: ChatSession;
			try {
				session = await ChatSession.create({
					cwd,
					extensionPath: this._extensionPath,
					credentials,
					apiKey,
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				log('Failed to create AI chat session: ' + msg);
				void window.showErrorMessage(
					'Failed to start AI chat session: ' + msg
				);
				return;
			}

			state = {
				session,
				liveComment: null,
				hasSentSeed: false,
				pendingRender: null,
				disposed: false,
			};
			this._states.set(key, state);
			this._lockReplies(thread, true);
		}

		const prompt = state.hasSentSeed
			? this._buildFollowupPrompt(userMessage)
			: await this._buildSeedPrompt(thread, userMessage);

		const liveComment = new AiReviewerComment();
		state.liveComment = liveComment;
		this._appendCommentToThread(thread, liveComment);
		this._expandThread(thread);

		state.hasSentSeed = true;
		const captured = state;

		await captured.session.send(prompt, {
			onTextDelta: (text) => {
				if (captured.disposed) {
					return;
				}
				liveComment.appendText(text);
				this._scheduleRender(thread, captured);
			},
			onToolCall: (toolName) => {
				if (captured.disposed) {
					return;
				}
				liveComment.markToolCall(toolName);
				this._scheduleRender(thread, captured);
			},
			onComplete: () => {
				if (captured.disposed) {
					return;
				}
				liveComment.markDone();
				captured.liveComment = null;
				this._renderNow(thread);
				this._lockReplies(thread, false);
			},
			onError: (err) => {
				if (captured.disposed) {
					return;
				}
				liveComment.markError(err.message);
				captured.liveComment = null;
				this._renderNow(thread);
				this._lockReplies(thread, false);
			},
		});
	}

	public async cancel(thread: GerritCommentThread): Promise<void> {
		const state = this._states.get(this._keyFor(thread));
		if (!state) {
			return;
		}
		await state.session.cancel();
	}

	public async endSession(thread: GerritCommentThread): Promise<void> {
		const key = this._keyFor(thread);
		const state = this._states.get(key);
		if (!state) {
			return;
		}
		state.disposed = true;
		if (state.pendingRender) {
			clearTimeout(state.pendingRender);
		}
		this._states.delete(key);
		this._lockReplies(thread, false);
		await state.session.dispose();
	}

	public async disposeAll(): Promise<void> {
		const states = Array.from(this._states.values());
		this._states.clear();
		await Promise.all(
			states.map(async (s) => {
				s.disposed = true;
				if (s.pendingRender) {
					clearTimeout(s.pendingRender);
				}
				await s.session.dispose();
			})
		);
	}

	// ── internals ───────────────────────────────────

	private _keyFor(thread: GerritCommentThread): string {
		const root = thread.comments[0];
		if (!root) {
			return 'empty|' + thread.thread.uri.toString();
		}
		return `${root.changeID}|${root.id}`;
	}

	private _appendCommentToThread(
		gthread: GerritCommentThread,
		aiComment: AiReviewerComment
	): void {
		aiComment.thread = gthread;
		const raw = gthread.thread as unknown as CommentThread;
		raw.comments = [
			...(raw.comments as readonly unknown[]),
			aiComment,
		] as CommentThread['comments'];
	}

	private _scheduleRender(
		gthread: GerritCommentThread,
		state: ThreadState
	): void {
		if (state.pendingRender) {
			return;
		}
		state.pendingRender = setTimeout(() => {
			state.pendingRender = null;
			if (state.disposed) {
				return;
			}
			this._renderNow(gthread);
		}, RENDER_DEBOUNCE_MS);
	}

	private _renderNow(gthread: GerritCommentThread): void {
		const raw = gthread.thread as unknown as CommentThread;
		raw.comments = [...raw.comments];
	}

	private _expandThread(gthread: GerritCommentThread): void {
		const raw = gthread.thread as unknown as CommentThread;
		raw.collapsibleState = CommentThreadCollapsibleState.Expanded;
	}

	private _lockReplies(gthread: GerritCommentThread, locked: boolean): void {
		const raw = gthread.thread as unknown as CommentThread;
		raw.canReply = !locked;
		const editing = raw.comments.find(
			(c) => (c as { mode?: CommentMode }).mode === CommentMode.Editing
		);
		if (editing) {
			(editing as { mode?: CommentMode }).mode = CommentMode.Preview;
		}
	}

	private _resolveApiKey(): string | undefined {
		return resolveCursorApiKey();
	}

	private async _extractCredentials(
		gerritRepo: Repository
	): Promise<GerritCredentials | null> {
		const config = getConfiguration();
		const gitReviewFile = await getGitReviewFileCached(gerritRepo);

		const url = getGerritURLFromReviewFile(gitReviewFile);
		if (!url) {
			return null;
		}

		const username = config.get('gerrit.auth.username') ?? '';
		const password = await GerritSecrets.getForUrlOrWorkspace(
			'password',
			url,
			workspace.workspaceFolders?.[0]?.uri
		);
		const cookie = await GerritSecrets.getForUrlOrWorkspace(
			'cookie',
			url,
			workspace.workspaceFolders?.[0]?.uri
		);
		const authPrefix = config.get('gerrit.customAuthUrlPrefix', 'a/');

		if (!username && !password && !cookie) {
			return null;
		}

		return {
			url,
			username,
			password: password ?? '',
			authCookie: cookie ?? undefined,
			authPrefix,
		};
	}

	private async _buildSeedPrompt(
		gthread: GerritCommentThread,
		userMessage: string
	): Promise<string> {
		const realComments = this._realGerritComments(gthread);
		const root: GerritCommentBase | undefined = realComments[0];
		const transcript = realComments
			.map((c) => {
				const author = c.gerritAuthor?.getName() ?? 'Unknown';
				return `- ${author}: ${c.message ?? ''}`;
			})
			.join('\n');

		const uri = gthread.thread.uri;
		const fileMeta = FileMeta.tryFrom(uri);
		const filePath = root?.filePath ?? fileMeta?.filePath ?? uri.path;

		const threadRange = gthread.thread.range;
		const lineLabel = this._formatRangeLabel(threadRange, root?.line);
		const changeID = root?.changeID ?? fileMeta?.changeID ?? '';

		let changeNumber = changeID;
		try {
			if (changeID) {
				const change = await GerritChange.getChangeOnce(changeID, []);
				if (change) {
					changeNumber = String(change.number);
				}
			}
		} catch {
			// best effort
		}

		const snippet = await this._extractSnippet(
			uri,
			threadRange,
			realComments.length > 0
		);

		const parts: string[] = [
			'You are helping the user discuss a Gerrit review comment thread.',
			'You have local repo access (use Read / Grep / Edit) and the' +
				' gerrit-review MCP server (gerrit_get_change,' +
				' gerrit_get_file_content, gerrit_get_comments,' +
				' gerrit_reply_to_comment, gerrit_post_draft_comment).',
			'',
			'Conversation rules:',
			'- Reply concisely in Markdown. Use code fences with' +
				' language hints for code.',
			'- Do NOT post anything back to Gerrit unless the user' +
				' explicitly asks ("post as reply", "resolve",' +
				' "apply the fix and reply Done", etc.).',
			'- For follow-up turns, assume the user has read your' +
				' previous reply; do not repeat it.',
			'',
			`Change: ${changeNumber}`,
			`File: ${filePath}`,
			`Lines: ${lineLabel}`,
		];

		if (snippet) {
			parts.push('', 'Selected code:', snippet);
		}

		parts.push(
			'',
			'Existing thread:',
			transcript || '(empty — this is a new comment thread)',
			'',
			'User asks:',
			userMessage.trim() ||
				'(no message — analyze the selected code and the' +
					' thread, then suggest what the reviewer might' +
					' be flagging or what action to take)'
		);

		return parts.join('\n');
	}

	private _buildFollowupPrompt(userMessage: string): string {
		const trimmed = userMessage.trim();
		return trimmed || '(continue)';
	}

	private _realGerritComments(
		gthread: GerritCommentThread
	): GerritCommentBase[] {
		const all = gthread.comments as readonly unknown[];
		return all.filter((c): c is GerritCommentBase => !this._isAiComment(c));
	}

	private _isAiComment(c: unknown): boolean {
		const ctx = (c as { contextValue?: string } | null)?.contextValue;
		return typeof ctx === 'string' && ctx.includes(AI_COMMENT_CONTEXT);
	}

	private _formatRangeLabel(
		range: Range | undefined,
		fallbackLine: number | undefined
	): string {
		if (range) {
			const startLine = range.start.line + 1;
			const endLine = range.end.line + 1;
			if (startLine === endLine) {
				return String(startLine);
			}
			return `${startLine}\u2013${endLine}`;
		}
		return fallbackLine ? String(fallbackLine) : 'file-level';
	}

	private async _extractSnippet(
		uri: Uri,
		range: Range | undefined,
		padForSingleLine: boolean
	): Promise<string | null> {
		if (!range) {
			return null;
		}
		try {
			const doc = await workspace.openTextDocument(uri);
			const isSingleLine = range.start.line === range.end.line;
			const padding = isSingleLine && padForSingleLine ? 3 : 0;
			const startLine = Math.max(0, range.start.line - padding);
			const endLine = Math.min(
				doc.lineCount - 1,
				range.end.line + padding
			);
			const lines: string[] = [];
			for (let i = startLine; i <= endLine; i++) {
				const num = (i + 1).toString().padStart(5, ' ');
				lines.push(`${num} | ${doc.lineAt(i).text}`);
			}
			const lang = this._inferLang(uri.path);
			return '```' + lang + '\n' + lines.join('\n') + '\n```';
		} catch (e) {
			log('Failed to extract snippet: ' + String(e));
			return null;
		}
	}

	private _inferLang(filePath: string): string {
		const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
		const map: Record<string, string> = {
			ts: 'ts',
			tsx: 'tsx',
			js: 'js',
			jsx: 'jsx',
			py: 'python',
			go: 'go',
			rs: 'rust',
			java: 'java',
			cpp: 'cpp',
			c: 'c',
			h: 'c',
			cc: 'cpp',
			cs: 'csharp',
			rb: 'ruby',
			php: 'php',
			kt: 'kotlin',
			swift: 'swift',
			sh: 'bash',
			md: 'markdown',
			json: 'json',
			yaml: 'yaml',
			yml: 'yaml',
		};
		return map[ext] ?? '';
	}
}
