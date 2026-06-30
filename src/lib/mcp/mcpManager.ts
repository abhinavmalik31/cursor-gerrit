import { log } from '../util/log';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface McpConfig {
	mcpServers: Record<
		string,
		{
			command: string;
			args?: string[];
			env?: Record<string, string>;
		}
	>;
}

const MCP_SERVER_NAME = 'gerrit-review';

/**
 * Path to Cursor's global MCP config (`~/.cursor/mcp.json`). 
 */
function getGlobalMcpConfigPath(): string {
	return path.join(os.homedir(), '.cursor', 'mcp.json');
}

export interface GerritCredentials {
	url: string;
	username: string;
	password: string;
	authCookie?: string;
	authPrefix?: string;
}

export async function writeMcpConfig(
	extensionPath: string,
	credentials: GerritCredentials
): Promise<boolean> {
	const mcpConfigPath = getGlobalMcpConfigPath();
	const mcpDir = path.dirname(mcpConfigPath);

	let config: McpConfig = { mcpServers: {} };
	try {
		if (fs.existsSync(mcpConfigPath)) {
			const existing = fs.readFileSync(mcpConfigPath, 'utf-8');
			config = JSON.parse(existing) as McpConfig;
			if (!config.mcpServers) {
				config.mcpServers = {};
			}
		}
	} catch {
		config = { mcpServers: {} };
	}

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

	config.mcpServers[MCP_SERVER_NAME] = {
		command: process.execPath,
		args: [serverScript],
		env,
	};

	try {
		if (!fs.existsSync(mcpDir)) {
			fs.mkdirSync(mcpDir, { recursive: true });
		}
		fs.writeFileSync(
			mcpConfigPath,
			JSON.stringify(config, null, '\t'),
			'utf-8'
		);
		log('MCP config written to ' + mcpConfigPath);
		return true;
	} catch (e) {
		log('Failed to write MCP config: ' + String(e));
		return false;
	}
}

export function removeMcpConfig(): void {
	const mcpConfigPath = getGlobalMcpConfigPath();
	try {
		if (!fs.existsSync(mcpConfigPath)) {
			return;
		}
		const existing = fs.readFileSync(mcpConfigPath, 'utf-8');
		const config = JSON.parse(existing) as McpConfig;
		if (config.mcpServers?.[MCP_SERVER_NAME]) {
			delete config.mcpServers[MCP_SERVER_NAME];
			fs.writeFileSync(
				mcpConfigPath,
				JSON.stringify(config, null, '\t'),
				'utf-8'
			);
			log('Removed MCP server config');
		}
	} catch {
		// Ignore errors during cleanup
	}
}

export function isMcpConfigured(): boolean {
	const mcpConfigPath = getGlobalMcpConfigPath();
	try {
		if (!fs.existsSync(mcpConfigPath)) {
			return false;
		}
		const existing = fs.readFileSync(mcpConfigPath, 'utf-8');
		const config = JSON.parse(existing) as McpConfig;
		return !!config.mcpServers?.[MCP_SERVER_NAME];
	} catch {
		return false;
	}
}
