import * as path from 'path';
import { workspace, ExtensionContext, commands } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
    console.log('[Parasail] Extension activated');

    // Path to the server module (compiled server.js)
    const serverModule = context.asAbsolutePath(path.join('out', 'src', 'server.js'));

    // Debug options for the server (used when running in debug mode)
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    // Server options for running and debugging the Language Server
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions
        }
    };

    // Client options to control the Language Server's behavior
    const clientOptions: LanguageClientOptions = {
        // Register the server for Parasail documents
        documentSelector: [{ scheme: 'file', language: 'parasail' }],
        synchronize: {
            // Notify the server about file changes to `.clientrc` files in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
        }
    };

    // Create the Language Client
    client = new LanguageClient(
        'parasailLanguageServer', // Unique ID for the client
        'Parasail Language Server', // Name of the server (shown in the output)
        serverOptions,
        clientOptions
    );

    // Start the client and activate the Language Server
    client.start();

    // Register commands (if needed)
    context.subscriptions.push(
        commands.registerCommand('parasail.restartServer', async () => {
            await client.stop();
            client.start();
        })
    );
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}