import {
  window,
  workspace,
  ExtensionContext,
} from 'vscode';
import { getConfiguration } from '../vscode/config';
import { selectAiModel } from './modelSelector';
import {
  runPreflight,
  buildMcpEnableCommand,
  AgentCommand,
} from './preflight';
import {
  writeMcpConfig,
  GerritCredentials,
} from '../mcp/mcpManager';
import {
  getGerritURLFromReviewFile,
} from '../credentials/enterCredentials';
import {
  getGitReviewFileCached,
} from '../credentials/gitReviewFile';
import { GerritSecrets } from '../credentials/secrets';
import { getGerritRepo } from '../gerrit/gerrit';
import { tryExecAsync } from '../git/gitCLI';
import { log } from '../util/log';

type CheckoutBehavior = 'ask' | 'always' | 'never';

export async function enableAiReview(
  context: ExtensionContext
): Promise<void> {
  const config = getConfiguration();

  const preflight = await runPreflight();
  if (!preflight.ok || !preflight.agent) {
    void window.showErrorMessage(
      preflight.error
      ?? 'AI Review prerequisites not met.'
    );
    return;
  }

  const modelResult = await selectAiModel();
  if (modelResult === undefined) {
    void window.showInformationMessage(
      'AI Review setup cancelled.'
    );
    return;
  }

  const checkoutBehavior =
    await pickCheckoutBehavior();
  if (!checkoutBehavior) {
    void window.showInformationMessage(
      'AI Review setup cancelled.'
    );
    return;
  }

  await config.update(
    'gerrit.aiReview.checkoutBehavior',
    checkoutBehavior
  );

  const credentials = await extractCredentials(
    context
  );
  if (!credentials) {
    void window.showWarningMessage(
      'Could not extract Gerrit credentials. '
      + 'Please configure them via "Gerrit: '
      + 'Enter Credentials" first.'
    );
    return;
  }

  const mcpOk = await writeMcpConfig(
    context.extensionPath,
    credentials
  );
  if (!mcpOk) {
    void window.showWarningMessage(
      'Failed to write MCP config. AI Review '
      + 'may not have full Gerrit integration.'
    );
  } else {
    await enableMcpServer(preflight.agent);
  }

  await config.update(
    'gerrit.aiReview.enabled', true
  );

  void window.showInformationMessage(
    'AI Review enabled! Use "Gerrit: AI Review '
    + 'Change" from the command palette or '
    + 'click the "AI Review Change" button in the Change Explorer view.'
  );
  log('AI Review enabled successfully');
}


async function pickCheckoutBehavior(): Promise<
  CheckoutBehavior | undefined
> {
  const items = [
    {
      label: 'Ask each time',
      description:
        'Prompt before each review whether '
        + 'to checkout the change',
      value: 'ask' as CheckoutBehavior,
    },
    {
      label: 'Always checkout',
      description:
        'Automatically checkout for full '
        + 'repo context',
      value: 'always' as CheckoutBehavior,
    },
    {
      label: 'Never checkout',
      description:
        'Review using Gerrit context only '
        + '(no local checkout)',
      value: 'never' as CheckoutBehavior,
    },
  ];

  const selected = await window.showQuickPick(
    items, {
    placeHolder:
      'How should AI Review handle '
      + 'change checkout?',
    title: 'Gerrit: Checkout Behavior',
  }
  );

  return selected?.value;
}

async function extractCredentials(
  context: ExtensionContext
): Promise<GerritCredentials | null> {
  const config = getConfiguration();
  const gerritRepo = await getGerritRepo(context);
  const gitReviewFile = gerritRepo
    ? await getGitReviewFileCached(gerritRepo)
    : null;

  const url = getGerritURLFromReviewFile(
    gitReviewFile
  );
  if (!url) {
    return null;
  }

  const username =
    config.get('gerrit.auth.username') ?? '';
  const password =
    await GerritSecrets.getForUrlOrWorkspace(
      'password',
      url,
      workspace.workspaceFolders?.[0]?.uri
    );
  const cookie =
    await GerritSecrets.getForUrlOrWorkspace(
      'cookie',
      url,
      workspace.workspaceFolders?.[0]?.uri
    );
  const authPrefix = config.get(
    'gerrit.customAuthUrlPrefix',
    'a/'
  );

  if (!username && !password && !cookie) {
    return null;
  }

  return {
    url,
    username,
    password: password ?? '',
    authCookie: cookie ?? undefined,
    authPrefix,
  };
}

async function enableMcpServer(
  agent: AgentCommand
): Promise<void> {
  const cwd =
    workspace.workspaceFolders?.[0]?.uri.fsPath;

  const cmd = buildMcpEnableCommand(
    agent, 'gerrit-review'
  );
  const { success, stderr } = await tryExecAsync(
    cmd,
    { silent: true, cwd }
  );

  if (success) {
    log('MCP server auto-approved');
  } else {
    log(
      'Could not auto-approve MCP server: '
      + stderr
    );
  }
}
