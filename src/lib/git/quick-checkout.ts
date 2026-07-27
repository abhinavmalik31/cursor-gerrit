import {
	createStash,
	dropStash,
	ensureCleanWorkingTree,
	findStash,
	getChangeIDFromCheckoutString,
	getCurrentBranch,
	gitFetchAndCheckoutChange,
} from './git';
import {
	CancellationToken,
	ConfigurationTarget,
	Progress,
	ProgressLocation,
	window,
} from 'vscode';
import {
	APISubscriptionManager,
	Subscribable,
} from '../subscriptions/subscriptions';
import { quickCheckoutEntryToKey } from '../../views/statusBar/quickCheckoutStatusBar';
import { ChangeTreeView } from '../../views/activityBar/changes/changeTreeView';
import { QuickCheckoutTreeEntry } from '../../views/activityBar/quickCheckout';
import { storageGet, StorageScope, storageSet } from '../vscode/storage';
import { generateRandomString, uniqueComplex } from '../util/util';
import { resolveWorktreePath } from './viewtop';
import { getConfiguration } from '../vscode/config';
import { tryExecAsync } from './gitCLI';

export async function applyGitStash(
	uri: string,
	stashName: string
): Promise<boolean> {
	const stash = await findStash(uri, stashName, 'application of stash');
	if (typeof stash === 'boolean') {
		return stash;
	}

	const { success } = await tryExecAsync(`git stash apply "${stash}"`, {
		cwd: uri,
	});
	if (!success) {
		void window.showErrorMessage(
			'Failed to apply stash, see log for details'
		);
		return false;
	}
	return true;
}

export interface QuickCheckoutApplyInfo {
	originalBranch: string;
	stashName?: string;
	at: number;
	used?: boolean;
	id: string;
	/**
	 * Worktree the checkout was performed in. Absent for entries created
	 * before viewtop support existed, in which case the active repository is
	 * used as a fallback.
	 */
	repositoryPath?: string;
}

/**
 * Resolve the worktree a stored quick-checkout entry belongs to, falling back
 * to the active repository for entries created before 'repositoryPath' was
 * recorded.
 */
function getStoredRepoPath(
	repoPath: string,
	info: QuickCheckoutApplyInfo
): string {
	return info.repositoryPath ?? repoPath;
}

export async function quickCheckout(
	repoPath: string,
	changeTreeView: ChangeTreeView
): Promise<boolean> {
	const change = await changeTreeView.change;
	if (!change) {
		void window.showErrorMessage('Failed to get change');
		return false;
	}
	const worktreePath = await resolveWorktreePath(repoPath, change.branch);
	if (!worktreePath) {
		void window.showErrorMessage(
			`No worktree tracks target branch "${change.branch}"`
		);
		return false;
	}
	const result = await window.withProgress(
		{
			location: ProgressLocation.Notification,
			cancellable: true,
			title: `Quick-checkout change ${change.number}`,
		},
		async (progress, token): Promise<boolean> => {
			// Check if we have any working tree changes at all. If not, no
			// need to stash
			progress.report({
				message: 'Checking working tree',
				increment: 0,
			});
			const hasChanges = !(await ensureCleanWorkingTree(
				worktreePath,
				true
			));

			const currentBranch = await getCurrentBranch(worktreePath);
			if (token.isCancellationRequested) {
				return false;
			}
			if (!currentBranch) {
				void window.showErrorMessage('Failed to get current branch');
				return false;
			}

			const applyInfo: QuickCheckoutApplyInfo = {
				originalBranch: currentBranch,
				at: new Date().getTime(),
				id: generateRandomString(),
				repositoryPath: worktreePath,
			};
			progress.report({
				message: 'Creating stash',
				increment: 5,
			});
			if (hasChanges) {
				const stashName = `${currentBranch} - ${new Date().toLocaleTimeString()}`;
				if (
					token.isCancellationRequested ||
					!(await createStash(worktreePath, stashName))
				) {
					return false;
				}

				applyInfo.stashName = stashName;
			}

			progress.report({
				message: 'Storing quick-checkout',
				increment: 45,
			});
			const stashes = await storageGet(
				'quickCheckoutStashes',
				StorageScope.WORKSPACE,
				[]
			);
			await storageSet(
				'quickCheckoutStashes',
				uniqueComplex([...stashes, applyInfo], (e) =>
					quickCheckoutEntryToKey(e)
				),
				StorageScope.WORKSPACE
			);
			await APISubscriptionManager.quickCheckoutSubscriptions.invalidate(
				{}
			);
			if (token.isCancellationRequested) {
				return false;
			}

			progress.report({
				message: 'Checking out change',
				increment: 5,
			});
			const changeNum = getChangeIDFromCheckoutString(
				changeTreeView.initialChange.changeID
			);
			const result = await gitFetchAndCheckoutChange(
				changeNum,
				'latest',
				'origin',
				worktreePath
			);
			if (!result.success) {
				void window.showErrorMessage('Failed to checkout change');
				return false;
			}

			progress.report({
				message: 'Done',
				increment: 45,
			});
			void window.showInformationMessage('Checked out change');
			return true;
		}
	);
	return result ?? false;
}

export function getQuickCheckoutSubscribable(): Subscribable<
	QuickCheckoutApplyInfo[]
> {
	return APISubscriptionManager.quickCheckoutSubscriptions.createFetcher(
		{},
		async () => {
			return await storageGet(
				'quickCheckoutStashes',
				StorageScope.WORKSPACE,
				[]
			);
		}
	);
}

export async function dropQuickCheckout(
	repoPath: string,
	treeItem: QuickCheckoutTreeEntry
): Promise<void> {
	const worktreePath = getStoredRepoPath(repoPath, treeItem.info);
	// Drop the stash first
	if (
		treeItem.info.stashName &&
		!(await dropStash(worktreePath, treeItem.info.stashName))
	) {
		void window.showErrorMessage(
			'Failed to drop stash, see log for details'
		);
		return;
	}

	const stashes = await storageGet(
		'quickCheckoutStashes',
		StorageScope.WORKSPACE,
		[]
	);
	await storageSet(
		'quickCheckoutStashes',
		stashes.filter((s) => s.id !== treeItem.info.id),
		StorageScope.WORKSPACE
	);

	await APISubscriptionManager.quickCheckoutSubscriptions.invalidate({});
}

async function shouldDropAllStashes(): Promise<boolean | null> {
	if (!(await storageGet('askedDropAllStashes', StorageScope.GLOBAL))) {
		// Not asket yet, ask them
		const ALWAYS_DROP_OPTION = 'Yes (always)';
		const NOW_DROP_OPTION = 'Yes (once)';
		const NEVER_DROP_OPTION = 'No (always)';
		const NOT_NOW_DROP_OPTION = 'No (once)';
		const result = await window.showInformationMessage(
			'Do you want to drop all git stashes as well?',
			ALWAYS_DROP_OPTION,
			NOW_DROP_OPTION,
			NEVER_DROP_OPTION,
			NOT_NOW_DROP_OPTION
		);

		if (result === ALWAYS_DROP_OPTION) {
			await storageSet('askedDropAllStashes', true, StorageScope.GLOBAL);
			await getConfiguration().update(
				'gerrit.quickCheckout.dropAllStashes',
				true,
				ConfigurationTarget.Global
			);
			return true;
		} else if (result === NOW_DROP_OPTION) {
			return true;
		} else if (result === NEVER_DROP_OPTION) {
			await storageSet('askedDropAllStashes', true, StorageScope.GLOBAL);
			await getConfiguration().update(
				'gerrit.quickCheckout.dropAllStashes',
				false,
				ConfigurationTarget.Global
			);
			return false;
		} else if (result === NOT_NOW_DROP_OPTION) {
			return false;
		}

		return null;
	}

	return getConfiguration().get('gerrit.quickCheckout.dropAllStashes', false);
}

export async function dropQuickCheckouts(repoPath: string): Promise<void> {
	const stashes = await storageGet(
		'quickCheckoutStashes',
		StorageScope.WORKSPACE,
		[]
	);

	const shouldDropStashes = await shouldDropAllStashes();
	if (shouldDropStashes === null) {
		return;
	}
	if (shouldDropStashes) {
		let failures: number = 0;
		await Promise.all(
			stashes.map(async (stash) => {
				if (stash.stashName) {
					if (
						!(await dropStash(
							getStoredRepoPath(repoPath, stash),
							stash.stashName
						))
					) {
						failures++;
					}
				}
			})
		);

		if (failures > 0) {
			return;
		}
	}

	await storageSet('quickCheckoutStashes', [], StorageScope.WORKSPACE);
	await APISubscriptionManager.quickCheckoutSubscriptions.invalidate({});
}

async function applyQuickCheckoutShared(
	worktreePath: string,
	info: QuickCheckoutApplyInfo,
	progress: Progress<{
		message?: string | undefined;
		increment?: number | undefined;
	}>,
	token: CancellationToken
): Promise<boolean> {
	progress.report({
		increment: 0,
		message: 'Checking if working tree is clean',
	});
	if (
		!(await ensureCleanWorkingTree(worktreePath)) ||
		token.isCancellationRequested
	) {
		return false;
	}
	progress.report({
		increment: 10,
	});

	progress.report({
		message: 'Checking out branch',
	});
	// First check out branch
	if (
		!(await tryExecAsync(`git checkout ${info.originalBranch}`, {
			cwd: worktreePath,
		}))
	) {
		void window.showErrorMessage('Failed to checkout branch');
		return false;
	}
	if (token.isCancellationRequested) {
		return false;
	}

	// Then apply stash
	if (info.stashName) {
		progress.report({
			increment: 40,
			message: 'Applying stash',
		});
		if (!(await applyGitStash(worktreePath, info.stashName))) {
			return false;
		}
		progress.report({
			increment: 40,
		});
	} else {
		progress.report({
			increment: 80,
		});
	}

	return true;
}

export async function applyQuickCheckout(
	repoPath: string,
	treeItem: QuickCheckoutTreeEntry
): Promise<void> {
	const worktreePath = getStoredRepoPath(repoPath, treeItem.info);
	await window.withProgress(
		{
			location: ProgressLocation.Notification,
			cancellable: true,
			title: `Applying quick checkout to branch ${treeItem.info.originalBranch}`,
		},
		async (progress, token) => {
			if (
				!(await applyQuickCheckoutShared(
					worktreePath,
					treeItem.info,
					progress,
					token
				))
			) {
				return;
			}

			progress.report({
				message: 'Updating storage',
			});
			// Then mark as used and store
			const stashes = await storageGet(
				'quickCheckoutStashes',
				StorageScope.WORKSPACE,
				[]
			);
			const match = stashes.find((s) => s.id === treeItem.info.id)!;
			match.used = true;
			await storageSet(
				'quickCheckoutStashes',
				stashes,
				StorageScope.WORKSPACE
			);

			await APISubscriptionManager.quickCheckoutSubscriptions.invalidate(
				{}
			);

			progress.report({
				increment: 10,
				message: 'Done',
			});
			return;
		}
	);
}

export async function popQuickCheckout(
	repoPath: string,
	treeItem: QuickCheckoutTreeEntry | QuickCheckoutApplyInfo
): Promise<void> {
	const info = 'info' in treeItem ? treeItem.info : treeItem;
	const worktreePath = getStoredRepoPath(repoPath, info);
	await window.withProgress(
		{
			location: ProgressLocation.Notification,
			cancellable: true,
			title: `Popping quick checkout on branch ${info.originalBranch}`,
		},
		async (progress, token) => {
			if (
				!(await applyQuickCheckoutShared(
					worktreePath,
					info,
					progress,
					token
				)) ||
				token.isCancellationRequested
			) {
				return;
			}

			progress.report({
				message: 'Dropping stash',
			});
			if (info.stashName) {
				if (
					!(await dropStash(worktreePath, info.stashName)) ||
					token.isCancellationRequested
				) {
					return;
				}
			}

			// Now drop it
			const stashes = await storageGet(
				'quickCheckoutStashes',
				StorageScope.WORKSPACE,
				[]
			);
			await storageSet(
				'quickCheckoutStashes',
				stashes.filter((s) => s.id === info.id),
				StorageScope.WORKSPACE
			);

			await APISubscriptionManager.quickCheckoutSubscriptions.invalidate(
				{}
			);

			progress.report({
				increment: 10,
				message: 'Done',
			});
		}
	);
}
