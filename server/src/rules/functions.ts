import { Diagnostic, DiagnosticSeverity, Range, Position, CodeActionKind, TextEdit } from 'vscode-languageserver-types';
import { stripStrings } from '../util';
import { getDocuments } from '../server';
import { CodeActionParams } from 'vscode-languageserver';

export function checkFunctionSpaces(text: string, _uri: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	// Regular expression to match function call start (not full argument)
	const callStartPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

	// Split the text into lines
	const lines = text.split(/\r?\n/);

	// Flag to track if we are inside a comment block
	let isInCommentBlock = false;

	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const originalLine = lines[lineNum];

		// Check if we are entering a comment block
		if (originalLine.includes('/*')) {
			isInCommentBlock = true;
		}
		// Check if we are exiting a comment block
		if (isInCommentBlock && originalLine.includes('*/')) {
			isInCommentBlock = false;
		}

		// Skip empty lines and comments
		if (/^\s*\/\//.test(originalLine) || originalLine.includes('"') || isInCommentBlock) {
			continue;
		}

		// Remove comments from the line
		const lineWithoutComments = originalLine.replace(/\/\/.*$/, '');

		// Remove string literals to avoid false positives in function calls
		const line = stripStrings(lineWithoutComments);

		let match;
		while ((match = callStartPattern.exec(line)) !== null) {
			const functionName = match[1];
			const startChar = match.index;
			let openParenIdx = startChar + functionName.length;
			// Find the position of '('
			openParenIdx = line.indexOf('(', openParenIdx);
			if (openParenIdx === -1) {
				continue;
			}

			// Find the matching closing parenthesis (can be nested)
			let depth = 0;
			let closeParenIdx = -1;
			for (let i = openParenIdx; i < line.length; i++) {
				if (line[i] === '(') {
					depth++;
				} else if (line[i] === ')') {
					depth--;
				}
				if (depth === 0) {
					closeParenIdx = i;
					break;
				}
			}
			if (closeParenIdx === -1) {
				continue; // No matching closing parenthesis found
			}

			const args = line.slice(openParenIdx + 1, closeParenIdx);
			// Ignore calls with no arguments (only whitespace or empty)
			if (/^\s*$/.test(args)) {
				continue;
			}

			const hasSpaceAfterParen = /^\s/.test(args);
			const hasSpaceBeforeParen = /\s$/.test(args);

			if (!hasSpaceAfterParen || !hasSpaceBeforeParen) {
				const range = Range.create(
					Position.create(lineNum, startChar),
					Position.create(lineNum, closeParenIdx + 1)
				);

				let message = "Function arguments must have space after '(' and before ')'";
				if (hasSpaceAfterParen && !hasSpaceBeforeParen) {
					message = "Expected space before ')'";
				} else if (!hasSpaceAfterParen && hasSpaceBeforeParen) {
					message = "Expected space after '('";
				}

				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					range,
					message,
					source: "afl-lsp"
				});
			}
		}
	}

	return diagnostics;
}

export function fixFunctionSapces(params: CodeActionParams, diagnostic: Diagnostic) {

	const uri = params.textDocument.uri;
	const document = getDocuments().get(uri);
	if (!document) {
		return;
	}
	const range = diagnostic.range;
	const text = document.getText(range);
	// Insert a space before the last ')' in the range
	const lastParen = text.lastIndexOf(')');
	if (lastParen === -1) {
		return;
	}

	const newText = text.slice(0, lastParen) + ' )' + text.slice(lastParen + 1);

	const edit: TextEdit = {
		range,
		newText
	};
	return {
		title: "Insert space before ')'",
		kind: CodeActionKind.QuickFix,
		diagnostics: [diagnostic],
		edit: {
			changes: {
				[uri]: [edit]
			}
		}
	};
}