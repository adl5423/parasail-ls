import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    Location,
    Hover,
    SignatureHelp,
    SignatureInformation,
    ParameterInformation,
    DocumentFormattingRequest,
    DocumentSymbol,
    SymbolKind,
    DocumentSymbolParams,
    FormattingOptions,
    TextEdit,
    Position
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Language Server Connection
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Configuration Types
interface ParasailSettings {
    maxNumberOfProblems: number;
    enableFormatting: boolean;
    libraryPaths: string[];
    implicitImports: boolean;
}

// Language Constants
const PARASAIL_KEYWORDS: { [key: string]: string } = {
    "func": "Defines a function: `func name(params) -> return_type is ... end func`",
    "type": "Defines a type: `type Name is ... end type`",
    "interface": "Declares an interface: `interface Name is ... end interface`",
    "class": "Defines a class: `class Name is ... end class`",
    "operator": "Operator overload: `operator \"=\"(Left: Type, Right: Type) -> Boolean is ...`",
    "package": "Module declaration: `package Name is ... end package`",
    "const": "Constant declaration: `const Name: Type := Value`",
    "var": "Variable declaration: `var Name: Type := Value`",
    "abstract": "Abstract operation: `abstract func Name(...)`",
    "extends": "Inheritance: `class Name extends Parent`",
    "exports": "Visibility control: `exports {Name1, Name2}`",
    "imports": "Dependency: `imports Package::Module`",
    "all": "Wildcard import: `imports Package::Module::all`",
    "new": "Constructor: `var Obj := new Class(...)`",
    "not": "Logical negation: `not Condition`",
    "and": "Logical AND: `Condition1 and Condition2`",
    "or": "Logical OR: `Condition1 or Condition2`",
    "xor": "Logical XOR: `Condition1 xor Condition2`",
    "in": "Membership test: `Element in Collection`",
    "case": "Pattern matching: `case Expression of ... end case`",
    "loop": "Loop construct: `loop ... end loop`",
    "for": "Iteration: `for Elem in Collection loop ... end loop`",
    "while": "Conditional loop: `while Condition loop ... end loop`",
    "if": "Conditional: `if Condition then ... else ... end if`",
    "then": "Conditional clause",
    "else": "Alternative branch",
    "end": "Block termination",
    "is": "Declaration separator",
    "parallel": "Parallel block: `parallel ... end parallel`",
    "forward": "Deferred implementation: `forward func Name(...)`",
    "optional": "Nullable type: `optional Type`",
    "null": "Empty reference"
};

const STANDARD_LIBRARY: { [key: string]: string } = {
    "IO::Print": "Output to console: Print(\"Message\")",
    "Math::Sin": "Sine function: Sin(Radians: Float) -> Float",
    "Containers::Vector": "Resizable array: Vector<Element_Type>",
    "String::Concat": "Concatenate strings: Concat(Left, Right) -> String",
    "File::Open": "Open file: Open(Path: String) -> File_Handle",
    "DateTime::Now": "Current timestamp: Now() -> DateTime",
    "Network::HttpRequest": "HTTP client: HttpRequest(Url: String) -> Response",
    "Crypto::SHA256": "Hash data: SHA256(Data: String) -> Hash"
};

const CODE_TEMPLATES = [
    {
        trigger: /^\s*fun/i,
        snippet: 'func ${1:name}($2) -> ${3:ReturnType} is\n\t${4:-- Implementation}\nend func',
        docs: "Function declaration template"
    },
    {
        trigger: /^\s*typ/i,
        snippet: 'type ${1:TypeName} is\n\t${2:-- Definition}\nend type',
        docs: "Type declaration template"
    },
    {
        trigger: /^\s*int/i,
        snippet: 'interface ${1:InterfaceName} is\n\t${2:-- Operations}\nend interface',
        docs: "Interface declaration template"
    },
    {
        trigger: /^\s*cla/i,
        snippet: 'class ${1:ClassName} {\n\t${2:-- Fields}\n\n\tfunc ${3:New}($4) -> ${5:ClassName} is\n\t\t${6:-- Constructor}\n\tend func\n}',
        docs: "Class declaration template"
    },
    {
        trigger: /^\s*for/i,
        snippet: 'for ${1:element} in ${2:collection} loop\n\t${3:-- Loop body}\nend loop',
        docs: "For-each loop template"
    },
    {
        trigger: /^\s*if/i,
        snippet: 'if ${1:condition} then\n\t${2:-- True branch}\nelse\n\t${3:-- False branch}\nend if',
        docs: "If-else statement template"
    }
];

// Server State
let globalSettings: ParasailSettings = {
    maxNumberOfProblems: 1000,
    enableFormatting: true,
    libraryPaths: [],
    implicitImports: true
};
const documentSettings: Map<string, Thenable<ParasailSettings>> = new Map();

// Server Initialization
connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;
    
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: { 
                resolveProvider: true,
                triggerCharacters: ['.', ':', '<', '"', '/']
            },
            hoverProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['('],
                retriggerCharacters: [',']
            },
            definitionProvider: true,
            documentFormattingProvider: true,
            documentSymbolProvider: true,
            referencesProvider: true,
            workspaceSymbolProvider: true
        }
    } satisfies InitializeResult;
});

// Configuration Handling
connection.onDidChangeConfiguration(change => {
    globalSettings = change.settings.parasailServer || globalSettings;
    documents.all().forEach(validateDocument);
});

// Document Management
documents.onDidChangeContent(change => validateDocument(change.document));
documents.onDidClose(e => documentSettings.delete(e.document.uri));

// Core Validation Logic
async function validateDocument(document: TextDocument): Promise<void> {
    const diagnostics: Diagnostic[] = [];
    const tempFile = createTempFile(document.getText());
    
    try {
        const parser = cp.spawn('interp.csh', [tempFile]);
        
        parser.stderr.on('data', (data) => {
            processDiagnostics(data.toString(), document.uri, diagnostics);
        });

        parser.on('exit', () => {
            connection.sendDiagnostics({ uri: document.uri, diagnostics });
            fs.unlinkSync(tempFile);
        });

    } catch (error) {
        connection.console.error(`Validation error: ${error}`);
    }
}

function processDiagnostics(output: string, uri: string, diagnostics: Diagnostic[]) {
    output.split('\n').forEach(line => {
        const match = line.match(/(\d+):(\d+):\s*(Error|Warning):\s*(.*)/);
        if (match) {
            diagnostics.push({
                severity: match[3] === 'Error' 
                    ? DiagnosticSeverity.Error 
                    : DiagnosticSeverity.Warning,
                range: {
                    start: { line: parseInt(match[1])-1, character: parseInt(match[2])-1 },
                    end: { line: parseInt(match[1])-1, character: parseInt(match[2])+1 }
                },
                message: match[4],
                source: 'parasail'
            });
        }
    });
}

// Language Features
connection.onCompletion(params => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    return [
        ...getKeywordCompletions(),
        ...getTemplateCompletions(doc, params.position),
        ...getLibraryCompletions(),
        ...getImportCompletions(doc.getText())
    ];
});

connection.onCompletionResolve(item => {
    if (PARASAIL_KEYWORDS[item.label]) {
        item.documentation = PARASAIL_KEYWORDS[item.label];
    }
    return item;
});

connection.onHover(params => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const word = getWordAtPosition(doc, params.position);
    if (word && PARASAIL_KEYWORDS[word]) {
        return { contents: PARASAIL_KEYWORDS[word] };
    }
    return null;
});

connection.onDocumentFormatting(params => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc || !globalSettings.enableFormatting) return [];

    return formatDocument(doc.getText(), params.options);
});

connection.onDocumentSymbol(params => {
    const doc = documents.get(params.textDocument.uri);
    return doc ? findDocumentSymbols(doc.getText()) : [];
});

// Helper Functions
function createTempFile(content: string): string {
    const tempPath = path.join(os.tmpdir(), `parasail-${Date.now()}.psi`);
    fs.writeFileSync(tempPath, content);
    return tempPath;
}

function getKeywordCompletions(): CompletionItem[] {
    return Object.keys(PARASAIL_KEYWORDS).map(label => ({
        label,
        kind: CompletionItemKind.Keyword,
        documentation: PARASAIL_KEYWORDS[label]
    }));
}

function getTemplateCompletions(doc: TextDocument, pos: Position): CompletionItem[] {
    const line = doc.getText({
        start: { line: pos.line, character: 0 },
        end: { line: pos.line + 1, character: 0 }
    }).split('\n')[0];

    return CODE_TEMPLATES
        .filter(t => t.trigger.test(line))
        .map(t => ({
            label: t.snippet.split(' ')[1],
            kind: CompletionItemKind.Snippet,
            documentation: t.docs,
            insertText: t.snippet,
            insertTextFormat: 2
        }));
}

function getLibraryCompletions(): CompletionItem[] {
    return Object.keys(STANDARD_LIBRARY).map(label => ({
        label,
        kind: CompletionItemKind.Module,
        documentation: STANDARD_LIBRARY[label],
        detail: 'Standard Library'
    }));
}

function getImportCompletions(text: string): CompletionItem[] {
    const importPattern = /imports\s+([\w:]+)/g;
    const imports = new Set<string>();
    let match;

    while ((match = importPattern.exec(text))) {
        imports.add(match[1]);
    }

    return Array.from(imports).map(i => ({
        label: i.split('::').pop()!,
        kind: CompletionItemKind.Reference,
        detail: `Import from ${i}`,
        documentation: `Resolved import: ${i}`
    }));
}

function formatDocument(content: string, options: FormattingOptions): TextEdit[] {
    const lines = content.split('\n');
    const edits: TextEdit[] = [];

    lines.forEach((line, index) => {
        const indentation = line.match(/^\s*/)?.[0] || '';
        const expected = ' '.repeat(options.tabSize * 
            Math.max(0, (indentation.length / options.tabSize) | 0));
        
        if (indentation !== expected) {
            edits.push(TextEdit.replace(
                { start: { line: index, character: 0 }, 
                  end: { line: index, character: indentation.length } },
                expected
            ));
        }
    });

    return edits;
}

function findDocumentSymbols(content: string): DocumentSymbol[] {
    const symbols: DocumentSymbol[] = [];
    const symbolPatterns = {
        func: /func\s+(\w+)/,
        type: /type\s+(\w+)/,
        interface: /interface\s+(\w+)/,
        class: /class\s+(\w+)/,
        package: /package\s+(\w+)/
    };

    content.split('\n').forEach((line, lineNum) => {
        for (const [kind, pattern] of Object.entries(symbolPatterns)) {
            const match = line.match(pattern);
            if (match) {
                symbols.push({
                    name: match[1],
                    kind: SymbolKind.Function,
                    range: { 
                        start: { line: lineNum, character: 0 },
                        end: { line: lineNum, character: line.length }
                    },
                    selectionRange: {
                        start: { line: lineNum, character: match.index || 0 },
                        end: { line: lineNum, character: (match.index || 0) + match[1].length }
                    }
                });
            }
        }
    });

    return symbols;
}

function getWordAtPosition(doc: TextDocument, pos: Position): string | undefined {
    const range = {
        start: { line: pos.line, character: 0 },
        end: { line: pos.line + 1, character: 0 }
    };
    const line = doc.getText(range).split('\n')[0];
    const regex = /[\w:]+/g;
    let match;

    while ((match = regex.exec(line))) {
        const start = match.index;
        const end = start + match[0].length;
        if (pos.character >= start && pos.character <= end) {
            return match[0];
        }
    }
}

// Start the server
documents.listen(connection);
connection.listen();