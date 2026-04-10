import { getGerritURLFromReviewFile } from '../credentials/enterCredentials';
import { getGitReviewFileCached } from '../credentials/gitReviewFile';
import { GerritSecrets } from '../credentials/secrets';
import { tryExecAsync } from '../git/gitCLI';
import { getGerritRepo } from '../gerrit/gerrit';
import { writeMcpConfig, GerritCredentials } from '../mcp/mcpManager';
import {
  UserCancelledError,
  isUserCancelledError,
} from '../util/errors';
import { log } from '../util/log';
import { getConfiguration } from '../vscode/config';
import {
  runPreflightDetailed,
  PreflightStatus,
  MIN_NODE_MAJOR,
  CLI_INSTALL_CMD,
  CLI_INSTALL_URL,
} from './preflight';
import {
  AgentCommand,
  buildMcpEnableCommand,
} from './agentCli';
import { selectAiModel } from './modelSelector';
import {
  window, workspace, env, Uri, ExtensionContext,
} from 'vscode';

type CheckoutBehavior = 'ask' | 'always' | 'never';

interface PrerequisiteResult {
  agent: AgentCommand;
}

export async function enableAiReview(
  context: ExtensionContext
): Promise<void> {
  try {
    const config = getConfiguration();

    const { agent } =
      await resolvePrerequisites();

    const modelResult = await selectAiModel();
    if (modelResult === undefined) {
      throw new UserCancelledError('selectModel');
    }

    const checkoutBehavior =
      await pickCheckoutBehavior();
    if (!checkoutBehavior) {
      throw new UserCancelledError(
        'checkoutBehavior'
      );
    }

    await config.update(
      'gerrit.aiReview.checkoutBehavior',
      checkoutBehavior
    );

    const credentials = await extractCredentials(
      context
    );
    if (!credentials) {
      throw new Error(
        'Could not extract Gerrit credentials. '
        + 'Please configure them via "Gerrit: '
        + 'Enter Credentials" first.'
      );
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
      await enableMcpServer(agent);
    }

    await config.update(
      'gerrit.aiReview.enabled', true
    );

    void window.showInformationMessage(
      'AI Review enabled! Use "Gerrit: AI Review '
      + 'Change" from the command palette or '
      + 'click the "AI Review Change" button '
      + 'in the Change Explorer view.'
    );
    log('AI Review enabled successfully');
  } catch (e: unknown) {
    if (isUserCancelledError(e)) {
      log('AI Review setup cancelled');
      return;
    }
    const msg = e instanceof Error
      ? e.message : String(e);
    log('AI Review setup failed: ' + msg);
    void window.showErrorMessage(
      'AI Review setup failed: ' + msg
    );
  }
}

// ── Prerequisite resolution ─────────────────────

async function resolvePrerequisites(): Promise<
  PrerequisiteResult
> {
  let status = await runPreflightDetailed();

  if (!status.nodeOk) {
    const fixed = await promptNodeUpgrade(status);
    if (!fixed) {
      throw new UserCancelledError('nodeUpgrade');
    }
    status = await runPreflightDetailed();
    if (!status.nodeOk) {
      throw new Error(
        `Node.js >= ${MIN_NODE_MAJOR} is still `
        + 'required. Please upgrade and retry.'
      );
    }
  }

  if (!status.cliFound) {
    const fixed = await promptCliInstall();
    if (!fixed) {
      throw new UserCancelledError('cliInstall');
    }
    status = await runPreflightDetailed();
    if (!status.cliFound || !status.agent) {
      throw new Error(
        'Cursor CLI is still not detected. '
        + 'Please install it and retry.'
      );
    }
  }

  if (!status.agent) {
    throw new Error(
      'Could not detect Cursor Agent CLI.'
    );
  }

  return { agent: status.agent };
}

async function promptNodeUpgrade(
  status: PreflightStatus
): Promise<boolean> {
  const actions: string[] = [
    'Open nodejs.org',
  ];
  if (status.hasNvm) {
    actions.unshift('Run nvm install --lts');
  }
  actions.push('Cancel');

  const pick = await window.showWarningMessage(
    `Node.js >= ${MIN_NODE_MAJOR} is required, `
    + `but found v${status.nodeMajor}.`,
    ...actions
  );

  if (pick === 'Run nvm install --lts') {
    const term = window.createTerminal(
      'Node Upgrade'
    );
    term.show();
    term.sendText(
      'nvm install --lts && nvm use --lts'
    );
    await window.showInformationMessage(
      'After the terminal finishes, '
      + 'press "Done" to continue.',
      'Done'
    );
    return true;
  }

  if (pick === 'Open nodejs.org') {
    void env.openExternal(
      Uri.parse('https://nodejs.org/')
    );
    await window.showInformationMessage(
      'After upgrading Node.js, '
      + 'press "Done" to continue.',
      'Done'
    );
    return true;
  }

  return false;
}

async function promptCliInstall(): Promise<
  boolean
> {
  const pick = await window.showWarningMessage(
    'Cursor Agent CLI not found.',
    'Install Now',
    'Show Instructions',
    'Cancel'
  );

  if (pick === 'Install Now') {
    const term = window.createTerminal(
      'Cursor CLI Install'
    );
    term.show();
    term.sendText(CLI_INSTALL_CMD);
    await window.showInformationMessage(
      'After the terminal finishes, '
      + 'press "Done" to continue.',
      'Done'
    );
    return true;
  }

  if (pick === 'Show Instructions') {
    void env.openExternal(
      Uri.parse(CLI_INSTALL_URL)
    );
    await window.showInformationMessage(
      'After installing the CLI, '
      + 'press "Done" to continue.',
      'Done'
    );
    return true;
  }

  return false;
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
