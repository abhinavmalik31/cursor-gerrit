import {
  Uri,
  ViewColumn,
  window,
  workspace,
  commands as vscodeCommands,
  WebviewPanel,
} from 'vscode';
import { Repository } from '../../types/vscode-extension-git';
import {
  GerritChange,
  CommentMap,
} from '../../lib/gerrit/gerritAPI/gerritChange';
import {
  GerritAPIWith,
} from '../../lib/gerrit/gerritAPI/api';
import {
  FileTreeView,
} from '../activityBar/changes/changeTreeView/fileTreeView';
import {
  GerritFile,
} from '../../lib/gerrit/gerritAPI/gerritFile';
import { log } from '../../lib/util/log';
import {
  buildHTML,
  OverviewComment,
  FileGroup,
} from './html';

let activePanel: WebviewPanel | null = null;
let activeChangeNumber: string = '';
let activeGerritRepo: Repository | null = null;

export async function showCommentsOverview(
  changeNumber: string,
  gerritRepo: Repository
): Promise<void> {
  activeChangeNumber = changeNumber;
  activeGerritRepo = gerritRepo;

  if (activePanel) {
    activePanel.reveal(ViewColumn.One);
    await updatePanel(
      activePanel, changeNumber, gerritRepo
    );
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
  });

  panel.webview.onDidReceiveMessage(
    async (msg: {
      command: string;
      filePath?: string;
      line?: number;
    }) => {
      if (
        msg.command === 'navigate'
        && activeGerritRepo
      ) {
        await navigateToComment(
          activeChangeNumber,
          msg.filePath ?? '',
          msg.line,
          activeGerritRepo
        );
      }
    }
  );

  await updatePanel(
    panel, changeNumber, gerritRepo
  );
}

async function updatePanel(
  panel: WebviewPanel,
  changeNumber: string,
  gerritRepo: Repository
): Promise<void> {
  const change =
    await GerritChange.getChangeOnce(
      changeNumber,
      [
        GerritAPIWith.CURRENT_REVISION,
        GerritAPIWith.CURRENT_FILES,
      ]
    );
  if (!change) {
    panel.webview.html = buildHTML(
      changeNumber, [], []
    );
    return;
  }

  const commentsSub =
    await GerritChange.getAllComments(
      change.changeID
    );
  warmCacheShortId(change.change_id);
  warmChangeCacheShortId(change.change_id);

  const commentsMap =
    await commentsSub.getValue();

  const fileContents =
    await fetchFileContents(
      change, commentsMap, gerritRepo
    );

  const { draftGroups, unresolvedGroups } =
    groupComments(commentsMap, fileContents);

  panel.webview.html = buildHTML(
    changeNumber,
    draftGroups,
    unresolvedGroups
  );
}

/**
 * Fire-and-forget cache warm for the short
 * Change-Id (Ixx) used by loadComments on
 * local files via getCurrentChangeIDCached.
 */
function warmCacheShortId(
  shortId: string
): void {
  GerritChange.getAllComments(shortId)
    .then((sub) => sub.getValue())
    .catch(() => { });
}

/**
 * Fire-and-forget cache warm for the change
 * subscription keyed by the short Ixx format.
 * Ensures getFileFromOpenDocument ->
 * getCurrentChangeOnce resolves from cache
 * when opening local files.
 */
function warmChangeCacheShortId(
  shortId: string
): void {
  GerritChange.getChangeOnce(
    shortId,
    [
      GerritAPIWith.CURRENT_REVISION,
      GerritAPIWith.CURRENT_FILES,
    ]
  ).catch(() => { });
}

async function fetchFileContents(
  change: GerritChange,
  commentsMap: CommentMap,
  gerritRepo: Repository
): Promise<Map<string, string[]>> {
  const contents =
    new Map<string, string[]>();
  const filePaths = Array.from(
    commentsMap.keys()
  ).filter((p) => p !== '/PATCHSET_LEVEL');

  const revision =
    await change.getCurrentRevision();
  if (!revision) {
    return contents;
  }

  const filesMap = await (
    await revision.files(null)
  ).getValue();

  await Promise.all(filePaths.map(
    async (filePath) => {
      try {
        const localPath = Uri.joinPath(
          gerritRepo.rootUri, filePath
        );
        const doc =
          await workspace.openTextDocument(
            localPath
          );
        contents.set(
          filePath,
          doc.getText().split('\n')
        );
        return;
      } catch {
        // not checked out, try Gerrit API
      }

      try {
        const file = filesMap?.[filePath];
        if (!file) {
          return;
        }
        const textContent =
          await file.getNewContent();
        if (textContent) {
          contents.set(
            filePath,
            textContent.buffer
              .toString('utf8')
              .split('\n')
          );
        }
      } catch {
        // ignore fetch errors
      }
    }
  ));

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
  const end = Math.min(
    fileLines.length, idx + 2
  );
  const snippet: string[] = [];
  for (let i = start; i < end; i++) {
    const prefix = i === idx ? '\u25b6 ' : '  ';
    snippet.push(
      `${prefix}${i + 1} | ${fileLines[i]}`
    );
  }
  return snippet.join('\n');
}

function groupComments(
  commentsMap: CommentMap,
  fileContents: Map<string, string[]>
): {
  draftGroups: FileGroup[];
  unresolvedGroups: FileGroup[];
} {
  const draftsByFile =
    new Map<string, OverviewComment[]>();
  const unresolvedByFile =
    new Map<string, OverviewComment[]>();

  for (const [filePath, comments]
    of commentsMap) {
    const lines = fileContents.get(filePath);
    for (const c of comments) {
      const authorInfo = c.author;
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
        unresolved: c.unresolved ?? false,
        codeSnippet: extractSnippet(
          lines, c.line
        ),
      };

      if (c.isDraft) {
        if (!draftsByFile.has(filePath)) {
          draftsByFile.set(filePath, []);
        }
        draftsByFile.get(filePath)!.push(item);
      } else if (c.unresolved) {
        if (!unresolvedByFile.has(filePath)) {
          unresolvedByFile.set(filePath, []);
        }
        unresolvedByFile
          .get(filePath)!.push(item);
      }
    }
  }

  const toGroups = (
    map: Map<string, OverviewComment[]>
  ): FileGroup[] =>
    Array.from(map.entries()).map(
      ([filePath, comments]) => ({
        filePath,
        comments,
      })
    );

  return {
    draftGroups: toGroups(draftsByFile),
    unresolvedGroups: toGroups(unresolvedByFile),
  };
}

async function navigateToComment(
  changeNumber: string,
  filePath: string,
  line: number | undefined,
  gerritRepo: Repository
): Promise<void> {
  if (filePath === '/PATCHSET_LEVEL') {
    return;
  }

  try {
    const change =
      await GerritChange.getChangeOnce(
        changeNumber,
        [
          GerritAPIWith.CURRENT_REVISION,
          GerritAPIWith.CURRENT_FILES,
        ]
      );
    if (!change) {
      log('navigateToComment: change not found');
      return;
    }

    const commentsPrefetch =
      GerritChange.getAllComments(
        change.changeID
      ).then((sub) => sub.getValue());
    warmCacheShortId(change.change_id);
    warmChangeCacheShortId(change.change_id);

    const revision =
      await change.getCurrentRevision();
    if (!revision) {
      log('navigateToComment: revision not found');
      return;
    }

    const revDesc = {
      id: revision.revisionID,
      number: revision.number,
    };

    const file =
      revision._files?.[filePath]
      ?? new GerritFile(
        change.changeID,
        change.project,
        revDesc,
        filePath,
        {
          lines_inserted: 0,
          lines_deleted: 0,
          size_delta: 0,
          size: 0,
          old_path: undefined,
        }
      );

    await commentsPrefetch;

    const diffCmd =
      await FileTreeView.createDiffCommand(
        gerritRepo, file, null
      );
    if (!diffCmd?.arguments) {
      log(
        'navigateToComment: diff command failed '
        + 'for ' + filePath
      );
      return;
    }

    await vscodeCommands.executeCommand(
      diffCmd.command,
      ...diffCmd.arguments
    );
    if (line) {
      await new Promise((r) =>
        setTimeout(r, 300)
      );
      void vscodeCommands.executeCommand(
        'revealLine',
        {
          lineNumber: line - 1,
          at: 'center',
        }
      );
    }
  } catch (e) {
    log(
      'Failed to navigate to comment: '
      + String(e)
    );
  }
}
