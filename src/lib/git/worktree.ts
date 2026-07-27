import * as path from 'path';

const WORKTREE_PREFIX = 'worktree ';
const TARGET_BRANCH_SUFFIX = '-master';

/**
 * Compare filesystem paths after resolving relative segments.
 */
export function arePathsEqual(firstPath: string, secondPath: string): boolean {
	return (
		path.relative(path.resolve(firstPath), path.resolve(secondPath)) === ''
	);
}

/**
 * Parse worktree paths from the null-delimited output produced by
 * `git worktree list --porcelain -z`.
 */
export function parseWorktreePaths(output: string): string[] {
	return output
		.split('\0')
		.filter((field) => field.startsWith(WORKTREE_PREFIX))
		.map((field) => field.substring(WORKTREE_PREFIX.length));
}

export function normalizeBranchName(branch: string): string {
	return branch.trim().replace(/^refs\/heads\//, '');
}

/**
 * Return whether a candidate path is the given folder or one of its
 * descendants.
 */
export function isPathWithinFolder(
	folderPath: string,
	candidatePath: string
): boolean {
	const relativePath = path.relative(
		path.resolve(folderPath),
		path.resolve(candidatePath)
	);
	return (
		relativePath === '' ||
		(relativePath !== '..' &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath))
	);
}

export function getChildWorktreePaths(
	rootPath: string,
	worktreePaths: readonly string[]
): string[] {
	return worktreePaths.filter(
		(worktreePath) =>
			!arePathsEqual(rootPath, worktreePath) &&
			isPathWithinFolder(rootPath, worktreePath)
	);
}

export function getWorktreeFolderForTargetBranch(
	targetBranch: string
): string | null {
	const normalizedTarget = normalizeBranchName(targetBranch);
	const folderName =
		normalizedTarget === 'master'
			? 'main'
			: normalizedTarget.endsWith(TARGET_BRANCH_SUFFIX)
				? normalizedTarget.substring(
						0,
						normalizedTarget.length - TARGET_BRANCH_SUFFIX.length
					)
				: null;
	if (
		!folderName ||
		folderName === '.' ||
		folderName === '..' ||
		path.basename(folderName) !== folderName
	) {
		return null;
	}
	return folderName;
}

export function findWorktreePathsForTargetBranch(
	targetBranch: string,
	worktreePaths: readonly string[]
): string[] {
	const folderName = getWorktreeFolderForTargetBranch(targetBranch);
	if (!folderName) {
		return [];
	}
	return worktreePaths.filter(
		(worktreePath) => path.basename(worktreePath) === folderName
	);
}
