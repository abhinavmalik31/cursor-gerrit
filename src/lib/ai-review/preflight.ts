import { exec } from 'child_process';

const MIN_NODE_MAJOR = 18;
const INSTALL_URL =
	'https://cursor.com/docs/cli/installation';

export interface AgentCommand {
	cmd: string;
	baseArgs: string[];
}

export interface PreflightDeps {
	whichCmd: (
		name: string
	) => Promise<boolean>;
	getNodeMajor: () => number;
}

function defaultWhich(
	name: string
): Promise<boolean> {
	return new Promise((resolve) => {
		exec(
			`which ${name}`,
			(err, stdout) => {
				resolve(!err && !!stdout.trim());
			}
		);
	});
}

const defaultDeps: PreflightDeps = {
	whichCmd: defaultWhich,
	getNodeMajor: (): number => {
		return parseInt(
			process.versions.node.split('.')[0],
			10
		);
	},
};

export interface PreflightResult {
	ok: boolean;
	agent?: AgentCommand;
	error?: string;
}

export async function runPreflight(
	deps: PreflightDeps = defaultDeps
): Promise<PreflightResult> {
	const nodeMajor = deps.getNodeMajor();
	if (nodeMajor < MIN_NODE_MAJOR) {
		return {
			ok: false,
			error:
				`Node.js >= ${MIN_NODE_MAJOR} is required `
				+ 'for AI Review, but found '
				+ `v${nodeMajor}. Please upgrade Node.js.`,
		};
	}

	const hasAgent = await deps.whichCmd('agent');
	if (hasAgent) {
		return {
			ok: true,
			agent: { cmd: 'agent', baseArgs: [] },
		};
	}

	const hasCursor = await deps.whichCmd('cursor');
	if (hasCursor) {
		return {
			ok: true,
			agent: {
				cmd: 'cursor',
				baseArgs: ['agent'],
			},
		};
	}

	return {
		ok: false,
		error:
			'Cursor Agent CLI not found. '
			+ 'Install it with: '
			+ 'curl https://cursor.com/install '
			+ '-fsS | bash  '
			+ `(${INSTALL_URL})`,
	};
}

export function buildMcpEnableCommand(
	agent: AgentCommand,
	serverName: string
): string {
	const parts = [
		agent.cmd, ...agent.baseArgs,
		'mcp', 'enable', serverName,
	];
	return parts.join(' ');
}
