import {
	AgentCommand,
	buildMcpEnableCommand,
} from './agentCli';
import {
	window,
	workspace,
	ExtensionContext,
	ProgressLocation,
	env,
	Uri,
} from 'vscode';
import { getGerritURLFromReviewFile } from '../credentials/enterCredentials';
import { UserCancelledError, isUserCancelledError } from '../util/errors';
import { getGitReviewFileCached } from '../credentials/gitReviewFile';
import { writeMcpConfig, GerritCredentials } from '../mcp/mcpManager';
import { GerritSecrets } from '../credentials/secrets';
import { getConfiguration } from '../vscode/config';
import { getGerritRepo } from '../gerrit/gerrit';
import { tryExecAsync } from '../git/gitCLI';
import { runPreflight } from './preflight';
import { spawn } from 'child_process';
import { log } from '../util/log';

type CheckoutBehavior = 'ask' | 'always' | 'never';

interface PrerequisiteResult {
	agent: AgentCommand;
}

export async function enableAiReview(context: ExtensionContext): Promise<void> {
	try {
		const config = getConfiguration();

		const { agent } = await resolvePrerequisites();

		const checkoutBehavior = await pickCheckoutBehavior();
		if (!checkoutBehavior) {
			void window.showInformationMessage('AI Review setup cancelled.');
			return;
		}

		await config.update(
			'gerrit.aiReview.checkoutBehavior',
			checkoutBehavior
		);

		const ok = await window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: 'Gerrit: Setting up AI Review',
				cancellable: false,
			},
			async (progress) => {
				progress.report({
					message: 'Extracting credentials...',
				});

				const credentials = await extractCredentials(context);
				if (!credentials) {
					void window.showWarningMessage(
						'Could not extract Gerrit credentials. ' +
							'Please configure them via "Gerrit: ' +
							'Enter Credentials" first.'
					);
					return false;
				}

				progress.report({
					message: 'Writing MCP configuration...',
					increment: 30,
				});

				const mcpOk = await writeMcpConfig(
					context.extensionPath,
					credentials
				);
				if (!mcpOk) {
					void window.showWarningMessage(
						'Failed to write MCP config. AI Review ' +
							'may not have full Gerrit integration.'
					);
					return false;
				}

				progress.report({
					message: 'Enabling MCP server...',
					increment: 30,
				});

				const mcpEnabled = await enableMcpServer(agent);
				if (!mcpEnabled) {
					return false;
				}

				progress.report({
					message: 'Finalizing...',
					increment: 30,
				});

				await config.update('gerrit.aiReview.enabled', true);

				return true;
			}
		);

		if (!ok) {
			return;
		}

		void window.showInformationMessage(
			'AI Review enabled! Use "Gerrit: AI Review ' +
				'Change" from the command palette or ' +
				'click the "AI Review Change" button ' +
				'in the Change Explorer view.'
		);
		log('AI Review enabled successfully');
	} catch (e: unknown) {
		if (isUserCancelledError(e)) {
			log('AI Review setup cancelled');
			return;
		}
		const msg = e instanceof Error ? e.message : String(e);
		log('AI Review setup failed: ' + msg);
		void window.showErrorMessage('AI Review setup failed: ' + msg);
	}
}

// ── Prerequisite resolution ─────────────────────

async function resolvePrerequisites(): Promise<PrerequisiteResult> {
	const status = await runPreflight();

	const alreadyLoggedIn = await isAgentLoggedIn(status.agent);
	if (!alreadyLoggedIn) {
		const fixed = await promptAgentLogin(status.agent);
		if (!fixed) {
			throw new UserCancelledError('agentLogin');
		}
	}

	return { agent: status.agent };
}

const STATUS_TIMEOUT_MS = 5_000;
const LOGIN_URL_PATTERN = /https:\/\/cursor\.com\/loginDeepControl\?\S+/;

async function isAgentLoggedIn(agent: AgentCommand): Promise<boolean> {
	const args = [...agent.baseArgs, 'status'];
	return new Promise<boolean>((resolve, reject) => {
		let settled = false;
		const proc = spawn(agent.cmd, args, {
			stdio: ['ignore', 'pipe', 'ignore'],
		});

		const finish = (result: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			proc.kill();
			resolve(result);
		};

		proc.stdout.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			if (/not\s*logged\s*in/i.test(text)) {
				finish(false);
			} else if (/logged\s*in/i.test(text)) {
				finish(true);
			}
		});

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				proc.kill();
				reject(
					new Error(
						'Timed out checking login status. ' +
							'Please run "agent login" manually ' +
							'in a terminal and retry.'
					)
				);
			}
		}, STATUS_TIMEOUT_MS);

		proc.on('error', (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(err);
			}
		});

		proc.on('close', () => {
			finish(false);
		});
	});
}

async function promptAgentLogin(agent: AgentCommand): Promise<boolean> {
	const pick = await window.showInformationMessage(
		'Cursor Agent CLI requires authentication.',
		'Login',
		'Cancel'
	);

	if (pick !== 'Login') {
		return false;
	}

	const loginOk = await window.withProgress(
		{
			location: ProgressLocation.Notification,
			title: 'Cursor Agent Login',
			cancellable: false,
		},
		async (progress) => {
			progress.report({
				message: 'Waiting for browser authentication...',
			});
			return runAgentLogin(agent);
		}
	);
	if (!loginOk) {
		void window.showWarningMessage(
			'Cursor Agent login failed. Please try again.'
		);
		return false;
	}

	const loggedIn = await isAgentLoggedIn(agent);
	if (!loggedIn) {
		void window.showWarningMessage(
			'Cursor Agent login completed, but login status ' +
				'could not be verified. Please try again.'
		);
	}

	return loggedIn;
}

async function runAgentLogin(agent: AgentCommand): Promise<boolean> {
	const args = [...agent.baseArgs, 'login'];
	return new Promise<boolean>((resolve, reject) => {
		let settled = false;
		let loginUrlShown = false;
		let output = '';
		const proc = spawn(agent.cmd, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const finish = (result: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(result);
		};

		const handleOutput = (chunk: Buffer): void => {
			output += chunk.toString();
			const match = LOGIN_URL_PATTERN.exec(output);
			if (!match || loginUrlShown) {
				output = output.slice(-2_000);
				return;
			}

			loginUrlShown = true;
			const loginUrl = match[0];
			void window
				.showInformationMessage(
					'Cursor Agent login requires browser authentication.',
					'Open Login Link'
				)
				.then((pick) => {
					if (pick === 'Open Login Link') {
						void env.openExternal(Uri.parse(loginUrl));
					}
				});
		};

		proc.stdout.on('data', handleOutput);
		proc.stderr.on('data', handleOutput);

		proc.on('error', (err) => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		});

		proc.on('close', (code) => {
			finish(code === 0);
		});
	});
}

async function pickCheckoutBehavior(): Promise<CheckoutBehavior | undefined> {
	const items = [
		{
			label: 'Ask each time',
			description:
				'Prompt before each review whether ' + 'to checkout the change',
			value: 'ask' as CheckoutBehavior,
		},
		{
			label: 'Always checkout',
			description: 'Automatically checkout for full ' + 'repo context',
			value: 'always' as CheckoutBehavior,
		},
		{
			label: 'Never checkout',
			description:
				'Review using Gerrit context only ' + '(no local checkout)',
			value: 'never' as CheckoutBehavior,
		},
	];

	const selected = await window.showQuickPick(items, {
		placeHolder: 'How should AI Review handle ' + 'change checkout?',
		title: 'Gerrit: Checkout Behavior',
	});

	return selected?.value;
}

async function extractCredentials(
	context: ExtensionContext
): Promise<GerritCredentials | null> {
	const config = getConfiguration();
	const gerritRepo = await getGerritRepo(context);
	const gitReviewFile = gerritRepo
		? await getGitReviewFileCached(gerritRepo)
		: null;

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

async function enableMcpServer(agent: AgentCommand): Promise<boolean> {
	const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;

	const cmd = buildMcpEnableCommand(agent, 'gerrit-review');
	const { success, stderr } = await tryExecAsync(cmd, { silent: true, cwd });

	if (success) {
		log('MCP server auto-approved');
		return true;
	}

	log('Could not auto-approve MCP server: ' + stderr);

	const action = await window.showWarningMessage(
		'Failed to auto-enable the MCP server. ' +
			'You may need to enable "gerrit-review" ' +
			'manually in Cursor MCP settings.',
		'Retry',
		'Continue Anyway'
	);

	if (action === 'Retry') {
		return enableMcpServer(agent);
	}

	return action === 'Continue Anyway';
}
