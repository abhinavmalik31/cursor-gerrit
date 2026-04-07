export interface AgentCommand {
	cmd: string;
	baseArgs: string[];
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
