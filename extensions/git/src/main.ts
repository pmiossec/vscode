/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vscode-nls';
const localize = nls.loadMessageBundle();

import { ExtensionContext, workspace, window, Disposable, commands, Uri, OutputChannel, WorkspaceFolder } from 'vscode';
import { findGit, Git, IGit } from './git';
import { Model } from './model';
import { CommandCenter } from './commands';
import { GitContentProvider } from './contentProvider';
import { GitDecorations } from './decorationProvider';
import { Askpass } from './askpass';
import { toDisposable, filterEvent, eventToPromise } from './util';
import TelemetryReporter from 'vscode-extension-telemetry';
import { GitExtension } from './api/git';
import { GitProtocolHandler } from './protocolHandler';
import { createGitExtension } from './api/extension';
import * as path from 'path';
import * as fs from 'fs';
import * as which from 'which';

const deactivateTasks: { (): Promise<any>; }[] = [];

export async function deactivate(): Promise<any> {
	for (const task of deactivateTasks) {
		await task();
	}
}

async function createModel(context: ExtensionContext, outputChannel: OutputChannel, telemetryReporter: TelemetryReporter, disposables: Disposable[]): Promise<Model> {
	const pathHint = workspace.getConfiguration('git').get<string>('path');
	const info = await findGit(pathHint, path => outputChannel.appendLine(localize('looking', "Looking for git in: {0}", path)));
	const askpass = new Askpass();
	disposables.push(askpass);

	const env = await askpass.getEnv();
	const git = new Git({ gitPath: info.path, version: info.version, env });
	const model = new Model(git, context.globalState, outputChannel);
	disposables.push(model);

	commands.registerCommand('git.setGitEditor', () => setVsCodeAsGitEditor(git, outputChannel));
	commands.registerCommand('git.setGitDiffTool', () => setVsCodeAsGitDiffTool(git, outputChannel));
	commands.registerCommand('git.setGitMergeTool', () => setVsCodeAsGitMergeTool(git, outputChannel));
	commands.registerCommand('git.setGitTools', () => setVsCodeAsGitTools(git, outputChannel));

	const onRepository = () => commands.executeCommand('setContext', 'gitOpenRepositoryCount', `${model.repositories.length}`);
	model.onDidOpenRepository(onRepository, null, disposables);
	model.onDidCloseRepository(onRepository, null, disposables);
	onRepository();

	outputChannel.appendLine(localize('using git', "Using git {0} from {1}", info.version, info.path));

	const onOutput = (str: string) => {
		const lines = str.split(/\r?\n/mg);

		while (/^\s*$/.test(lines[lines.length - 1])) {
			lines.pop();
		}

		outputChannel.appendLine(lines.join('\n'));
	};
	git.onOutput.addListener('log', onOutput);
	disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

	disposables.push(
		new CommandCenter(git, model, outputChannel, telemetryReporter),
		new GitContentProvider(model),
		new GitDecorations(model),
		new GitProtocolHandler()
	);

	await checkGitVersion(info);

	return model;
}

async function isGitRepository(folder: WorkspaceFolder): Promise<boolean> {
	if (folder.uri.scheme !== 'file') {
		return false;
	}

	const dotGit = path.join(folder.uri.fsPath, '.git');

	try {
		const dotGitStat = await new Promise<fs.Stats>((c, e) => fs.stat(dotGit, (err, stat) => err ? e(err) : c(stat)));
		return dotGitStat.isDirectory();
	} catch (err) {
		return false;
	}
}

async function warnAboutMissingGit(): Promise<void> {
	const config = workspace.getConfiguration('git');
	const shouldIgnore = config.get<boolean>('ignoreMissingGitWarning') === true;

	if (shouldIgnore) {
		return;
	}

	if (!workspace.workspaceFolders) {
		return;
	}

	const areGitRepositories = await Promise.all(workspace.workspaceFolders.map(isGitRepository));

	if (areGitRepositories.every(isGitRepository => !isGitRepository)) {
		return;
	}

	const download = localize('downloadgit', "Download Git");
	const neverShowAgain = localize('neverShowAgain', "Don't Show Again");
	const choice = await window.showWarningMessage(
		localize('notfound', "Git not found. Install it or configure it using the 'git.path' setting."),
		download,
		neverShowAgain
	);

	if (choice === download) {
		commands.executeCommand('vscode.open', Uri.parse('https://git-scm.com/'));
	} else if (choice === neverShowAgain) {
		await config.update('ignoreMissingGitWarning', true, true);
	}
}

export async function activate(context: ExtensionContext): Promise<GitExtension> {
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	const outputChannel = window.createOutputChannel('Git');
	commands.registerCommand('git.showOutput', () => outputChannel.show());
	disposables.push(outputChannel);

	const { name, version, aiKey } = require('../package.json') as { name: string, version: string, aiKey: string };
	const telemetryReporter = new TelemetryReporter(name, version, aiKey);
	deactivateTasks.push(() => telemetryReporter.dispose());

	const config = workspace.getConfiguration('git', null);
	const enabled = config.get<boolean>('enabled');

	if (!enabled) {
		const onConfigChange = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('git'));
		const onEnabled = filterEvent(onConfigChange, () => workspace.getConfiguration('git', null).get<boolean>('enabled') === true);
		await eventToPromise(onEnabled);
	}

	try {
		const model = await createModel(context, outputChannel, telemetryReporter, disposables);
		return createGitExtension(model);
	} catch (err) {
		if (!/Git installation not found/.test(err.message || '')) {
			throw err;
		}

		console.warn(err.message);
		outputChannel.appendLine(err.message);

		await warnAboutMissingGit();

		return createGitExtension();
	}
}

async function setVsCodeAsGitEditor(git: Git, outputChannel: OutputChannel, vscodeExe?: string): Promise<boolean> {
	vscodeExe = vscodeExe || await findVsCodeExeInPath();

	if (await setGitGlobalConfig(git, 'core.editor', `"${vscodeExe}" --wait`)) {
		window.showInformationMessage(localize('successGitEditor', "Visual Studio Code has been successfully set as git editor"));
		return true;
	} else {
		window.showErrorMessage(localize('failGitEditor', "Failed to set Visual Studio Code as git editor. See OUTPUT panel form more details"));
		outputChannel.show();
		return false;
	}
}

async function setVsCodeAsGitDiffTool(git: Git, outputChannel: OutputChannel, vscodeExe?: string): Promise<boolean> {
	vscodeExe = vscodeExe || await findVsCodeExeInPath();

	if (await setGitGlobalConfig(git, 'difftool.vscode.cmd', `"${vscodeExe}" --wait --diff "$LOCAL" "$REMOTE"`)
		&& await setGitGlobalConfig(git, 'diff.tool', 'vscode')) {
		window.showInformationMessage(localize('successDiffTool', "Visual Studio Code has been successfully set as diff tool"));
		return true;
	} else {
		window.showErrorMessage(localize('failDiffTool', "Failed to set Visual Studio Code as diff tool. See OUTPUT panel form more details"));
		outputChannel.show();
		return false;
	}
}

async function setVsCodeAsGitMergeTool(git: Git, outputChannel: OutputChannel, vscodeExe?: string): Promise<boolean> {
	vscodeExe = vscodeExe || await findVsCodeExeInPath();

	if (await setGitGlobalConfig(git, 'mergetool.vscode.cmd', `"${vscodeExe}" --wait "$MERGED"`)
		&& await setGitGlobalConfig(git, 'merge.tool', 'vscode')) {
		window.showInformationMessage(localize('successMergeTool', "Visual Studio Code has been successfully set as merge tool"));
		return true;
	} else {
		window.showErrorMessage(localize('failMergeTool', "Failed to set Visual Studio Code as merge tool. See OUTPUT panel form more details"));
		outputChannel.show();
		return false;
	}
}

async function setVsCodeAsGitTools(git: Git, outputChannel: OutputChannel): Promise<boolean> {
	var vscodeExe = await findVsCodeExeInPath();
	return await setVsCodeAsGitEditor(git, outputChannel, vscodeExe)
		&& await setVsCodeAsGitDiffTool(git, outputChannel, vscodeExe)
		&& await setVsCodeAsGitMergeTool(git, outputChannel, vscodeExe);
}

async function findVsCodeExeInPath(): Promise<string> {
	return require('electron').remote.app;
}

async function setGitGlobalConfig(git: Git, key: string, value: string): Promise<boolean> {
	try {
		const res = await git.exec('.', ['config', '--global', key, value]);
		if (res.exitCode !== 0) {
			console.error('Fail to set git setting. Error: \n' + res.stderr);
			return false;
		}
		return true;
	} catch (error) {
		console.error('Fail to set git setting. Error: \n' + error);
		return false;
	}
}

async function checkGitVersion(info: IGit): Promise<void> {
	const config = workspace.getConfiguration('git');
	const shouldIgnore = config.get<boolean>('ignoreLegacyWarning') === true;

	if (shouldIgnore) {
		return;
	}

	if (!/^[01]/.test(info.version)) {
		return;
	}

	const update = localize('updateGit', "Update Git");
	const neverShowAgain = localize('neverShowAgain', "Don't Show Again");

	const choice = await window.showWarningMessage(
		localize('git20', "You seem to have git {0} installed. Code works best with git >= 2", info.version),
		update,
		neverShowAgain
	);

	if (choice === update) {
		commands.executeCommand('vscode.open', Uri.parse('https://git-scm.com/'));
	} else if (choice === neverShowAgain) {
		await config.update('ignoreLegacyWarning', true, true);
	}
}
