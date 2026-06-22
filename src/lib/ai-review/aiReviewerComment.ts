/**
 * Synthetic VS Code `Comment` rendered inside a Gerrit
 * `CommentThread` to display streaming AI responses. The body
 * is a `MarkdownString` that we mutate in place while the AI
 * is replying; the AiThreadManager forces a re-render of the
 * containing thread by reassigning `thread.comments`.
 *
 * AI Reviewer comments are local-only — they are never posted
 * to Gerrit. The user can ask the AI to post or apply changes
 * via separate commands, which then go through MCP or the
 * suggestion-fixer path.
 */

import {
	Comment,
	CommentAuthorInformation,
	CommentMode,
	MarkdownString,
} from 'vscode';
import type { GerritCommentThread } from '../gerrit/gerritAPI/gerritCommentThread';
import { AI_COMMENT_CONTEXT } from '../util/magic';

const AI_AUTHOR_NAME = 'AI Reviewer';

export class AiReviewerComment implements Comment {
	public readonly author: CommentAuthorInformation = {
		name: AI_AUTHOR_NAME,
	};
	public mode: CommentMode = CommentMode.Preview;
	public contextValue: string = AI_COMMENT_CONTEXT;
	public body: MarkdownString;
	public label?: string;

	/**
	 * Back-reference to the Gerrit thread this synthetic comment
	 * lives in. Set by AiThreadManager when the comment is pushed
	 * into the thread; used by post-as-draft / delete commands so
	 * they can act without having to walk all open threads.
	 */
	public thread: GerritCommentThread | null = null;

	private _rawText: string = '';
	private _streaming: boolean = true;

	public constructor(initialBody: string = '') {
		this._rawText = initialBody;
		this.label = 'AI · streaming';
		this.body = this._renderBody();
	}

	public get rawText(): string {
		return this._rawText;
	}

	public get isStreaming(): boolean {
		return this._streaming;
	}

	public appendText(text: string): void {
		this._rawText += text;
		this.body = this._renderBody();
	}

	public setText(text: string): void {
		this._rawText = text;
		this.body = this._renderBody();
	}

	public markDone(): void {
		this._streaming = false;
		this.label = 'AI';
		this.body = this._renderBody();
	}

	public markError(message: string): void {
		this._streaming = false;
		this.label = 'AI · error';
		const errorBlock = '\n\n> :warning: ' + message.replace(/\n/g, '\n> ');
		this._rawText = this._rawText + errorBlock;
		this.body = this._renderBody();
	}

	public markToolCall(toolName: string): void {
		if (!this._streaming) {
			return;
		}
		this.label = `AI · ${toolName}`;
	}

	private _renderBody(): MarkdownString {
		const text = this._streaming
			? this._rawText + this._streamingIndicator()
			: this._rawText || '_(no response)_';
		const md = new MarkdownString(text);
		md.isTrusted = false;
		md.supportThemeIcons = true;
		md.supportHtml = false;
		return md;
	}

	private _streamingIndicator(): string {
		return this._rawText.length === 0 ? '_Thinking…_' : '  \n_…_';
	}
}
