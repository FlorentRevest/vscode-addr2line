import * as vscode from "vscode";
import * as cp from "child_process";
import fs = require("fs");

// Given a /path/to/file:1234 string, opens that in a text document
function openFileLine(fileLine: string) {
  const [file, lineStr] = fileLine.trim().split(":");
  const line = parseInt(lineStr, 10);

  const uri = vscode.Uri.file(file);
  vscode.workspace.openTextDocument(uri).then((doc) => {
    vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(line - 1, 0, line - 1, 0),
    });
  });
}

// Wrap the execution of an addr2line process
class Addr2Line {
  private process: cp.ChildProcess | null = null;

  // Called on startup or when the target file is created/modified
  start(target: string): void {
    if (this.process) {
      this.process.kill();
    }

    const command: string = vscode.workspace.getConfiguration().get("addr2line.command")!;
    this.process = cp.spawn(command, ["-i", "-e", target]);
    this.process.on('close', () => {
      this.process = null;
    });
  }

  // Typically called when the target file is deleted
  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  // Write "address" to the stdin of the addr2line process and return the output of the command
  async resolveAddress(address: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if(!this.process) {
        const target: string = vscode.workspace.getConfiguration().get("addr2line.target")!;
        reject(new Error(`addr2line -e ${target} not running. Is addr2line installed ? Does ${target} exist ?`));
        return;
      }

      setTimeout(() => {
        reject(new Error('addr2line resolution timed out after 5 seconds'));
      }, 5000);

      this.process.stdout?.on("data", (data) => {
        resolve(data.toString());
      });
      this.process.on("error", () => {
        reject(new Error(`addr2line errored out`));
      });
      this.process.on("close", (code) => {
        reject(new Error(`addr2line exited with code ${code}`));
      });

      this.process.stdin?.write(address + "\n");
    });
  }
}

type Addr2lineTerminalLink = vscode.TerminalLink & { link: string };

export function activate(context: vscode.ExtensionContext) {
  // This object holds a running instance of "addr2line -e binary_file".
  // This is to have it build a database of symbols as early as possible.
  // This makes address resolution much faster.
  const addr2line = new Addr2Line();

  // We need to start an addr2line instance or restart it on every binary_file change.
  let targetWatcher: vscode.FileSystemWatcher | undefined;
  function monitorTarget () {
    const target: string = vscode.workspace.getConfiguration().get("addr2line.target")!;
    const workspaceFolders = vscode.workspace.workspaceFolders;

    // Stop watching the existing target if any
    if (targetWatcher) {
      targetWatcher.dispose();
      targetWatcher = undefined;
    }
    // Only consider the first folder of this workspace
    if (workspaceFolders && workspaceFolders.length) {
      const absoluteTarget: string = workspaceFolders[0].uri.path + "/" + target;

      // Start monitoring the target
      if (fs.existsSync(absoluteTarget)) {
        addr2line.start(absoluteTarget);

        targetWatcher = vscode.workspace.createFileSystemWatcher(absoluteTarget, false, false, true);
        targetWatcher.onDidChange(() => addr2line.start(absoluteTarget));
        targetWatcher.onDidCreate(() => addr2line.start(absoluteTarget));
        targetWatcher.onDidDelete(() => addr2line.stop());
      }
    }
  }
  monitorTarget();
  vscode.workspace.onDidChangeWorkspaceFolders(monitorTarget);

  // This terminal link provider recognizes addresses and resolves them through addr2line into file:line
  vscode.window.registerTerminalLinkProvider({
    provideTerminalLinks: (context: vscode.TerminalLinkContext, token: vscode.CancellationToken) => {
    // This regexp matches the sort of addresses typically found in kernel backtraces
    // e.g.: __sys_sendmsg+0x284/0x370
    const regex = new RegExp(/[^+\ ]+\+0x[0-9a-f]+\/0x[0-9a-f]+/, 'g');
    const links: Addr2lineTerminalLink[] = [];
    const target: string = vscode.workspace.getConfiguration().get("addr2line.target")!;
    for (const match of context.line.matchAll(regex)) {
      links.push({
        startIndex: match.index!,
        length: match[0].length,
        tooltip: `addr2line -e ${target} this address`,
        link: match[0],
      });
    }
    return links;
  },
  handleTerminalLink: (link: Addr2lineTerminalLink): vscode.ProviderResult<void> => {
    // We get here when a user ctrl+clicked an address. Try to resolve it first
    addr2line
      .resolveAddress(link.link!)
      .then((output) => {
        // If we got here, the addr2line resolution worked.
        // In the case of inlined code, it can return multiple lines of output
        const lines = output.trim().split('\n');
        // Each line is a file:line pattern but sometimes the line is unknown and is a ?
        // Filter the unknown lines out
        lines.filter((line) => !line.endsWith("?"));
        // If we are left with multiple choices, give the user a quick pick menu
        if (lines.length > 1) {
          vscode.window.showQuickPick(lines)
            .then(selectedLine => {
                if (selectedLine) {
                    openFileLine(selectedLine);
                }
            });
        } else if (lines.length === 1) {
          // But if there's only one choice, just open it
          openFileLine(lines[0]);
        }
      })
      .catch((error) => {
        vscode.window.showErrorMessage(
          `Error resolving address: ${error.message}`
        );
      });
  }
});
}
