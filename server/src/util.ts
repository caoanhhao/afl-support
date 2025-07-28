import { DocumentSymbol, SymbolKind } from 'vscode-languageserver';
import { AST_NODE_TYPES } from "@typescript-eslint/types";
import type { AnyNode, VariableDeclarator, Options } from 'acorn';
import { Parser } from 'acorn';
import { AFLParser } from 'eslint-plugin-afl';
import * as fs from 'fs';

export function stripStrings(line: string): string {
	return line.replace(/\\"([^\\"\\]|\\.)*\\"/g, (match) => ' '.repeat(match.length));
}

function normalizeDocumentSymbol(c: DocumentSymbol | DocumentSymbol[] | null): DocumentSymbol[] {
	if (Array.isArray(c)) { return c; }
	if (c) { return [c]; }
	return [];
}

export function nodeToDocumentSymbol(node: AnyNode): DocumentSymbol | DocumentSymbol[] | null {
	if (!node || typeof node !== 'object') { return null; }
	let name = '';
	let kind: SymbolKind = SymbolKind.Variable;
	let children: DocumentSymbol[] = [];
	let loc;
	const detail = '';

	// Handle function declarations
	if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id && typeof node.id.name === 'string') {
		name = node.id.name;
		kind = SymbolKind.Function;
		if (node.body && typeof node.body === 'object' && Array.isArray(node.body.body)) {
			children = node.body.body
				.map((child: AnyNode) => nodeToDocumentSymbol(child))
				.flatMap(normalizeDocumentSymbol);
		}
	} else {
		// Handle variable declarations 
		if (node.type === AST_NODE_TYPES.VariableDeclaration && Array.isArray(node.declarations) && node.declarations.length > 0) {
			return node.declarations.map((d: VariableDeclarator) => nodeToDocumentSymbol(d))
				.flatMap(normalizeDocumentSymbol);
		}

		// hanlde variable declarators
		if (node.type === AST_NODE_TYPES.VariableDeclarator) {
			// handle variable declarators
			if (node.id && node.id.type === AST_NODE_TYPES.Identifier) {
				name = node.id.name;
				kind = SymbolKind.Variable;
				loc = node.id.loc;
			}
		}
	}

	// check location is available
	loc = loc || node.loc;
	if (!name || !loc) { return null; }

	return DocumentSymbol.create(
		name,
		detail,
		kind,
		{
			start: { line: loc.start.line - 1, character: loc.start.column },
			end: { line: loc.end.line - 1, character: loc.end.column },
		},
		{
			start: { line: loc.start.line - 1, character: loc.start.column },
			end: { line: loc.end.line - 1, character: loc.end.column },
		},
		children
	);
}

export function getAST(text: string, options?: Options): AnyNode | null {
	try {

		const aflParser = Parser.extend(AFLParser as never);
		return aflParser.parse(text, {
			ecmaVersion: 6,
			sourceType: "module",
			locations: true,
			...options
		});

	} catch (error) {
		console.error('Error parsing text:', error);
		return null;
	}
}

export function getASTFromFile(filePath: string): AnyNode | null {
	try {
		const text = fs.readFileSync(filePath, 'utf8');
		return getAST(text);
	} catch (error) {
		console.error('Error reading file:', error);
		return null;
	}
}