/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import * as fs from 'fs';
import { workspace, ExtensionContext, ConfigurationTarget, window, commands } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] }
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'afl' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/*.afl')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'aflLangServer',
		'AFL Language Server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();

	// Update vscode settings
	await updateVScodeSettings();

	// Install ESLint and eslint-plugin-afl if not already installed
	installDependencies();
}

async function updateVScodeSettings() {
	// Add 'afl' to the validate setting in vscode
	const config = workspace.getConfiguration('eslint');
	const validateSet = new Set([...(config.validate || []), 'afl']);
	const validate = Array.from(validateSet);
	await config.update('validate', validate, ConfigurationTarget.Workspace);
}

async function installDependencies() {
	const workspaceFolders = workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		window.showErrorMessage('No workspace folder found.');
		return;
	}

	// Filter workspace folders to only those that have a package.json file and do not already have eslint installed
	const folderNames: string[] = [];
	for (const folder of workspaceFolders) {
		// Check if eslint is NOT installed
		if (!hasPackageInstalled('eslint', folder?.uri.fsPath)) {
			folderNames.push(folder.name);
		}
	}

	if (folderNames.length === 0) {
		client.outputChannel?.appendLine('All workspace folders with a package.json already have ESLint installed.');
		return;
	}

	const selectedFolderName = await window.showQuickPick(folderNames, {
		placeHolder: 'Select the workspace folder to check for installed packages'
	});
	if (!selectedFolderName) {
		window.showErrorMessage('No workspace folder selected.');
		return;
	}
	const selectedFolder = workspaceFolders.find(folder => folder.name === selectedFolderName);
	const workspacePath = selectedFolder?.uri.fsPath;
	if (!workspacePath) {
		window.showErrorMessage('Invalid workspace folder.');
		return;
	}

	// Check if the 'eslint.enable' setting is set to true
	const terminal = window.createTerminal('Install ESLint');

	// cd to the workspace folder
	terminal.sendText(`cd "${workspacePath}"`);

	// If ESLint is not installed, install it
	if (!hasPackageInstalled('eslint', workspacePath)) {
		terminal.sendText('npm install eslint --save-dev');
		terminal.show();
	}

	// If the 'eslint-plugin-afl' package is not installed, install it
	if (!hasPackageInstalled('eslint-plugin-afl', workspacePath)) {
		terminal.sendText('npm install git+https://github.com/caoanhhao/eslint-plugin-afl.git --save-dev');
		terminal.show();
		terminal.sendText('exit');

		const disposable = window.onDidCloseTerminal((closedTerminal) => {
			if (closedTerminal === terminal) {
				// Reload the window to apply changes
				window.showInformationMessage('Please restart VSCode to apply ESLint Config changes.', 'Restart Now').then(selection => {
					if (selection === 'Restart Now') {
						commands.executeCommand('workbench.action.reloadWindow');
					}
				});

				// Dispose of the event listener
				disposable.dispose();
			}
		});
	}
}

function hasPackageInstalled(packageName: string, workspacePath = ''): boolean {
	const packageJsonPath = path.join(workspacePath, 'package.json');

	if (!fs.existsSync(packageJsonPath)) {
		window.showErrorMessage('No package.json found in workspace.');
		return;
	}

	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	const installed = (packageJson.dependencies && packageJson.dependencies[packageName]);
	const devInstalled = (packageJson.devDependencies && packageJson.devDependencies[packageName]);
	return installed || devInstalled;
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
