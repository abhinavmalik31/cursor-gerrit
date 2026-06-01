/**
 * Persistent multi-turn chat session backed by the Cursor Agent SDK.
 *
 * Each ChatSession wraps one SDK Agent + its conversation state and
 * exposes a small streaming API the AiThreadManager can use to drive
 * an inline comment-thread "AI Reviewer" bubble.
 *
 * The Agent's MCP servers are configured inline so the agent can
 * call the existing Gerrit MCP tools (reply to comment, post draft,
 * read change, etc.) without the user having to configure
 * `.cursor/mcp.json` separately for chat.
 */

import type { McpServerConfig, SDKAgent } from '@cursor/sdk';
import type { GerritCredentials } from '../mcp/mcpManager';
import { getDefaultModel } from './modelSelector';
import { log } from '../util/log';
import * as path from 'path';

export interface ChatCallbacks {
	onTextDelta?: (text: string) => void;
	onToolCall?: (toolName: string) => void;
	onComplete?: (finalText: string) => void;
	onError?: (err: Error) => void;
}

export interface ChatSessionOptions {
	cwd: string;
	extensionPath: string;
	credentials: GerritCredentials;
	apiKey?: string;
}

const GERRIT_MCP_SERVER_NAME = 'gerrit-review';

/**
 * Build the inline MCP server descriptor for the Gerrit tools. We
 * pass this on every `Agent.create` / `agent.send` because inline
 * MCP servers are not persisted across resume and are not loaded
 * from `.cursor/mcp.json` when `settingSources` is empty (the SDK
 * default for local agents).
 */
function buildGerritMcpServer(
	extensionPath: string,
	credentials: GerritCredentials
): McpServerConfig {
	const serverScript = path.join(
		extensionPath,
		'out',
		'lib',
		'mcp',
		'gerritMcpServer.js'
	);

	const env: Record<string, string> = {
		GERRIT_URL: credentials.url,
		GERRIT_USERNAME: credentials.username,
		GERRIT_PASSWORD: credentials.password,
	};
	if (credentials.authCookie) {
		env.GERRIT_AUTH_COOKIE = credentials.authCookie;
	}
	if (credentials.authPrefix) {
		env.GERRIT_AUTH_PREFIX = credentials.authPrefix;
	}

	return {
		type: 'stdio',
		command: process.execPath,
		args: [serverScript],
		env,
	};
}

export class ChatSession {
	private _agent: SDKAgent | null = null;
	private _disposed = false;
	private _activeRun: { cancel: () => Promise<void> } | null = null;
	private readonly _mcpServers: Record<string, McpServerConfig>;

	private constructor(
		agent: SDKAgent,
		mcpServers: Record<string, McpServerConfig>
	) {
		this._agent = agent;
		this._mcpServers = mcpServers;
	}

	public static async create(opts: ChatSessionOptions): Promise<ChatSession> {
		const sdk = await import('@cursor/sdk');
		const mcpServers: Record<string, McpServerConfig> = {
			[GERRIT_MCP_SERVER_NAME]: buildGerritMcpServer(
				opts.extensionPath,
				opts.credentials
			),
		};

		const modelId = getDefaultModel();
		const agent = await sdk.Agent.create({
			apiKey: opts.apiKey,
			model: modelId ? { id: modelId } : { id: 'auto' },
			local: {
				cwd: opts.cwd,
			},
			mcpServers,
			name: 'Gerrit AI Reviewer (chat)',
		});

		log('ChatSession created agent ' + agent.agentId);
		return new ChatSession(agent, mcpServers);
	}

	public get agentId(): string {
		return this._agent?.agentId ?? '(disposed)';
	}

	public async send(
		message: string,
		callbacks: ChatCallbacks = {}
	): Promise<void> {
		if (this._disposed || !this._agent) {
			throw new Error('ChatSession is disposed');
		}

		const sdk = await import('@cursor/sdk');

		let run;
		try {
			run = await this._agent.send(message, {
				mcpServers: this._mcpServers,
			});
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			callbacks.onError?.(e);
			throw e;
		}

		this._activeRun = run;
		log(
			'ChatSession run started: ' +
				run.id +
				' (agent ' +
				run.agentId +
				')'
		);

		let collected = '';
		try {
			for await (const evt of run.stream()) {
				if (evt.type === 'assistant') {
					for (const block of evt.message.content) {
						if (block.type === 'text' && block.text) {
							collected += block.text;
							callbacks.onTextDelta?.(block.text);
						}
					}
				} else if (evt.type === 'tool_call') {
					if (evt.status === 'running') {
						callbacks.onToolCall?.(evt.name);
					}
				}
			}

			const result = await run.wait();
			this._activeRun = null;

			if (result.status === 'error') {
				const msg =
					result.result || 'Agent run finished with error status.';
				callbacks.onError?.(new Error(msg));
				return;
			}

			if (result.status === 'cancelled') {
				callbacks.onError?.(new Error('Cancelled'));
				return;
			}

			callbacks.onComplete?.(collected || result.result || '');
		} catch (err) {
			this._activeRun = null;
			if (err instanceof sdk.CursorAgentError) {
				const msg =
					'Agent failed to start: ' +
					err.message +
					(err.isRetryable ? ' (retryable)' : '');
				callbacks.onError?.(new Error(msg));
				return;
			}
			const e = err instanceof Error ? err : new Error(String(err));
			callbacks.onError?.(e);
		}
	}

	public async cancel(): Promise<void> {
		const run = this._activeRun;
		if (!run) {
			return;
		}
		try {
			await run.cancel();
		} catch (e) {
			log('ChatSession cancel error: ' + String(e));
		}
	}

	public async dispose(): Promise<void> {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		await this.cancel();
		const agent = this._agent;
		this._agent = null;
		if (agent) {
			try {
				agent.close();
			} catch (e) {
				log('ChatSession dispose error: ' + String(e));
			}
		}
	}
}
