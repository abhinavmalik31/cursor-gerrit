import {
	chmodSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { GerritSecrets } from '../credentials/secrets';
import { Repository } from '../../types/vscode-extension-git';
import { getConfiguration } from '../vscode/config';
import { getGerritURL } from '../credentials/enterCredentials';
import { tryExecAsync } from './gitCLI';
import { workspace } from 'vscode';
import { tmpdir } from 'os';
import { join } from 'path';
import { log } from '../util/log';

export interface GerritAskpassEnv {
	GIT_ASKPASS: string;
	GIT_TERMINAL_PROMPT: '0';
	SSH_ASKPASS: string;
	SSH_ASKPASS_REQUIRE: 'never';
	GERRIT_ASKPASS_USERNAME: string;
	GERRIT_ASKPASS_PASSWORD: string;
}

export interface GerritAskpassHandle {
	dir: string;
	env: GerritAskpassEnv;
	dispose: () => void;
}

/**
 * Build a per-invocation `GIT_ASKPASS` shim script
 * that answers the next two prompts git issues with
 * the configured Gerrit username + password.
 *
 * The script lives in a freshly created temp dir
 * and is removed by `dispose()`. Credentials are
 * passed to git via env vars (process-scoped), not
 * written to disk.
 *
 * Returns `null` when:
 *   - we are not on a POSIX platform (this version
 *     only ships a sh-based shim);
 *   - the configured Gerrit URL host does not match
 *     the host of the remote git is about to talk to;
 *   - no username/password is configured for that
 *     Gerrit URL.
 */
export async function makeGerritAskpassForRemote(
	gerritRepo: Repository,
	remote: string
): Promise<GerritAskpassHandle | null> {
	if (process.platform === 'win32') {
		// The shim is a POSIX sh script. A separate
		// .cmd shim is required to support Windows;
		// that's not implemented yet, so fall back
		// to git's normal credential discovery.
		return null;
	}

	const remoteUrl = await getRemoteUrl(gerritRepo, remote);
	if (!remoteUrl) {
		return null;
	}

	const remoteHost = parseHost(remoteUrl);
	if (!remoteHost) {
		return null;
	}

	const gerritUrl = await getGerritURL(gerritRepo);
	if (!gerritUrl) {
		return null;
	}
	const gerritHost = parseHost(gerritUrl);
	if (!gerritHost || gerritHost !== remoteHost) {
		// The remote is not the configured Gerrit
		// host. Don't hand it our credentials.
		return null;
	}

	const config = getConfiguration();
	const username = config.get('gerrit.auth.username');
	if (!username) {
		return null;
	}

	const password = await GerritSecrets.getForUrlOrWorkspace(
		'password',
		gerritUrl,
		workspace.workspaceFolders?.[0].uri
	);
	if (!password) {
		return null;
	}

	const dir = mkdtempSync(join(tmpdir(), 'gerrit-askpass-'));
	const scriptPath = join(dir, 'askpass.sh');

	// The shim looks at the prompt git passes as $1
	// and prints either the username or the password.
	// Both are read from env vars so the password
	// never lands on disk.
	const script =
		'#!/bin/sh\n' +
		'case "$1" in\n' +
		'    *[Uu]sername*)\n' +
		'        printf %s "$GERRIT_ASKPASS_USERNAME"\n' +
		'        ;;\n' +
		'    *[Pp]assword*|*[Pp]assphrase*)\n' +
		'        printf %s "$GERRIT_ASKPASS_PASSWORD"\n' +
		'        ;;\n' +
		'    *)\n' +
		'        printf %s "$GERRIT_ASKPASS_PASSWORD"\n' +
		'        ;;\n' +
		'esac\n';

	writeFileSync(scriptPath, script, { encoding: 'utf8' });
	chmodSync(scriptPath, 0o700);

	return {
		dir,
		env: {
			GIT_ASKPASS: scriptPath,
			GIT_TERMINAL_PROMPT: '0',
			SSH_ASKPASS: scriptPath,
			SSH_ASKPASS_REQUIRE: 'never',
			GERRIT_ASKPASS_USERNAME: username,
			GERRIT_ASKPASS_PASSWORD: password,
		},
		dispose: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch (e) {
				log(
					'Failed to clean up gerrit askpass dir: ' +
						String(e)
				);
			}
		},
	};
}

async function getRemoteUrl(
	gerritRepo: Repository,
	remote: string
): Promise<string | null> {
	const { stdout, success } = await tryExecAsync(
		`git remote get-url ${remote}`,
		{
			cwd: gerritRepo.rootUri.fsPath,
			silent: true,
		}
	);
	if (!success) {
		return null;
	}
	return stdout.trim() || null;
}

function parseHost(url: string): string | null {
	try {
		// URL doesn't accept scp-like ssh URLs
		// (user@host:path); for those we don't
		// share http creds anyway, so a parse
		// failure -> null is the right behavior.
		const parsed = new URL(url);
		return parsed.hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}
