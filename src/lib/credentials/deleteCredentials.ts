import {
	ConfigurationTarget,
	QuickPickItem,
	Uri,
	WorkspaceConfiguration,
	window,
	workspace,
} from 'vscode';
import { Repository } from '../../types/vscode-extension-git';
import { getConfigurationWithLegacy } from '../vscode/config';
import { getGerritURL } from './enterCredentials';
import { GerritSecrets } from './secrets';

type CredentialKind = 'password' | 'cookie';

interface KindPickItem extends QuickPickItem {
	credKind: CredentialKind | 'both';
}

const KIND_ITEMS: KindPickItem[] = [
	{
		label: 'Password',
		description: 'Stored HTTP password',
		credKind: 'password',
	},
	{
		label: 'Cookie / access token',
		description: 'Stored GerritAccount cookie or HTTP token',
		credKind: 'cookie',
	},
	{
		label: 'Both',
		description: 'Delete password and cookie for this URL/workspace',
		credKind: 'both',
	},
];

async function clearLegacyPlaintext(kind: CredentialKind): Promise<boolean> {
	const config = getConfigurationWithLegacy();
	const settingKey =
		kind === 'password' ? 'gerrit.auth.password' : 'gerrit.auth.cookie';
	const inspected = config.inspect(settingKey);
	const hadValue = !!(
		inspected?.globalValue ||
		inspected?.workspaceValue ||
		inspected?.workspaceFolderValue
	);
	if (!hadValue) {
		return false;
	}
	// Use the base WorkspaceConfiguration overload here: passing `undefined`
	// is the documented way to remove a setting, but the typed wrapper
	// from vscode-generate-package-json narrows the value type and rejects it.
	const base: WorkspaceConfiguration = config;
	if (inspected?.globalValue !== undefined) {
		await base.update(settingKey, undefined, ConfigurationTarget.Global);
	}
	if (inspected?.workspaceValue !== undefined) {
		await base.update(settingKey, undefined, ConfigurationTarget.Workspace);
	}
	if (inspected?.workspaceFolderValue !== undefined) {
		await base.update(
			settingKey,
			undefined,
			ConfigurationTarget.WorkspaceFolder
		);
	}
	return true;
}

async function deleteOne(
	kind: CredentialKind,
	url: string | undefined,
	workspaceUri: Uri | undefined
): Promise<{ kind: CredentialKind; secretRows: number; legacy: boolean }> {
	const secretRows = await GerritSecrets.deleteForUrlAndWorkspace(
		kind,
		url,
		workspaceUri
	);
	const legacy = await clearLegacyPlaintext(kind);
	return { kind, secretRows, legacy };
}

export async function deleteCredentials(gerritRepo: Repository): Promise<void> {
	const url = (await getGerritURL(gerritRepo)) ?? undefined;
	const workspaceUri = workspace.workspaceFolders?.[0].uri;

	if (!url && !workspaceUri) {
		await window.showWarningMessage(
			'Gerrit: no URL or workspace in scope; nothing to delete.'
		);
		return;
	}

	const pick = await window.showQuickPick(KIND_ITEMS, {
		title: 'Gerrit: Delete stored credentials',
		placeHolder: 'Which credential do you want to delete?',
		ignoreFocusOut: true,
	});
	if (!pick) {
		return;
	}

	const scopeBits: string[] = [];
	if (url) {
		scopeBits.push(`URL ${url}`);
	}
	if (workspaceUri) {
		scopeBits.push(`workspace ${workspaceUri.fsPath}`);
	}
	const confirmed = await window.showWarningMessage(
		`Delete ${pick.label.toLowerCase()} for ${scopeBits.join(' and ')}?`,
		{ modal: true },
		'Delete'
	);
	if (confirmed !== 'Delete') {
		return;
	}

	const kinds: CredentialKind[] =
		pick.credKind === 'both' ? ['password', 'cookie'] : [pick.credKind];
	const results = await Promise.all(
		kinds.map((k) => deleteOne(k, url, workspaceUri))
	);

	const totalSecretRows = results.reduce((sum, r) => sum + r.secretRows, 0);
	const legacyCleared = results.filter((r) => r.legacy).map((r) => r.kind);

	const parts: string[] = [];
	parts.push(
		totalSecretRows > 0
			? `removed ${totalSecretRows} stored secret${
					totalSecretRows === 1 ? '' : 's'
				}`
			: 'no stored secrets matched'
	);
	if (legacyCleared.length > 0) {
		parts.push(`cleared legacy ${legacyCleared.join('/')} from settings`);
	}
	await window.showInformationMessage(`Gerrit: ${parts.join('; ')}.`);
}
