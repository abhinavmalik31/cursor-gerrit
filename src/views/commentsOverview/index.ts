import {
	Uri,
	ViewColumn,
	window,
	workspace,
	commands as vscodeCommands,
	WebviewPanel,
	CommentThreadCollapsibleState,
	Range,
	Position,
	Selection,
	TextEditorRevealType,
} from 'vscode';
import {
	acceptMultipleSuggestions,
	SuggestionComment,
} from '../../lib/ai-review/commentFixer';
import {
	GerritComment,
	GerritDraftComment,
} from '../../lib/gerrit/gerritAPI/gerritComment';
import {
	GerritChange,
	CommentMap,
} from '../../lib/gerrit/gerritAPI/gerritChange';
import { FileTreeView } from '../activityBar/changes/changeTreeView/fileTreeView';
import { GerritFile } from '../../lib/gerrit/gerritAPI/gerritFile';
import { getAPIForSubscription } from '../../lib/gerrit/gerritAPI';
import {
	CommentManager,
	DocumentCommentManager,
} from '../../providers/commentProvider';
import { GerritAPIWith } from '../../lib/gerrit/gerritAPI/api';
import { buildHTML, OverviewComment, FileGroup } from './html';
import { Repository } from '../../types/vscode-extension-git';
import { log } from '../../lib/util/log';

let activePanel: WebviewPanel | null = null;
let activeChangeNumber: string = '';
let activeGerritRepo: Repository | null = null;
let activeChange: GerritChange | null = null;
let activePatchSetNumber: number = 0;
let activeExtensionPath: string = '';
let navigationInProgress = false;

export function setExtensionPath(path: string): void {
	activeExtensionPath = path;
}

export async function showCommentsOverview(
	changeNumber: string,
	gerritRepo: Repository
): Promise<void> {
	activeChangeNumber = changeNumber;
	activeGerritRepo = gerritRepo;

	if (activePanel) {
		activePanel.reveal(ViewColumn.One);
		await updatePanel(activePanel, changeNumber, gerritRepo);
		return;
	}

	const panel = window.createWebviewPanel(
		'gerritCommentsOverview',
		`Review Comments - Change ${changeNumber}`,
		ViewColumn.One,
		{ enableScripts: true }
	);

	activePanel = panel;
	panel.onDidDispose(() => {
		activePanel = null;
		activeChangeNumber = '';
		activeGerritRepo = null;
		activeChange = null;
		activePatchSetNumber = 0;
	});

	panel.webview.onDidReceiveMessage(
		async (msg: {
			command: string;
			filePath?: string;
			line?: number;
			patchSet?: number;
			comments?: Array<{
				filePath: string;
				line?: number;
				message: string;
				commentId: string;
			}>;
		}) => {
			if (msg.command === 'navigate' && activeGerritRepo) {
				await navigateToComment(
					msg.filePath ?? '',
					msg.line,
					msg.patchSet,
					activeGerritRepo
				);
			} else if (
				msg.command === 'acceptSuggestions' &&
				msg.comments &&
				activeGerritRepo
			) {
				const items: SuggestionComment[] = msg.comments.map((c) => ({
					filePath: c.filePath,
					line: c.line,
					message: c.message,
					commentId: c.commentId,
					changeID: activeChange?.changeID,
				}));
				await acceptMultipleSuggestions(
					items,
					activeGerritRepo,
					activeExtensionPath,
					activeChangeNumber
				);
			}
		}
	);

	await updatePanel(panel, changeNumber, gerritRepo);
}

async function updatePanel(
	panel: WebviewPanel,
	changeNumber: string,
	gerritRepo: Repository
): Promise<void> {
	const change = await GerritChange.getChangeOnce(changeNumber, [
		GerritAPIWith.ALL_REVISIONS,
		GerritAPIWith.ALL_FILES,
	]);
	if (!change) {
		panel.webview.html = buildHTML(changeNumber, [], [], []);
		return;
	}

	activeChange = change;

	const currentRevision = await change.getCurrentRevision();
	activePatchSetNumber = currentRevision?.number ?? 0;

	const commentsSub = await GerritChange.getAllComments(change.changeID);
	const commentsMap = await commentsSub.getValue();

	// Await cache warms so navigation never
	// needs to re-fetch under a different key.
	await warmCacheShortId(change.change_id);
	await warmChangeCacheShortId(change.change_id);

	// Warm change subscription with the exact
	// params createDiffCommand will use.
	await (await getAPIForSubscription())
		.getChange(change.changeID, null)
		.getValue();

	// Pre-fetch file diff content (old + new)
	// for every file with comments so that
	// createDiffCommand hits fileCache only.
	if (currentRevision) {
		await prefetchFileDiffContent(change, commentsMap, currentRevision);
	}

	const fileContents = await fetchFileContents(
		change,
		commentsMap,
		gerritRepo
	);

	const { draftGroups, unresolvedGroups, olderPatchsetGroups } =
		groupComments(commentsMap, fileContents, activePatchSetNumber);

	panel.webview.html = buildHTML(
		changeNumber,
		draftGroups,
		unresolvedGroups,
		olderPatchsetGroups
	);
}

/**
 * Warm the comments subscription cache under
 * the short Change-Id (Ixx) key so that
 * loadComments on local files (which resolves
 * changeID via getCurrentChangeIDCached) hits
 * the cache.
 */
async function warmCacheShortId(shortId: string): Promise<void> {
	try {
		const sub = await GerritChange.getAllComments(shortId);
		await sub.getValue();
	} catch {
		// ignore
	}
}

/**
 * Warm the change subscription cache under the
 * short Ixx key so that getFileFromOpenDocument
 * -> getCurrentChangeOnce hits the cache.
 */
async function warmChangeCacheShortId(shortId: string): Promise<void> {
	try {
		await GerritChange.getChangeOnce(shortId, [
			GerritAPIWith.CURRENT_REVISION,
			GerritAPIWith.CURRENT_FILES,
		]);
	} catch {
		// ignore
	}
}

/**
 * Pre-fetch old + new file content for every
 * file that has comments, populating fileCache
 * so createDiffCommand makes zero API calls.
 */
async function prefetchFileDiffContent(
	_change: GerritChange,
	commentsMap: CommentMap,
	currentRevision: { _files?: Record<string, GerritFile> | null }
): Promise<void> {
	const filePaths = Array.from(commentsMap.keys()).filter(
		(p) => p !== '/PATCHSET_LEVEL'
	);

	const filesMap = currentRevision._files;
	if (!filesMap) {
		return;
	}

	await Promise.all(
		filePaths.map(async (filePath) => {
			const file = filesMap[filePath];
			if (!file) {
				return;
			}
			try {
				await FileTreeView.getFileDiffContent(file, null);
			} catch {
				// ignore pre-fetch errors
			}
		})
	);
}

async function fetchFileContents(
	change: GerritChange,
	commentsMap: CommentMap,
	gerritRepo: Repository
): Promise<Map<string, string[]>> {
	const contents = new Map<string, string[]>();
	const filePaths = Array.from(commentsMap.keys()).filter(
		(p) => p !== '/PATCHSET_LEVEL'
	);

	const revision = await change.getCurrentRevision();
	if (!revision) {
		return contents;
	}

	const filesMap = await (await revision.files(null)).getValue();

	await Promise.all(
		filePaths.map(async (filePath) => {
			try {
				const localPath = Uri.joinPath(gerritRepo.rootUri, filePath);
				const doc = await workspace.openTextDocument(localPath);
				contents.set(filePath, doc.getText().split('\n'));
				return;
			} catch {
				// not checked out, try Gerrit API
			}

			try {
				const file = filesMap?.[filePath];
				if (!file) {
					return;
				}
				const textContent = await file.getNewContent();
				if (textContent) {
					contents.set(
						filePath,
						textContent.buffer.toString('utf8').split('\n')
					);
				}
			} catch {
				// ignore fetch errors
			}
		})
	);

	return contents;
}

function extractSnippet(
	fileLines: string[] | undefined,
	line: number | undefined
): string | undefined {
	if (!fileLines || !line || line < 1) {
		return undefined;
	}
	const idx = line - 1;
	const start = Math.max(0, idx - 1);
	const end = Math.min(fileLines.length, idx + 2);
	const snippet: string[] = [];
	for (let i = start; i < end; i++) {
		const prefix = i === idx ? '\u25b6 ' : '  ';
		snippet.push(`${prefix}${i + 1} | ${fileLines[i]}`);
	}
	return snippet.join('\n');
}

/**
 * Group a flat list of comments into threads
 * using inReplyTo chains. Returns a map of
 * root comment ID -> chronologically sorted
 * comment list.
 */
function buildThreads(
	comments: (GerritComment | GerritDraftComment)[]
): Map<string, (GerritComment | GerritDraftComment)[]> {
	const byId = new Map<string, GerritComment | GerritDraftComment>();
	for (const c of comments) {
		byId.set(c.id, c);
	}

	const rootOf = (c: GerritComment | GerritDraftComment): string => {
		let cur = c;
		while (cur.inReplyTo && byId.has(cur.inReplyTo)) {
			cur = byId.get(cur.inReplyTo)!;
		}
		return cur.id;
	};

	const threads = new Map<string, (GerritComment | GerritDraftComment)[]>();
	for (const c of comments) {
		const root = rootOf(c);
		if (!threads.has(root)) {
			threads.set(root, []);
		}
		threads.get(root)!.push(c);
	}

	for (const arr of threads.values()) {
		arr.sort((a, b) => a.updated.timestamp() - b.updated.timestamp());
	}

	return threads;
}

function groupComments(
	commentsMap: CommentMap,
	fileContents: Map<string, string[]>,
	currentPatchSetNumber: number
): {
	draftGroups: FileGroup[];
	unresolvedGroups: FileGroup[];
	olderPatchsetGroups: FileGroup[];
} {
	const draftsByFile = new Map<string, OverviewComment[]>();
	const unresolvedByFile = new Map<string, OverviewComment[]>();
	const olderPatchsetByFile = new Map<string, OverviewComment[]>();

	for (const [filePath, comments] of commentsMap) {
		const lines = fileContents.get(filePath);
		const threads = buildThreads(comments);

		for (const threadComments of threads.values()) {
			// Thread resolution is determined by the
			// last comment in the reply chain.
			const last = threadComments[threadComments.length - 1];
			// If unresolved is not explicitly true, the
			// thread is considered resolved.
			const threadUnresolved = last.unresolved === true;

			for (const c of threadComments) {
				const authorInfo = c.author;
				const isOlderPatchset =
					typeof c.patchSet === 'number' &&
					c.patchSet !== currentPatchSetNumber;

				const item: OverviewComment = {
					filePath,
					line: c.line,
					message: c.message ?? '',
					authorName: authorInfo?.name ?? 'You',
					updatedStr: c.updated
						? c.updated.format({
								dateStyle: 'short',
								timeStyle: 'short',
							})
						: '',
					isDraft: c.isDraft,
					unresolved: threadUnresolved,
					codeSnippet: extractSnippet(lines, c.line),
					patchSet: c.patchSet,
				};

				if (c.isDraft) {
					if (!draftsByFile.has(filePath)) {
						draftsByFile.set(filePath, []);
					}
					draftsByFile.get(filePath)!.push(item);
				} else if (threadUnresolved && isOlderPatchset) {
					if (!olderPatchsetByFile.has(filePath)) {
						olderPatchsetByFile.set(filePath, []);
					}
					olderPatchsetByFile.get(filePath)!.push(item);
				} else if (threadUnresolved) {
					if (!unresolvedByFile.has(filePath)) {
						unresolvedByFile.set(filePath, []);
					}
					unresolvedByFile.get(filePath)!.push(item);
				}
			}
		}
	}

	const toGroups = (map: Map<string, OverviewComment[]>): FileGroup[] =>
		Array.from(map.entries()).map(([filePath, comments]) => ({
			filePath,
			comments,
		}));

	return {
		draftGroups: toGroups(draftsByFile),
		unresolvedGroups: toGroups(unresolvedByFile),
		olderPatchsetGroups: toGroups(olderPatchsetByFile),
	};
}

/**
 * Resolve the GerritFile for a comment left on an
 * older patchset, loaded at that patchset's revision
 * so the original line numbers stay valid.
 *
 * When the path isn't in the patchset's changed-files
 * list, a GerritFile bound to that revision is
 * synthesized (its content still exists at the older
 * commit). Returns null only when the older commit
 * itself cannot be identified.
 */
async function resolveOlderPatchsetFile(
	change: GerritChange,
	filePath: string,
	patchSet: number
): Promise<GerritFile | null> {
	const revisions = await change.revisions();
	if (!revisions) {
		return null;
	}

	const olderRevision = Object.values(revisions).find(
		(r) => r.number === patchSet
	);
	if (!olderRevision) {
		return null;
	}

	const direct = olderRevision._files?.[filePath];
	if (direct) {
		return direct;
	}

	try {
		const filesSub = await olderRevision.files(null);
		const files = await filesSub.getValue();
		const fetched = files?.[filePath];
		if (fetched) {
			return fetched;
		}
	} catch {
		// Fall through and synthesize below.
	}

	// Gerrit's file list only includes files changed in this patchset,
	// but the path's content still exists at the older commit. Bind a
	// synthetic GerritFile to that revision so getContent() loads the
	// older commit's version by path@commit.
	return new GerritFile(
		change.changeID,
		change.project,
		{
			id: olderRevision.revisionID,
			number: olderRevision.number,
		},
		filePath,
		{
			lines_inserted: 0,
			lines_deleted: 0,
			size_delta: 0,
			size: 0,
			old_path: undefined,
		}
	);
}

type GerritRevision = NonNullable<
	Awaited<ReturnType<GerritChange['getCurrentRevision']>>
>;

interface NavigationTarget {
	readonly file: GerritFile;
	// The comment thread widget renders at the END of a range comment
	// (the comment's `line`), so this is the line to reveal.
	readonly lineToJump: number | undefined;
}

// Resolve which GerritFile to open and which line to reveal. Older
// patchset comments open at the patchset they were left on, where the
// path always exists and the original line numbers stay valid, so later
// renames/deletes are irrelevant. Returns null only when the older
// commit cannot be identified.
async function resolveNavigationTarget(
	change: GerritChange,
	currentRevision: GerritRevision,
	filePath: string,
	line: number | undefined,
	patchSet: number | undefined
): Promise<NavigationTarget | null> {
	const isOlderPatchset =
		typeof patchSet === 'number' &&
		activePatchSetNumber > 0 &&
		patchSet !== activePatchSetNumber;

	if (isOlderPatchset && typeof patchSet === 'number') {
		const olderFile = await resolveOlderPatchsetFile(
			change,
			filePath,
			patchSet
		);
		if (!olderFile) {
			void window.showWarningMessage(
				`Cannot navigate to comment: patchset ${patchSet} of "${filePath}" could not be loaded.`
			);
			return null;
		}
		return { file: olderFile, lineToJump: line };
	}

	const file =
		currentRevision._files?.[filePath] ??
		new GerritFile(
			change.changeID,
			change.project,
			{
				id: currentRevision.revisionID,
				number: currentRevision.number,
			},
			filePath,
			{
				lines_inserted: 0,
				lines_deleted: 0,
				size_delta: 0,
				size: 0,
				old_path: undefined,
			}
		);

	return { file, lineToJump: line };
}

// Place the cursor on the comment line and center it. `revealLine`
// only scrolls and leaves the cursor on whatever line it was on, so
// we set the selection directly when an editor is available.
async function revealCommentLine(lineToJump: number): Promise<void> {
	await vscodeCommands.executeCommand(
		'workbench.action.focusActiveEditorGroup'
	);
	const editor = window.activeTextEditor;
	const pos = new Position(lineToJump - 1, 0);
	if (editor) {
		editor.selection = new Selection(pos, pos);
		editor.revealRange(
			new Range(pos, pos),
			TextEditorRevealType.InCenter
		);
		return;
	}
	await vscodeCommands.executeCommand('revealLine', {
		lineNumber: lineToJump - 1,
		at: 'center',
	});
}

// Wait for provideCommentingRanges to create a DocumentCommentManager
// for one of the diff URIs, then load comments only if its threads
// aren't already populated. Reloading disposes and recreates every
// thread widget, causing the target comment to flicker.
async function ensureCommentsLoaded(
	leftUri: Uri,
	rightUri: Uri
): Promise<void> {
	const findMgr = (): DocumentCommentManager | null =>
		CommentManager.getFileManagerForUri(rightUri) ??
		CommentManager.getFileManagerForUri(leftUri);

	let loadedMgr = findMgr();
	for (let i = 0; !loadedMgr && i < 30; i++) {
		await new Promise((r) => setTimeout(r, 50));
		loadedMgr = findMgr();
	}

	if (loadedMgr && loadedMgr.createdThreads.size === 0) {
		await loadedMgr.loadComments();
	}
}

// Expand the comment thread(s) covering the target line and keep that
// line centered while VSCode reveals the (initially expanded) widgets,
// which would otherwise scroll it out of view.
function expandAndKeepInView(
	changeID: string,
	leftUri: Uri,
	rightUri: Uri,
	lineToJump: number
): void {
	const target0 = lineToJump - 1;
	// URI of the diff pane that actually hosts the matched thread
	// widget. The corrector must only manage this pane; reacting to
	// both panes creates a scroll feedback loop (each pane's
	// sync-scroll re-triggers the other).
	let hostUri: string | null = null;

	const expandAtLine = (mgr: DocumentCommentManager | null): void => {
		if (!mgr) {
			return;
		}
		for (const t of mgr.createdThreads) {
			if (
				t.range.start.line <= target0 &&
				target0 <= t.range.end.line
			) {
				t.collapsibleState =
					CommentThreadCollapsibleState.Expanded;
				const tUri = t.uri.toString();
				if (
					hostUri === null &&
					(tUri === rightUri.toString() ||
						tUri === leftUri.toString())
				) {
					hostUri = tUri;
				}
			}
		}
	};

	expandAtLine(CommentManager.getFileManagerForUri(rightUri));
	expandAtLine(CommentManager.getFileManagerForUri(leftUri));
	for (const m of CommentManager.getFileManagersForChangeID(changeID)) {
		expandAtLine(m);
	}

	// Falling back to the right pane preserves prior behavior when no
	// diff-pane thread matched.
	const hUri = hostUri ?? rightUri.toString();
	let corrections = 0;
	const corrector = window.onDidChangeTextEditorVisibleRanges((e) => {
		if (e.textEditor.document.uri.toString() !== hUri) {
			return;
		}
		const visible = e.textEditor.visibleRanges.some(
			(r) => r.start.line <= target0 && target0 <= r.end.line
		);
		if (visible || corrections >= 30) {
			return;
		}
		corrections++;
		e.textEditor.revealRange(
			new Range(target0, 0, target0, 0),
			TextEditorRevealType.InCenter
		);
	});
	setTimeout(() => corrector.dispose(), 4000);
}

async function navigateToComment(
	filePath: string,
	line: number | undefined,
	patchSet: number | undefined,
	gerritRepo: Repository
): Promise<void> {
	if (filePath === '/PATCHSET_LEVEL') {
		return;
	}

	// Guard against duplicate dispatches opening multiple diffs into
	// the same preview tab, which races/disposes the rendered thread.
	if (navigationInProgress) {
		return;
	}
	navigationInProgress = true;

	try {
		const change = activeChange;
		if (!change) {
			log('navigateToComment: no cached change');
			return;
		}

		const currentRevision = await change.getCurrentRevision();
		if (!currentRevision) {
			log('navigateToComment: revision not found');
			return;
		}

		const target = await resolveNavigationTarget(
			change,
			currentRevision,
			filePath,
			line,
			patchSet
		);
		if (!target) {
			return;
		}
		const { file, lineToJump } = target;

		// Force the virtual patchset file on the right side so the
		// gerrit comment threads render through the FileMeta-backed
		// manager (like the normal review diff). A local on-disk
		// right side has no FileMeta and the threads do not surface.
		const diffCmd = await FileTreeView.createDiffCommand(
			gerritRepo,
			file,
			null,
			true
		);
		if (!diffCmd?.arguments) {
			log('navigateToComment: diff command failed for ' + filePath);
			return;
		}

		const [leftUri, rightUri] = diffCmd.arguments as [Uri, Uri];

		await vscodeCommands.executeCommand(
			diffCmd.command,
			...(diffCmd.arguments as unknown[])
		);

		if (lineToJump) {
			await revealCommentLine(lineToJump);
		}

		await ensureCommentsLoaded(leftUri, rightUri);

		if (lineToJump) {
			expandAndKeepInView(
				change.changeID,
				leftUri,
				rightUri,
				lineToJump
			);
		}
	} catch (e) {
		log('Failed to navigate to comment: ' + String(e));
	} finally {
		navigationInProgress = false;
	}
}
