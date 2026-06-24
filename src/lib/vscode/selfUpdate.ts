import { commands, env, ExtensionContext, Uri, window } from 'vscode';
import { GERRIT_UPDATE_BASE_URL } from '../util/constants';
import { getConfiguration } from './config';
import { promises as fs } from 'fs';
import got from 'got/dist/source';
import { log } from '../util/log';
import * as path from 'path';
import * as os from 'os';

interface VsixCandidate {
	readonly version: string;
	readonly parts: readonly number[];
	readonly fileName: string;
}

const VSIX_FILE_PATTERN = /cursor--gerrit-(\d+\.\d+\.\d+)\.vsix/g;

function toParts(version: string): number[] {
	return version.split('.').map((part) => parseInt(part, 10));
}

function isNewer(remote: readonly number[], local: readonly number[]): boolean {
	for (let i = 0; i < 3; i++) {
		if ((remote[i] ?? 0) !== (local[i] ?? 0)) {
			return (remote[i] ?? 0) > (local[i] ?? 0);
		}
	}
	return false;
}

function rejectUnauthorized(): boolean {
	return !getConfiguration().get('gerrit.allowInvalidSSLCerts', false);
}

function autoUpdateEnabled(): boolean {
	return getConfiguration().get('gerrit.autoUpdate.enabled', true);
}

function parseCandidates(html: string): VsixCandidate[] {
	const candidates: VsixCandidate[] = [];
	const seen = new Set<string>();
	for (const match of html.matchAll(VSIX_FILE_PATTERN)) {
		const fileName = match[0];
		if (seen.has(fileName)) {
			continue;
		}
		seen.add(fileName);
		candidates.push({
			version: match[1],
			parts: toParts(match[1]),
			fileName,
		});
	}
	return candidates;
}

function pickLatest(candidates: VsixCandidate[]): VsixCandidate | null {
	let latest: VsixCandidate | null = null;
	for (const candidate of candidates) {
		if (!latest || isNewer(candidate.parts, latest.parts)) {
			latest = candidate;
		}
	}
	return latest;
}

async function downloadVsix(fileName: string): Promise<string> {
	const url = new URL(fileName, GERRIT_UPDATE_BASE_URL).toString();
	const buffer = await got(url, {
		https: { rejectUnauthorized: rejectUnauthorized() },
	}).buffer();
	const vsixPath = path.join(os.tmpdir(), fileName);
	await fs.writeFile(vsixPath, buffer);
	return vsixPath;
}

async function promptManualDownload(fileName: string): Promise<void> {
	const url = new URL(fileName, GERRIT_UPDATE_BASE_URL).toString();
	const download = 'Download';
	const choice = await window.showWarningMessage(
		'A newer Gerrit extension version is available, but ' +
			'automatic installation failed. Download and install it manually.',
		download
	);
	if (choice === download) {
		await env.openExternal(Uri.parse(url));
	}
}

async function installAndReload(latest: VsixCandidate): Promise<void> {
	const vsixPath = await downloadVsix(latest.fileName);
	try {
		await commands.executeCommand(
			'workbench.extensions.installExtension',
			Uri.file(vsixPath)
		);
	} catch (e) {
		log(`Failed to install Gerrit update: ${(e as Error).toString()}`);
		await promptManualDownload(latest.fileName);
		return;
	}

	const reload = 'Reload now';
	const choice = await window.showInformationMessage(
		`Gerrit extension updated to v${latest.version}. Reload to apply.`,
		reload
	);
	if (choice === reload) {
		await commands.executeCommand('workbench.action.reloadWindow');
	}
}

export async function checkForUpdates(
	context: ExtensionContext
): Promise<void> {
	if (!autoUpdateEnabled()) {
		log('Self-update: disabled via gerrit.autoUpdate.enabled');
		return;
	}

	try {
		const html = await got(GERRIT_UPDATE_BASE_URL, {
			https: { rejectUnauthorized: rejectUnauthorized() },
		}).text();

		const latest = pickLatest(parseCandidates(html));
		if (!latest) {
			log('Self-update: no vsix candidates found on update server');
			return;
		}

		const packageJSON = context.extension.packageJSON as {
			version: string;
		};
		const current = packageJSON.version;
		if (!isNewer(latest.parts, toParts(current))) {
			return;
		}

		log(
			`Self-update: newer version v${latest.version} available ` +
				`(current v${current}), installing`
		);
		await installAndReload(latest);
	} catch (e) {
		log(`Self-update check failed: ${(e as Error).toString()}`);
	}
}
