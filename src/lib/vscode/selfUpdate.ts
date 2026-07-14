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
	/**
	 * `<platform>-<arch>` (e.g. `darwin-arm64`), or `undefined` for a legacy
	 * platform-agnostic file that predates multi-platform packaging.
	 */
	readonly platform: string | undefined;
}

const VSIX_FILE_PATTERN =
	/cursor--gerrit-(\d+\.\d+\.\d+)(?:-([a-z0-9]+-[a-z0-9]+))?\.vsix/g;

/** The `<platform>-<arch>` VSIX target that matches this running client. */
function currentTarget(): string {
	return `${process.platform}-${process.arch}`;
}

function toParts(version: string): number[] {
	return version.split('.').map((part) => parseInt(part, 10));
}

function isSameVersion(a: readonly number[], b: readonly number[]): boolean {
	return !isNewer(a, b) && !isNewer(b, a);
}

/**
 * A candidate is installable if it targets this client's platform, or if it
 * is a legacy suffix-less build (kept as a fallback for older releases).
 */
function isCompatible(candidate: VsixCandidate): boolean {
	return (
		candidate.platform === undefined ||
		candidate.platform === currentTarget()
	);
}

function isNewer(remote: readonly number[], local: readonly number[]): boolean {
	for (let i = 0; i < 3; i++) {
		if ((remote[i] ?? 0) !== (local[i] ?? 0)) {
			return (remote[i] ?? 0) > (local[i] ?? 0);
		}
	}
	return false;
}

function updateBaseUrl(): string {
	return (
		getConfiguration().get('gerrit.autoUpdate.url', '') ||
		GERRIT_UPDATE_BASE_URL
	);
}

function autoUpdateEnabled(): boolean {
	return getConfiguration().get('gerrit.autoUpdate.enabled', false);
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
			platform: match[2],
		});
	}
	return candidates;
}

function pickLatest(candidates: VsixCandidate[]): VsixCandidate | null {
	let latest: VsixCandidate | null = null;
	for (const candidate of candidates) {
		if (!isCompatible(candidate)) {
			continue;
		}
		if (!latest || isNewer(candidate.parts, latest.parts)) {
			latest = candidate;
			continue;
		}
		// Same version: prefer a platform-specific build over a legacy
		// suffix-less one.
		if (
			isSameVersion(candidate.parts, latest.parts) &&
			candidate.platform !== undefined &&
			latest.platform === undefined
		) {
			latest = candidate;
		}
	}
	return latest;
}

async function downloadVsix(fileName: string): Promise<string> {
	const url = new URL(fileName, updateBaseUrl()).toString();
	const buffer = await got(url, {
		https: { rejectUnauthorized: false },
	}).buffer();
	const vsixPath = path.join(os.tmpdir(), fileName);
	await fs.writeFile(vsixPath, buffer);
	return vsixPath;
}

async function promptManualDownload(fileName: string): Promise<void> {
	const url = new URL(fileName, updateBaseUrl()).toString();
	const download = 'Download';
	const message =
		'A newer Gerrit extension version is available, but ' +
		'automatic installation failed. Download and install it manually.';
	const choice = await window.showWarningMessage(message, download);
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
	} finally {
		// Best-effort cleanup; the vsix is only needed during install.
		await fs.rm(vsixPath, { force: true }).catch(() => {});
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

async function promptUpdateAvailable(latest: VsixCandidate): Promise<void> {
	const update = 'Update now';
	const message =
		`A newer Gerrit extension version (v${latest.version}) is ` +
		'available. Install it now?';
	const choice = await window.showInformationMessage(message, update);
	if (choice === update) {
		await installAndReload(latest);
	}
}

export async function checkForUpdates(
	context: ExtensionContext
): Promise<void> {
	try {
		const html = await got(updateBaseUrl(), {
			https: { rejectUnauthorized: false },
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

		if (autoUpdateEnabled()) {
			log(
				`Self-update: newer version v${latest.version} available ` +
					`(current v${current}), installing`
			);
			await installAndReload(latest);
		} else {
			log(
				`Self-update: newer version v${latest.version} available ` +
					`(current v${current}), prompting (auto-update off)`
			);
			await promptUpdateAvailable(latest);
		}
	} catch (e) {
		log(`Self-update check failed: ${(e as Error).toString()}`);
	}
}
