/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextDocumentPositionParams,
	Location,
	CompletionItem,
	CompletionItemKind,
	Hover,
	MarkupKind,
	CodeActionParams,
	CodeAction,
	DocumentSymbol,
	InitializeParams,
	InitializeResult,
	DidChangeConfigurationNotification,
	DocumentDiagnosticReportKind,
	DocumentDiagnosticReport,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import {
	analyzeText,
	symbolTable,
	getWordAtPosition,
	getSymbolInfo,
} from "./symbolTable";
import { fixFunctionSapces } from "./rules/functions";
import { AFLParser } from "eslint-plugin-afl";
import { Parser } from "acorn";
import { nodeToDocumentSymbol } from "./util";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			definitionProvider: true,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true,
			},
			diagnosticProvider: {
				interFileDependencies: false,
				workspaceDiagnostics: false,
			},
			hoverProvider: true,
			codeActionProvider: true,
			documentSymbolProvider: true,
		},
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true,
			},
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(
			DidChangeConfigurationNotification.type,
			undefined
		);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders((_event) => {
			connection.console.log("Workspace folder change event received.");
		});
	}
});

documents.onDidOpen((e) => updateSymbolsForDocument(e.document));

let updateSymbolTimeout: NodeJS.Timeout | null = null;

documents.onDidChangeContent((e) => {
	// Only process documents with the "afl" language ID
	if (e.document.languageId !== "afl") {
		return;
	}

	// add document cooldown flag
	if (updateSymbolTimeout !== null) {
		clearTimeout(updateSymbolTimeout);
	}
	updateSymbolTimeout = setTimeout(() => {
		// Update symbols for the document when its content changes
		updateSymbolsForDocument(e.document, true);
	}, 2000);
});

function updateSymbolsForDocument(doc: TextDocument, clearCache = false): void {
	const text = doc.getText();
	const symbols = analyzeText(text, doc.uri, clearCache);
	for (const [k, v] of symbols) {
		symbolTable.set(k, v);
	}
}

connection.onDefinition(
	(params: TextDocumentPositionParams): Location | null => {
		const document = documents.get(params.textDocument.uri);
		if (!document) {
			return null;
		}

		const lines = document.getText().split(/\r?\n/);
		const line = lines[params.position.line];
		const word = getWordAtPosition(line, params.position.character);

		if (!word) {
			return null;
		}
		return symbolTable.get(word) || null;
	}
);

// The example settings
interface AflLspSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: AflLspSettings = { maxNumberOfProblems: 1000 };
let globalSettings: AflLspSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<AflLspSettings>>();

connection.onDidChangeConfiguration((change) => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = change.settings.languageServerExample || defaultSettings;
	}
	// Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
	// We could optimize things here and re-fetch the setting first can compare it
	// to the existing setting, but this is out of scope for this example.
	connection.languages.diagnostics.refresh();
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getDocumentSettings(resource: string): Thenable<AflLspSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: "aflLsp",
		});
		documentSettings.set(resource, result);
	}
	return result;
}

export function getDocuments(): TextDocuments<TextDocument> {
	return documents;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
	documentSettings.delete(e.document.uri);
});

connection.languages.diagnostics.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (document !== undefined) {
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: await validateTextDocument(document),
		} satisfies DocumentDiagnosticReport;
	} else {
		// We don't know the document. We can either try to read it from disk
		// or we don't report problems for it.
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: [],
		} satisfies DocumentDiagnosticReport;
	}
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
	validateTextDocument(change.document);
});

async function validateTextDocument(
	_textDocument: TextDocument
): Promise<Diagnostic[]> {
	// In this simple example we get the settings for every validate run.

	// const settings = await getDocumentSettings(textDocument.uri);

	// The validator creates diagnostics for all uppercase words length 2 and more
	// const text = textDocument.getText();

	// Here we would typically analyze the text and create diagnostics.
	const diagnostics: Diagnostic[] = [];

	// Send the computed diagnostics to VSCode UI.
	return diagnostics;
}

connection.onDidChangeWatchedFiles((_change) => {
	// Monitored files have change in VSCode
	connection.console.log("We received a file change event");
});

connection.onCompletion((_params) => {
	const completions: CompletionItem[] = [];
	for (const [name] of symbolTable.entries()) {
		completions.push({
			label: name,
			kind: CompletionItemKind.Function,
			data: name,
		});
	}
	return completions;
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	if (item.data === 1) {
		item.detail = "TypeScript details";
		item.documentation = "TypeScript documentation";
	} else if (item.data === 2) {
		item.detail = "JavaScript details";
		item.documentation = "JavaScript documentation";
	}
	return item;
});

connection.onHover((params): Hover | null => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return null;
	}

	const lines = document.getText().split(/\r?\n/);
	const line = lines[params.position.line];
	const word = getWordAtPosition(line, params.position.character);
	if (!word) {
		return null;
	}

	const info = getSymbolInfo(word);
	if (!info) {
		return null;
	}

	return {
		contents: {
			kind: MarkupKind.Markdown,
			value: `**${word}**\n\n${info}`,
		},
	};
});

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
	const actions: CodeAction[] = [];
	for (const diagnostic of params.context.diagnostics) {
		if (diagnostic.message.includes("space before ')'")) {
			const action = fixFunctionSapces(params, diagnostic);
			if (action) {
				actions.push(action);
			}
		}
	}
	return actions;
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return [];
	}

	const results: DocumentSymbol[] = [];
	const text = document.getText();
	const aflParser = Parser.extend(AFLParser as never);
	const ast = aflParser.parse(text, {
		ecmaVersion: 6,
		sourceType: "module",
		locations: true,
	});

	// Iterate through the AST tokens and create DocumentSymbols
	const body = Array.isArray(ast.body) ? ast.body : [];
	for (const node of body) {
		const symbol = nodeToDocumentSymbol(node);
		if (symbol) {
			if (Array.isArray(symbol)) {
				results.push(...symbol);
			} else {
				results.push(symbol);
			}
		}
	}

	return results;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
