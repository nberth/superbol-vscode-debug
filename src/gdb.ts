import * as DebugAdapter from '@vscode/debugadapter';
import {
    DebugSession,
    Handles,
    InitializedEvent,
    OutputEvent,
    Scope,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread,
    ThreadEvent
} from '@vscode/debugadapter';
import {DebugProtocol} from '@vscode/debugprotocol';
import {Breakpoint, DebuggerVariable, localizeSymbols} from './debugger';
import {MINode} from './parser.mi2';
import * as path from "path";
import * as fs from "fs";
import {MI2, cobExecutablePath, cobcrunArgs, removePathExtension} from './mi2';
import {CoverageStatus} from './coverage';
import {accessors as settings} from './settings';
import * as log from './log';

const STACK_HANDLES_START = 1000;
const VAR_HANDLES_START = 512 * 256 + 1000;

class ExtendedVariable {
    constructor(public _name: string, public _options: unknown) {
    }
}

function stripPathExtensions(p1: string) {
    const p2 = path.basename(p1, path.extname(p1));
    return (p2 === p1) ? p1 : stripPathExtensions(p2);
}

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    cwd: string | null;
    target: string;
    arguments: string;
    gdbargs: string[];
    env: NodeJS.ProcessEnv;
    group: string[];
    verbose: boolean;
    coverage: boolean;
    gdbtty: boolean;
    useCobcrun: boolean;
    cobcrunPath: string | null;
    sourceDirs: string[];
}

export interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
    cwd: string | null;
    target: string;
    arguments: string;
    gdbargs: string[];
    env: NodeJS.ProcessEnv;
    group: string[];
    verbose: boolean;
    pid: string;
    remoteDebugger: string;
    useCobcrun: boolean;
    cobcrunPath: string | null;
    sourceDirs: string[];
}

/** Module file extensions, as produced by `cobc -m`. */
const MODULE_EXTENSIONS = [".so", ".dylib", ".dll"];

/** Time (in ms) to wait for the client to start the program in a terminal. */
const RUN_IN_TERMINAL_TIMEOUT_MS = 10000;

/** Identifier of the error sent when the program cannot be run in a terminal
 * (follows the launch errors 100 and 103 below). */
const RUN_IN_TERMINAL_ERROR_ID = 104;

/** Guess if the target was built as a module: there is a module file but no
 * executable. */
function isModuleTarget(target: string, cwd: string): boolean {
    const name = path.join(cwd, removePathExtension(target));
    return !fs.existsSync(cobExecutablePath(target, cwd)) &&
        MODULE_EXTENSIONS.some(ext => fs.existsSync(name + ext));
}

function initLogLevel(verbose: boolean) {
    if (verbose) {
        log.setLevel(log.Level.Debug);
    } else {
        log.setLevel(log.Level.Info);
    }
}

enum VarCat { Local, Global };

export class GDBDebugSession extends DebugSession {
    protected variableHandles = new Handles<[string, VarCat]>(VAR_HANDLES_START);
    protected quit: boolean;
    protected needContinue: boolean;
    protected started: boolean;
    protected attached: boolean;
    protected crashed: boolean;
    protected debugReady: boolean;
    // Breakpoint updates being processed: each update clears breakpoints before
    // setting the requested ones, so concurrent updates must not interleave.
    private breakpointUpdates: Promise<void> = Promise.resolve();
    protected miDebugger: MI2;
    coverageStatus: CoverageStatus;
    private showCoverage: boolean = true;
    private readonly showDetails = settings.displayVariableAttributes;
    private supportsRunInTerminal: boolean = false;

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        this.supportsRunInTerminal = !!args.supportsRunInTerminalRequest;
        response.body.supportsSetVariable = true;
        this.sendResponse(response);
    }

    /** Run the program in a terminal, without GDB. */
    private runWithoutDebugger(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments,
                               cwd: string, cobcrunPath: string): void {
        const command = args.useCobcrun
            ? [cobcrunPath].concat(cobcrunArgs(args.target, cwd))
            : [cobExecutablePath(args.target, cwd)];
        const programArgs = (args.arguments ?? "").split(/\s+/).filter(a => a !== "");
        const env: { [key: string]: string | null } = {};
        for (const [key, value] of Object.entries(args.env ?? {})) {
            env[key] = value ?? null;
        }
        this.runInTerminalRequest({
            kind: "integrated",
            title: removePathExtension(args.target),
            cwd: cwd,
            args: command.concat(programArgs),
            env: env,
        }, RUN_IN_TERMINAL_TIMEOUT_MS, (runResponse) => {
            if (runResponse.success) {
                this.sendResponse(response);
                // The program keeps running in the terminal; the session ends here.
                this.sendEvent(new TerminatedEvent());
            } else {
                this.sendErrorResponse(response, RUN_IN_TERMINAL_ERROR_ID, `Failed to run program: ${runResponse.message}`);
            }
        });
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        initLogLevel(args.verbose);

        const cobcrunPath = args.cobcrunPath ?? settings.cobcrunPath;
        // Run in the target executables' directory, unless specified; becomes '.' if target is a module name.
        let cwd = args.cwd ?? path.dirname (args.target);

        if (args.useCobcrun === undefined) {
            args.useCobcrun = isModuleTarget(args.target, cwd);
        }

        if (args.noDebug && this.supportsRunInTerminal) {
            this.runWithoutDebugger(response, args, cwd, cobcrunPath);
            return;
        }

        this.showCoverage = args.coverage;
        this.started = false;
        this.attached = false;

        this.miDebugger = new MI2(settings.gdbPath, args.gdbargs, args.env, args.noDebug, args.gdbtty, cobcrunPath, args.useCobcrun, args.sourceDirs);
        this.miDebugger.on("launcherror", (err: Error) => this.launchError(err));
        this.miDebugger.on("quit", () => this.quitEvent());
        this.miDebugger.on("exited-normally", () => this.quitEvent());
        this.miDebugger.on("stopped", (info: MINode) => this.stopEvent(info));
        this.miDebugger.on("msg", (type: string, message: string) => this.handleMsg(type, message));
        this.miDebugger.on("breakpoint", (info: MINode) => this.handleBreakpoint(info));
        this.miDebugger.on("step-end", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("step-out-end", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("step-other", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("signal-stop", (info: MINode) => this.handlePause(info));
        this.miDebugger.on("thread-created", (info: MINode) => this.threadCreatedEvent(info));
        this.miDebugger.on("thread-exited", (info: MINode) => this.threadExitedEvent(info));
        this.sendEvent(new InitializedEvent());
        this.quit = false;
        this.needContinue = false;
        this.crashed = false;
        this.debugReady = false;
        this.miDebugger.load(cwd, args.target, args.arguments, args.group, args.gdbtty).then(
        /*onfulfilled:*/ () => {
            setTimeout(() => {
                this.miDebugger.emit("ui-break-done");
            }, 50);
            this.sendResponse(response);
            this.miDebugger.start().then(() => {
                this.started = true;
                if (this.crashed)
                    this.handlePause(undefined);
            }, (err: Error) => {
                this.sendErrorResponse(response, 100, `Failed to start MI Debugger: ${err.toString()}`);
            });
        },
        /*onrejected:*/ (err: Error) => {
            this.sendErrorResponse(response, 103, `Failed to load MI Debugger: ${err.toString()}`);
        });
    }

    protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {
        initLogLevel(args.verbose);

        if (!args.pid && !args.remoteDebugger) {
            this.sendErrorResponse(
                response,
                100,
                `Failed to start MI Debugger: PID or remote-debugger argument required`
            );
            return;
        }

        this.showCoverage = false;
        this.attached = true;
        this.started = false;
        const cobcrunPath = args.cobcrunPath ?? settings.cobcrunPath;

        this.miDebugger = new MI2(settings.gdbPath, args.gdbargs, args.env, false, false, cobcrunPath, args.useCobcrun, args.sourceDirs);
        this.miDebugger.on("launcherror", (err: Error) => this.launchError(err));
        this.miDebugger.on("quit", () => this.quitEvent());
        this.miDebugger.on("exited-normally", () => this.quitEvent());
        this.miDebugger.on("stopped", (info: MINode) => this.stopEvent(info));
        this.miDebugger.on("msg", (type: string, message: string) => this.handleMsg(type, message));
        this.miDebugger.on("breakpoint", (info: MINode) => this.handleBreakpoint(info));
        this.miDebugger.on("step-end", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("step-out-end", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("step-other", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("signal-stop", (info: MINode) => this.handlePause(info));
        this.miDebugger.on("thread-created", (info: MINode) => this.threadCreatedEvent(info));
        this.miDebugger.on("thread-exited", (info: MINode) => this.threadExitedEvent(info));
        this.sendEvent(new InitializedEvent());
        this.quit = false;
        this.needContinue = true;
        this.crashed = false;
        this.debugReady = false;
        // Run in the target executables' directory, unless specificed.
        let cwd = args.cwd ?? path.dirname (args.target);
        this.miDebugger.attach(cwd, args.target, args.group).then(() => {
            setTimeout(() => {
                this.miDebugger.emit("ui-break-done");
            }, 50);
            this.sendResponse(response);
            this.miDebugger.start(args.pid || args.remoteDebugger).then(() => {
                this.attached = true;
                if (this.crashed)
                    this.handlePause(undefined);
            }, (err: Error) => {
                this.sendErrorResponse(response, 100, `Failed to start MI Debugger: ${err.toString()}`);
            });
        }, (err: Error) => {
            this.sendErrorResponse(response, 103, `Failed to load MI Debugger: ${err.toString()}`);
        });
    }

    protected handleMsg(type: string, msg: string) {
        if (type == "target")
            type = "stdout";
        if (type == "log")
            type = "stderr";
        this.sendEvent(new OutputEvent(msg, type));
    }

    protected handleBreakpoint(info: MINode) {
        const event = new StoppedEvent("breakpoint", parseInt(<string>info.record("thread-id")));
        (<DebugProtocol.StoppedEvent>event).body.allThreadsStopped = info.record("stopped-threads") == "all";
        this.sendEvent(event);
    }

    protected handleBreak(info?: MINode) {
        const event = new StoppedEvent("step", info ? parseInt(<string>info.record("thread-id")) : 1);
        (<DebugProtocol.StoppedEvent>event).body.allThreadsStopped = info ? info.record("stopped-threads") == "all" : true;
        this.sendEvent(event);
    }

    protected handlePause(info: MINode) {
        const event = new StoppedEvent("user request", parseInt(<string>info.record("thread-id")));
        (<DebugProtocol.StoppedEvent>event).body.allThreadsStopped = info.record("stopped-threads") == "all";
        this.sendEvent(event);
    }

    protected stopEvent(info: MINode) {
        if (!this.started)
            this.crashed = true;
        if (!this.quit) {
            const event = new StoppedEvent("exception", parseInt(<string>info.record("thread-id")));
            (<DebugProtocol.StoppedEvent>event).body.allThreadsStopped = info.record("stopped-threads") == "all";
            this.sendEvent(event);
        }
    }

    protected threadCreatedEvent(info: MINode) {
        this.sendEvent(new ThreadEvent("started", <number>info.record("id")));
    }

    protected threadExitedEvent(info: MINode) {
        this.sendEvent(new ThreadEvent("exited", <number>info.record("id")));
    }

    protected quitEvent() {
        if (this.quit)
            return;

        if (this.showCoverage) {
            this.coverageStatus.show(this.miDebugger.getGcovFiles(), this.miDebugger.sourceMap()).catch((err: Error) => console.log(err));
        } else {
            this.coverageStatus.hide();
        }

        this.quit = true;
        this.sendEvent(new TerminatedEvent());
    }

    protected launchError(err: Error) {
        this.handleMsg("stderr", "Could not start debugger process\n");
        this.handleMsg("stderr", err.toString() + "\n" + err.stack + "\n");
        this.quitEvent();
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, _args: DebugProtocol.DisconnectArguments): void {
        if (this.attached)
            this.miDebugger.detach();
        else
            this.miDebugger.stop();
        this.sendResponse(response);
    }

    protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {
        const cb = () => {
            this.debugReady = true;
            const all: Thenable<[boolean, Breakpoint]>[] = [];
            args.breakpoints.forEach(brk => {
                all.push(this.miDebugger.addBreakPoint({
                    raw: brk.name,
                    condition: brk.condition,
                    countCondition: brk.hitCondition
                }));
            });
            Promise.all(all).then(brkpoints => {
                const finalBrks: DebugProtocol.Breakpoint[] = [];
                brkpoints.forEach(brkp => {
                    if (brkp[0])
                        finalBrks.push({line: brkp[1].line, verified: brkp[0]});
                });
                response.body = {
                    breakpoints: finalBrks
                };
                this.sendResponse(response);
            }, (msg: Error) => {
                this.sendErrorResponse(response, 10, msg.toString());
            });
        };
        if (this.debugReady)
            cb();
        else
            this.miDebugger.once("debug-ready", cb);
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        const update = async () => {
            try {
                await this.miDebugger.clearBreakPoints();
                const path = args.source.path;
                const brkpoints = await Promise.all(args.breakpoints.map(brk => {
                    return this.miDebugger.addBreakPoint({
                        file: path,
                        line: brk.line,
                        condition: brk.condition,
                        countCondition: brk.hitCondition
                    });
                }));
                const finalBrks: DebugAdapter.Breakpoint[] = [];
                brkpoints.forEach(brkp => {
                    if (brkp[0])
                        finalBrks.push(new DebugAdapter.Breakpoint(true, brkp[1].line));
                });
                response.body = {
                    breakpoints: finalBrks
                };
                this.sendResponse(response);
            } catch (msg) {
                this.sendErrorResponse(response, 9, String(msg));
            }
        };
        const cb = () => {
            this.debugReady = true;
            // Process updates in the order they are received.
            this.breakpointUpdates = this.breakpointUpdates.then(update);
        };
        if (this.debugReady)
            cb();
        else
            this.miDebugger.once("debug-ready", cb);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        if (!this.miDebugger) {
            this.sendResponse(response);
            return;
        }
        this.miDebugger.getThreads().then(
            threads => {
                response.body = {
                    threads: []
                };
                for (const thread of threads) {
                    let threadName = thread.name;
                    if (threadName === undefined) {
                        threadName = thread.targetId;
                    }
                    if (threadName === undefined) {
                        threadName = "<unnamed>";
                    }
                    response.body.threads.push(new Thread(thread.id, thread.id.toString() + ":" + threadName));
                }
                this.sendResponse(response);
            }, (err: Error) => {
                this.sendErrorResponse(response, 13, `Could not get threads: ${err.toString()}`)
            });
    }

    // Supports 256 threads.
    protected threadAndLevelToFrameId(threadId: number, level: number) {
        return level << 8 | threadId;
    }

    protected frameIdToThreadAndLevel(frameId: number) {
        return [frameId & 0xff, frameId >> 8];
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        this.miDebugger.getStack(args.levels, args.threadId).then(stack => {
            const ret = stack.map(element => {
                const file = element.line.fileCobol;
                const fileBasename = path.basename(file);
                const cobolLine = element.line.cobolLine?.trim();
                const frameDescr = cobolLine
                    ? `${element.function} (${cobolLine})`
                    : `${element.function}`;
                return new StackFrame(
                    this.threadAndLevelToFrameId(args.threadId, element.level),
                    frameDescr, // + "@" + element.address,
                    file ? new Source(fileBasename, file) : undefined,
                    element.line.lineCobol, 0);
            });
            response.body = {
                stackFrames: Array.from(ret)
            };
            this.sendResponse(response);
        }, (err: Error) => {
            this.sendErrorResponse(response, 12, `Failed to get Stack Trace: ${err.toString()}`);
        });
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, _args: DebugProtocol.ConfigurationDoneArguments): void {
        if (this.needContinue) {
            this.miDebugger.continue().then(_done => {
                this.sendResponse(response);
            }, (msg: Error) => {
                this.sendErrorResponse(response, 2, `Could not continue: ${msg.toString()}`);
            });
        } else
            this.sendResponse(response);
    }

    // TODO: invalidate on some operations?
    private globalVariables: Map<number, Promise<DebuggerVariable[]>> = new Map();

    protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
        const scopes = [
            new Scope("Local", STACK_HANDLES_START + args.frameId, false)
        ];
        const filesSymbols = await this.miDebugger.globalStorageSymbols();
        this.globalVariables.clear();
        await Promise.all(filesSymbols.flatMap(fileSymbols => {
            if (fileSymbols.symbols.length > 0) {
                const base = stripPathExtensions(fileSymbols.filename);
                const scopeId = scopes.length;
                const scopeVariables = localizeSymbols(fileSymbols).map(s => this.miDebugger.evalSymbol(s));
                this.globalVariables.set(scopeId, Promise.all(scopeVariables));
                scopes.push(new Scope(`Globals (${base})`, scopeId, false));
                return scopeVariables;
            } else {
                return [];
            }
        }));
        response.body = { scopes: scopes };
        this.sendResponse(response);
    }

    private debugProtocolVariable(dv: DebuggerVariable, varCat: VarCat) : DebugProtocol.Variable {
        const reference = (this.showDetails || !!dv.children.size)
                        ? this.variableHandles.create([dv.cName, varCat])
                        : 0;
        const value = this.showDetails
                    ? `${dv.value || "null"} (${dv.displayableType})`
                    :    dv.value || "null";
        return {
            name: dv.cobolName,
            evaluateName: dv.cobolName,
            value: value,
            type: dv.displayableType,
            variablesReference: reference
        };
    }

    private async globalVariableRequest(response: DebugProtocol.VariablesResponse, scopeId: number): Promise<void> {
        const scopeVariables = await this.globalVariables.get(scopeId);
        response.body = {
            variables: scopeVariables.map(v => this.debugProtocolVariable(v, VarCat.Global))
        };
        this.sendResponse(response);
    }

    private async stackVariableRequest(response: DebugProtocol.VariablesResponse, id: number) : Promise<void> {
        const [threadId, level] = this.frameIdToThreadAndLevel(id);
        const stackVariables = await this.miDebugger.getStackVariables(threadId, level);
        response.body = {
            variables: (stackVariables ?? []).map(v => this.debugProtocolVariable(v, VarCat.Local))
        };
        this.sendResponse(response);
    }

    private lookupVariable (ref: number) : [string | number, VarCat] {
        let id: number | string;
        let cat: VarCat = VarCat.Local;
        if (ref < VAR_HANDLES_START) {
            if (ref >= STACK_HANDLES_START) {
                cat = VarCat.Local;
                id = ref - STACK_HANDLES_START;
            } else {
                cat = VarCat.Global;
                id = ref;
            }
        } else {
            [id, cat] = this.variableHandles.get(ref);
        }
        return [id, cat];
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        const [id, cat] = this.lookupVariable(args.variablesReference);
        response.body = { variables: [] };
        try {
            if (typeof id == "number") {
                if (cat == VarCat.Local) {
                    this.stackVariableRequest(response, id);
                } else {
                    this.globalVariableRequest(response, id);
                }
            } else if (typeof id == "string") {
                // TODO: this evals on an (effectively) unknown thread for multithreaded programs.
                const v = (cat == VarCat.Local)
                    ? await this.miDebugger.evalCVariable(id)
                    : await this.miDebugger.evalCGlobal(id);
                if (v === undefined) {
                    this.sendResponse(response); // fail early and silently
                }

                let variables: DebugProtocol.Variable[] = [];

                if (this.showDetails) {
                    variables = v.toDebugProtocolVariable(this.showDetails);
                }

                for (const child of v.children.values()) {
                    let reference = 0;
                    if (this.showDetails || !!child.children.size) {
                        reference = this.variableHandles.create([`${child.cName}`, cat]);
                    }

                    let value = child.displayableType;
                    if (!this.showDetails) {
                        const evaluatedChild = (cat == VarCat.Local)
                            ? await this.miDebugger.evalCVariable(child.cName)
                            : await this.miDebugger.evalCGlobal(child.cName);
                        value = evaluatedChild !== undefined ? (evaluatedChild.value || "null") : "?";
                    }

                    variables.push({
                        name: child.cobolName,
                        evaluateName: child.cobolName,
                        value: value,
                        type: child.displayableType,
                        variablesReference: reference
                    });
                }
                response.body = {
                    variables: variables
                };
                this.sendResponse(response);
            } else {
                this.sendResponse(response);
            }
        } catch (err) {
            this.sendErrorResponse(response, 1, `Could not expand variable: ${(<Error>err).toString()}`);
        }
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
        const [id, cat] = this.lookupVariable(args.variablesReference);
        let invalidatedAreas = [];
        if (this.showDetails && args.name !== "value") {
            this.sendErrorResponse(response, 14, `${args.name} cannot be changed`);
            return;
        }
        const editDetails = this.showDetails && args.name === "value";
        // log.debug("setVartiableRequest", args.name, args.value, args.variablesReference.toString(), id.toString());
        try {
            if (cat == VarCat.Local) {
                invalidatedAreas = editDetails && typeof id == "string"
                    ? await this.miDebugger.changeCVariable(id.toString(), args.value)
                    : await this.miDebugger.changeVariable(args.name, args.value);
                response.body = { value: args.value };
            } else if (cat == VarCat.Global) {
                let cName: string = null;
                if (typeof id == "number") {
                    // TODO: can we be editing "value" details (ie. can showDetails hold here)?
                    const vars = await this.globalVariables.get(id);
                    cName = vars.find(v => v.cobolName == args.name)?.cName; // TODO: check ambiguous item names?
                } else if (typeof id == "string" && !editDetails) {
                    cName = this.miDebugger.lookupGlobalCobolByCName(args.name, id)?.cName;
                } else if (typeof id == "string") {
                    cName = id;
                }
                if (cName !== null) {
                    invalidatedAreas = await this.miDebugger.changeGlobalCVariable(cName, args.value);
                    response.body = { value: args.value };
                }
            }
            if (invalidatedAreas.length > 0) {
                // Trigger an update of invalidated areas.
                this.sendEvent(new DebugAdapter.InvalidatedEvent(invalidatedAreas));
            }
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 11, `Could not set ${args.name}: ${<string>err}`);
        }
    }

    protected pauseRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): void {
        this.miDebugger.interrupt().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 3, `Could not pause: ${msg.toString()}`);
        });
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): void {
        this.miDebugger.continue().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 2, `Could not continue: ${msg.toString()}`);
        });
    }

    protected stepInRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
        this.miDebugger.stepInto().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 4, `Could not step in: ${msg.toString()}`);
        });
    }

    protected stepOutRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
        this.miDebugger.stepOut().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 5, `Could not step out: ${msg.toString()}`);
        });
    }

    protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
        this.miDebugger.stepOver().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 6, `Could not step over: ${msg.toString()}`);
        });
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        const [threadId, level] = this.frameIdToThreadAndLevel(args.frameId);
        if (args.context == "watch" || args.context == "variables" || args.context == "hover") {
            this.miDebugger.evalExpression(args.expression, threadId, level).then((res) => {
                response.body = {
                    variablesReference: 0,
                    presentationHint: { kind: 'data' },
                    result: res ?? "not available"
                };
                this.sendResponse(response);
            }, (msg: Error) => {
                this.sendErrorResponse(response, 7, msg.toString());
            });
        } else {
            this.miDebugger.sendUserInput(args.expression, threadId, level).then(output => {
                if (typeof output == "undefined")
                    response.body = {
                        result: "",
                        variablesReference: 0
                    };
                else
                    response.body = {
                        result: JSON.stringify(output),
                        // presentationHint: { kind: 'data' },
                        variablesReference: 0
                    };
                this.sendResponse(response);
            }, (msg: Error) => {
                this.sendErrorResponse(response, 8, msg.toString());
            });
        }
    }

    protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
        this.miDebugger.goto(args.source.path, args.line).then(_done => {
            response.body = {
                targets: [{
                    id: 1,
                    label: args.source.name,
                    column: args.column,
                    line: args.line
                }]
            };
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 16, `Could not jump: ${msg.toString()}`);
        });
    }

    protected gotoRequest(response: DebugProtocol.GotoResponse, _args: DebugProtocol.GotoArguments): void {
        this.sendResponse(response);
    }
}

DebugSession.run(GDBDebugSession);
