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
import { Repository } from '../../types/vscode-extension-git';
import { tryExecAsync, tryExecFileAsync } from './gitCLI';
import { RepositoryContext } from './repositoryContext';
import { getConfiguration } from '../vscode/config';

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
	repositoryPath?: string;
}

async function readQuickCheckouts(): Promise<QuickCheckoutApplyInfo[]> {
	return await storageGet('quickCheckoutStashes', StorageScope.WORKSPACE, []);
}

async function saveQuickCheckouts(
	entries: readonly QuickCheckoutApplyInfo[]
): Promise<void> {
	await storageSet(
		'quickCheckoutStashes',
		[...entries],
		StorageScope.WORKSPACE
	);
	await APISubscriptionManager.quickCheckoutSubscriptions.invalidate({});
}

async function getRestoreRef(
	gerritRepo: Repository,
	currentBranch: string
): Promise<string | null> {
	if (currentBranch !== 'HEAD') {
		return currentBranch;
	}
	const result = await tryExecFileAsync('git', ['rev-parse', 'HEAD'], {
		cwd: gerritRepo.rootUri.fsPath,
		silent: true,
	});
	return result.success && result.stdout.trim() ? result.stdout.trim() : null;
}

export async function quickCheckout(
	repositoryContext: RepositoryContext,
	changeTreeView: ChangeTreeView
): Promise<boolean> {
	const change = await changeTreeView.change;
	if (!change) {
		void window.showErrorMessage('Failed to get change');
		return false;
	}
	const resolution = await repositoryContext.resolveWorktreeForBranch(
		change.branch
	);
	if (resolution.kind === 'notFound') {
		void window.showErrorMessage(
			`No worktree tracks target branch "${resolution.targetBranch}"`
		);
		return false;
	}
	if (resolution.kind === 'ambiguous') {
		void window.showErrorMessage(
			'Multiple worktrees track target branch ' +
				`"${resolution.targetBranch}": ` +
				resolution.worktreePaths.join(', ')
		);
		return false;
	}
	if (resolution.kind === 'openFailed') {
		void window.showErrorMessage(
			`Failed to open worktree ${resolution.worktreePath}`
		);
		return false;
	}
	const gerritRepo = resolution.repository;
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
				gerritRepo.rootUri.fsPath,
				true
			));

			const currentBranch = await getCurrentBranch(gerritRepo);
			if (token.isCancellationRequested) {
				return false;
			}
			if (!currentBranch) {
				void window.showErrorMessage('Failed to get current branch');
				return false;
			}
			const restoreRef = await getRestoreRef(gerritRepo, currentBranch);
			if (!restoreRef) {
				void window.showErrorMessage(
					'Failed to record the current Git revision'
				);
				return false;
			}

			const applyInfo: QuickCheckoutApplyInfo = {
				originalBranch: restoreRef,
				at: new Date().getTime(),
				id: generateRandomString(),
				repositoryPath: gerritRepo.rootUri.fsPath,
			};
			progress.report({
				message: 'Creating stash',
				increment: 5,
			});
			if (hasChanges) {
				const stashName =
					`${restoreRef} - ` + new Date().toLocaleTimeString();
				if (
					token.isCancellationRequested ||
					!(await createStash(gerritRepo.rootUri.fsPath, stashName))
				) {
					return false;
				}

				applyInfo.stashName = stashName;
			}

			progress.report({
				message: 'Storing quick-checkout',
				increment: 45,
			});
			const stashes = await readQuickCheckouts();
			await saveQuickCheckouts(
				uniqueComplex([...stashes, applyInfo], (e) =>
					quickCheckoutEntryToKey(e)
				)
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
				gerritRepo.rootUri.fsPath
			);
			if (!result.success) {
				void window.showErrorMessage('Failed to checkout change');
				return false;
			}
			repositoryContext.setActiveRepository(gerritRepo);

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
		readQuickCheckouts
	);
}

async function getStoredRepository(
	repositoryContext: RepositoryContext,
	info: QuickCheckoutApplyInfo
): Promise<Repository | null> {
	if (!info.repositoryPath) {
		return repositoryContext.getActiveRepository();
	}
	const repository = await repositoryContext.openRepositoryAtPath(
		info.repositoryPath
	);
	if (!repository) {
		void window.showErrorMessage(
			`Failed to open quick-checkout worktree ${info.repositoryPath}`
		);
	}
	return repository;
}

export async function dropQuickCheckout(
	repositoryContext: RepositoryContext,
	treeItem: QuickCheckoutTreeEntry
): Promise<void> {
	const gerritRepo = await getStoredRepository(
		repositoryContext,
		treeItem.info
	);
	if (!gerritRepo) {
		return;
	}
	// Drop the stash first
	if (
		treeItem.info.stashName &&
		!(await dropStash(gerritRepo.rootUri.fsPath, treeItem.info.stashName))
	) {
		void window.showErrorMessage(
			'Failed to drop stash, see log for details'
		);
		return;
	}

	const stashes = await readQuickCheckouts();
	await saveQuickCheckouts(
		stashes.filter((stash) => stash.id !== treeItem.info.id)
	);
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

export async function dropQuickCheckouts(
	repositoryContext: RepositoryContext
): Promise<void> {
	const stashes = await readQuickCheckouts();

	const shouldDropStashes = await shouldDropAllStashes();
	if (shouldDropStashes === null) {
		return;
	}
	if (shouldDropStashes) {
		let failures: number = 0;
		await Promise.all(
			stashes.map(async (stash) => {
				if (stash.stashName) {
					const gerritRepo = await getStoredRepository(
						repositoryContext,
						stash
					);
					if (
						!gerritRepo ||
						!(await dropStash(
							gerritRepo.rootUri.fsPath,
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

	await saveQuickCheckouts([]);
}

async function applyQuickCheckoutShared(
	gerritRepo: Repository,
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
		!(await ensureCleanWorkingTree(gerritRepo.rootUri.fsPath)) ||
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
		!(
			await tryExecFileAsync('git', ['checkout', info.originalBranch], {
				cwd: gerritRepo.rootUri.fsPath,
			})
		).success
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
		if (!(await applyGitStash(gerritRepo.rootUri.fsPath, info.stashName))) {
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
	repositoryContext: RepositoryContext,
	treeItem: QuickCheckoutTreeEntry
): Promise<void> {
	const gerritRepo = await getStoredRepository(
		repositoryContext,
		treeItem.info
	);
	if (!gerritRepo) {
		return;
	}
	await window.withProgress(
		{
			location: ProgressLocation.Notification,
			cancellable: true,
			title: `Applying quick checkout to branch ${treeItem.info.originalBranch}`,
		},
		async (progress, token) => {
			if (
				!(await applyQuickCheckoutShared(
					gerritRepo,
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
			const stashes = await readQuickCheckouts();
			const match = stashes.find((s) => s.id === treeItem.info.id);
			if (match) {
				match.used = true;
			}
			await saveQuickCheckouts(stashes);
			repositoryContext.setActiveRepository(gerritRepo);

			progress.report({
				increment: 10,
				message: 'Done',
			});
			return;
		}
	);
}

export async function popQuickCheckout(
	repositoryContext: RepositoryContext,
	treeItem: QuickCheckoutTreeEntry | QuickCheckoutApplyInfo
): Promise<void> {
	const info = 'info' in treeItem ? treeItem.info : treeItem;
	const gerritRepo = await getStoredRepository(repositoryContext, info);
	if (!gerritRepo) {
		return;
	}
	await window.withProgress(
		{
			location: ProgressLocation.Notification,
			cancellable: true,
			title: `Popping quick checkout on branch ${info.originalBranch}`,
		},
		async (progress, token) => {
			if (
				!(await applyQuickCheckoutShared(
					gerritRepo,
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
					!(await dropStash(
						gerritRepo.rootUri.fsPath,
						info.stashName
					)) ||
					token.isCancellationRequested
				) {
					return;
				}
			}

			// Now drop it
			const stashes = await readQuickCheckouts();
			await saveQuickCheckouts(
				stashes.filter((stash) => stash.id !== info.id)
			);
			repositoryContext.setActiveRepository(gerritRepo);

			progress.report({
				increment: 10,
				message: 'Done',
			});
		}
	);
}
