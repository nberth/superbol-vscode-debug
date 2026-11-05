/* Integration tests that drive debugging sessions through VS Code commands
 * (`workbench.action.debug.*`), as a user would.
 *
 * They need `cobc` and `gdb` in the `PATH`, and are skipped otherwise. */

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugProtocol } from '@vscode/debugprotocol';

const resources = path.resolve(__dirname, '../../../test/resources');
const DEBUG_TYPE = 'superbol-gdb';
const EVENT_TIMEOUT_MS = 10000;

function available(command: string): boolean {
	return cp.spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

type SessionEvent =
	| { kind: 'stopped', line: number, file: string }
	| { kind: 'terminated' };

/** Records what happens in debug sessions of the extension.  A stop is only
 * recorded once VS Code has fetched the corresponding stack trace, as the
 * debug commands act on the thread VS Code focuses at that point. */
class SessionRecorder implements vscode.Disposable {
	private readonly events: SessionEvent[] = [];
	private waiter: (() => void) | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private awaitingStackTrace = false;

	constructor() {
		this.disposables.push(
			vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, {
				createDebugAdapterTracker: () => ({
					onDidSendMessage: (m: DebugProtocol.ProtocolMessage) => this.onMessage(m),
				}),
			}),
			vscode.debug.onDidTerminateDebugSession(s => {
				if (s.type === DEBUG_TYPE) {
					this.push({ kind: 'terminated' });
				}
			}));
	}

	private onMessage(m: DebugProtocol.ProtocolMessage): void {
		if (m.type === 'event' && (<DebugProtocol.Event>m).event === 'stopped') {
			this.awaitingStackTrace = true;
		} else if (this.awaitingStackTrace && m.type === 'response'
				   && (<DebugProtocol.Response>m).command === 'stackTrace') {
			const frame = (<DebugProtocol.StackTraceResponse>m).body.stackFrames[0];
			this.awaitingStackTrace = false;
			this.push({ kind: 'stopped', line: frame.line, file: frame.source?.path });
		}
	}

	private push(e: SessionEvent): void {
		this.events.push(e);
		this.waiter?.();
	}

	async next(): Promise<SessionEvent> {
		const deadline = Date.now() + EVENT_TIMEOUT_MS;
		while (this.events.length === 0) {
			const remaining = deadline - Date.now();
			assert.ok(remaining > 0, 'timed out waiting for the debug session');
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, remaining);
				this.waiter = () => { clearTimeout(timer); resolve(); };
			});
			this.waiter = undefined;
		}
		return this.events.shift();
	}

	/** Waits for the next stop, and returns its COBOL line. */
	async nextStop(): Promise<number> {
		const e = await this.next();
		assert.equal(e.kind, 'stopped', 'expected the program to stop');
		// Let VS Code focus the stopped thread before any further command.
		await new Promise(resolve => setTimeout(resolve, 100));
		return (<{ line: number }>e).line;
	}

	clear(): void {
		this.events.length = 0;
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

suite('Stepping through PERFORM statements', function () {
	let workdir: string;
	let source: vscode.Uri;
	let recorder: SessionRecorder;

	suiteSetup(function () {
		if (!available('cobc') || !available('gdb')) {
			this.skip();
		}
		workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'superbol-debug-test-'));
		fs.copyFileSync(path.join(resources, 'performs.cbl'), path.join(workdir, 'performs.cbl'));
		const build = cp.spawnSync('cobc', ['-x', '-g', 'performs.cbl'], { cwd: workdir, encoding: 'utf8' });
		assert.equal(build.status, 0, `cobc failed: ${build.stderr}`);
		source = vscode.Uri.file(path.join(workdir, 'performs.cbl'));
		recorder = new SessionRecorder();
	});

	suiteTeardown(function () {
		recorder?.dispose();
		if (workdir) {
			fs.rmSync(workdir, { recursive: true, force: true });
		}
	});

	teardown(async function () {
		if (vscode.debug.activeDebugSession) {
			await vscode.debug.stopDebugging();
		}
		vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
		recorder.clear();
	});

	/** Starts debugging with breakpoints on the given lines, and returns the
	 * line of the first stop. */
	async function start(...lines: number[]): Promise<number> {
		vscode.debug.addBreakpoints(lines.map(l =>
			new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(l - 1, 0)))));
		const started = await vscode.debug.startDebugging(undefined, {
			type: DEBUG_TYPE,
			request: 'launch',
			name: 'stepping test',
			target: source.fsPath,
			cwd: workdir,
			preLaunchTask: '',
		});
		assert.ok(started, 'could not start debugging');
		return recorder.nextStop();
	}

	async function step(command: 'stepOver' | 'stepInto' | 'stepOut' | 'continue'): Promise<number> {
		await vscode.commands.executeCommand(`workbench.action.debug.${command}`);
		return recorder.nextStop();
	}

	/* Lines of interest in `performs.cbl`:
	 *  9: DISPLAY "start".
	 * 10: PERFORM PARA-A.
	 * 11: PERFORM PARA-B 2 TIMES.
	 * 12: PERFORM VARYING I FROM 1 BY 1 UNTIL I > 2
	 * 13:    ADD 1 TO N
	 * 14:    PERFORM PARA-A
	 * 16: PERFORM PARA-A THRU PARA-B.
	 * 17: DISPLAY "end " N.
	 * 18: STOP RUN.
	 * 20: (PARA-A) ADD 10 TO N.
	 * 21: (PARA-A) PERFORM PARA-B.
	 * 23: (PARA-B) ADD 100 TO N.
	 */

	test('step over never enters performed paragraphs', async function () {
		assert.equal(await start(9), 9);
		const lines: number[] = [];
		while (lines[lines.length - 1] !== 18) {
			assert.ok(lines.length < 30, `too many steps: ${lines}`);
			lines.push(await step('stepOver'));
		}
		// Inline PERFORMs may stop several times on line 12 (VARYING, UNTIL).
		const collapsed = lines.filter((l, i) => l !== lines[i - 1]);
		assert.deepEqual(collapsed, [10, 11, 12, 13, 14, 12, 13, 14, 12, 16, 17, 18]);
	});

	test('step over PERFORM ... TIMES skips all iterations', async function () {
		assert.equal(await start(11), 11);
		assert.equal(await step('stepOver'), 12);
	});

	test('step into PERFORM enters the paragraph', async function () {
		assert.equal(await start(10), 10);
		assert.ok([19, 20].includes(await step('stepInto')));
	});

	test('step out of nested paragraphs returns to the main paragraph', async function () {
		// First stop on line 23 is from 10 > PARA-A > 21 > PARA-B.
		assert.equal(await start(23), 23);
		assert.equal(await step('stepOut'), 11);
		// Continuing from 11 stops on 23 again, in the first iteration.
		assert.equal(await step('continue'), 23);
	});

	test('step out of a paragraph reached by breakpoint', async function () {
		assert.equal(await start(20), 20);
		assert.equal(await step('stepOut'), 11);
		assert.equal(await step('stepOver'), 12);
	});

	test('breakpoints interrupt step over', async function () {
		assert.equal(await start(11, 23), 23);
		assert.equal(await step('continue'), 11);
		assert.equal(await step('stepOver'), 23);
	});
});
