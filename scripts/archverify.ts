import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EXEC_MAX_BUFFER } from './git.js';

/**
 * Checks what an architecture-docs edit adds against the repository as it stands.
 *
 * A repo map is only worth reading if every path, name and command in it is real, so an
 * edit the model proposes is kept only when everything new in it can be found: paths in
 * the tree, names in the code, and commands whose scripts, packages and tools exist.
 * Nothing here runs a command a doc mentions. A doc can name a deploy script as easily as
 * a test command, and a model's say-so is not enough to run either from CI.
 *
 * Markdown is never evidence: a name that only appears in a doc (the map itself, or a
 * design doc) has not been shown to exist in the code.
 */

/** Programs taken to exist without looking: they come from a toolchain, not the repo. */
const KNOWN_TOOLS = new Set([
    'bash', 'bun', 'cargo', 'cd', 'deno', 'docker', 'dotnet', 'gh', 'git', 'go', 'godot', 'gradle',
    'helm', 'java', 'jest', 'kubectl', 'make', 'mvn', 'node', 'npm', 'npx', 'pip', 'pip3', 'pnpm',
    'poetry', 'pytest', 'python', 'python3', 'rustup', 'sh', 'sqlx', 'swift', 'terraform', 'trunk',
    'tsc', 'tsx', 'uv', 'vitest', 'wasm-pack', 'xcodebuild', 'yarn',
]);

/** Package-manager subcommands that are not the names of package.json scripts. */
const PACKAGE_MANAGER_BUILTINS = new Set([
    'add', 'audit', 'build', 'ci', 'create', 'dlx', 'exec', 'i', 'init', 'install', 'link', 'list',
    'ls', 'outdated', 'pack', 'prune', 'publish', 'remove', 'rm', 'start', 'test', 'update', 'upgrade', 'why',
]);

/** Words in code spans that are syntax or prose rather than names the code must contain. */
const STOPWORDS = new Set([
    'a', 'an', 'and', 'async', 'await', 'const', 'def', 'else', 'false', 'fn', 'for', 'if', 'in',
    'is', 'let', 'mut', 'new', 'nil', 'none', 'None', 'not', 'null', 'of', 'or', 'pub', 'return',
    'self', 'Self', 'the', 'this', 'to', 'true', 'undefined', 'var', 'with',
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

/** Fence languages whose lines are commands to check; any other fence (a diagram, say) is not checked. */
const SHELL_FENCES = new Set(['bash', 'sh', 'shell', 'console', 'zsh']);

export interface VerifyResult {
    ok: boolean;
    /** Why the item could not be verified. Empty when it was. */
    reason: string;
}

const OK: VerifyResult = { ok: true, reason: '' };
const fail = (reason: string): VerifyResult => ({ ok: false, reason });

/** One thing an edit adds that has to be checked, and how. */
export interface DocItem {
    kind: 'code' | 'command' | 'link';
    text: string;
}

/** Inline code spans (`x`, ``x``), lines of shell fences, and relative link targets. */
export function extractDocItems(markdown: string): DocItem[] {
    const items: DocItem[] = [];
    const prose: string[] = [];
    let fence: { marker: string; shell: boolean } | null = null;
    for (const line of markdown.split('\n')) {
        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)/);
        if (fence) {
            if (fenceMatch && fenceMatch[1].startsWith(fence.marker)) {
                fence = null;
            } else if (fence.shell) {
                const command = line.trim().replace(/^\$\s+/, '').replace(/\s+#.*$/, '');
                if (command && !command.startsWith('#')) items.push({ kind: 'command', text: command });
            }
            continue;
        }
        if (fenceMatch) {
            fence = { marker: fenceMatch[1], shell: SHELL_FENCES.has(fenceMatch[2].toLowerCase()) };
            continue;
        }
        prose.push(line);
    }
    const text = prose.join('\n');
    for (const match of text.matchAll(/(`+)([\s\S]+?)\1/g)) {
        const span = match[2].trim();
        if (span) items.push({ kind: 'code', text: span });
    }
    const withoutCode = text.replace(/(`+)[\s\S]+?\1/g, '');
    for (const match of withoutCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
        items.push({ kind: 'link', text: target });
    }
    return items;
}

/** Items in `newText` that `oldText` did not already have: only what an edit adds is checked. */
export function addedDocItems(oldText: string, newText: string): DocItem[] {
    const before = new Map<string, number>();
    for (const item of extractDocItems(oldText)) {
        const key = `${item.kind}\0${item.text}`;
        before.set(key, (before.get(key) ?? 0) + 1);
    }
    const added: DocItem[] = [];
    const seen = new Set<string>();
    for (const item of extractDocItems(newText)) {
        const key = `${item.kind}\0${item.text}`;
        const remaining = before.get(key) ?? 0;
        if (remaining > 0) {
            before.set(key, remaining - 1);
            continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        added.push(item);
    }
    return added;
}

function globToRegExpSource(pattern: string): string {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                out += '.*';
                i++;
                if (pattern[i + 1] === '/') i++;
            } else {
                out += '[^/]*';
            }
        } else if (ch === '?') {
            out += '[^/]';
        } else if (ch === '<') {
            // A placeholder such as `set<N>` or `<id>-<slug>.toml` stands for some name.
            const close = pattern.indexOf('>', i);
            if (close === -1) {
                out += '<';
            } else {
                out += '[^/]+';
                i = close;
            }
        } else {
            out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return out;
}

/** Whether a code span reads as a path rather than a name or an expression. */
export function looksLikePath(span: string): boolean {
    if (/\s/.test(span) || span.includes('::') || span.includes('(')) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(span) && !span.startsWith('res://')) return false;
    return span.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(span);
}

/**
 * What the repository holds, read once from git at the commit the docs are refreshed
 * against: tracked files and their directories, and the names commands refer to.
 */
export class RepoIndex {
    readonly files: string[];
    readonly dirs: Set<string>;
    private readonly fileSet: Set<string>;
    private readonly grepCache = new Map<string, boolean>();
    private cargoPackages: Set<string> | null = null;
    private packageScripts: Set<string> | null = null;
    private makeTargets: Set<string> | null = null;

    constructor(readonly root: string, files?: string[]) {
        this.files = files ?? execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf-8', maxBuffer: EXEC_MAX_BUFFER })
            .split('\0').filter(Boolean);
        this.fileSet = new Set(this.files);
        this.dirs = new Set();
        for (const file of this.files) {
            let dir = path.posix.dirname(file);
            while (dir && dir !== '.' && !this.dirs.has(dir)) {
                this.dirs.add(dir);
                dir = path.posix.dirname(dir);
            }
        }
    }

    private exists(p: string): boolean {
        return this.fileSet.has(p) || this.dirs.has(p);
    }

    /**
     * Whether `raw` names a tracked file or directory: from the root, from `baseDir` (a
     * doc's own directory, for relative links), or as the tail of a longer path, since a
     * map names `fight/turn.rs` under a heading that already said `rust/engine/src/`.
     * Globs and `<placeholder>` segments match any name.
     */
    hasPath(raw: string, baseDir: string = ''): boolean {
        let p = raw.trim().replace(/^res:\/\//, '').replace(/[#?].*$/, '');
        if (!p || p.startsWith('/')) return false;
        p = p.replace(/^\.\//, '').replace(/\/+$/, '');
        if (!p || p === '.') return true;
        const candidates = [p];
        if (baseDir) candidates.push(path.posix.normalize(path.posix.join(baseDir, p)));
        if (!/[*?<]/.test(p)) {
            if (candidates.some(c => this.exists(c))) return true;
            if (p.startsWith('..')) return false;
            const suffix = '/' + p;
            return this.files.some(f => f.endsWith(suffix)) || [...this.dirs].some(d => d.endsWith(suffix));
        }
        const patterns = candidates.map(c => new RegExp(`(^|/)${globToRegExpSource(c)}$`));
        const matches = (entry: string) => patterns.some(re => re.test(entry));
        return this.files.some(matches) || [...this.dirs].some(matches);
    }

    /** `git grep` over tracked non-Markdown files. */
    private grep(args: string[], needle: string): boolean {
        const key = `${args.join(' ')}\0${needle}`;
        const cached = this.grepCache.get(key);
        if (cached !== undefined) return cached;
        let found: boolean;
        try {
            execFileSync('git', ['grep', '-q', '-I', ...args, '-e', needle, '--', '.', ':(exclude,glob)**/*.md', ':(exclude,glob)**/*.mdx', ':(exclude,glob)**/*.markdown'], {
                cwd: this.root, stdio: 'ignore', maxBuffer: EXEC_MAX_BUFFER,
            });
            found = true;
        } catch {
            found = false;
        }
        this.grepCache.set(key, found);
        return found;
    }

    hasLiteral(text: string): boolean {
        return this.grep(['-F'], text);
    }

    hasWord(word: string): boolean {
        return this.grep(['-F', '-w'], word);
    }

    private readTracked(pattern: RegExp): Array<{ file: string; content: string }> {
        return this.files.filter(f => pattern.test(f)).flatMap(file => {
            try {
                return [{ file, content: fs.readFileSync(path.join(this.root, file), 'utf-8') }];
            } catch {
                return [];
            }
        });
    }

    hasCargoPackage(name: string): boolean {
        if (!this.cargoPackages) {
            this.cargoPackages = new Set();
            for (const { content } of this.readTracked(/(^|\/)Cargo\.toml$/)) {
                for (const m of content.matchAll(/^\s*name\s*=\s*"([^"]+)"/gm)) this.cargoPackages.add(m[1]);
            }
        }
        return this.cargoPackages.has(name);
    }

    hasPackageScript(name: string): boolean {
        if (!this.packageScripts) {
            this.packageScripts = new Set();
            for (const { content } of this.readTracked(/(^|\/)package\.json$/)) {
                try {
                    Object.keys(JSON.parse(content).scripts ?? {}).forEach(s => this.packageScripts!.add(s));
                } catch {
                    // Not valid JSON: it names no scripts.
                }
            }
        }
        return this.packageScripts.has(name);
    }

    hasMakeTarget(name: string): boolean {
        if (!this.makeTargets) {
            this.makeTargets = new Set();
            for (const { content } of this.readTracked(/(^|\/)(GNUmakefile|[Mm]akefile|[^/]+\.mk)$/)) {
                for (const m of content.matchAll(/^([A-Za-z0-9_.%/-]+)\s*:(?!=)/gm)) this.makeTargets.add(m[1]);
            }
        }
        return this.makeTargets.has(name);
    }
}

function identifiersIn(span: string): string[] {
    return [...new Set(span.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])]
        .filter(id => id.length > 1 && !STOPWORDS.has(id));
}

/**
 * A code span: a path that must exist, or a name or expression whose identifiers must all
 * appear in the code. A span found verbatim in the code is real whatever its shape (a
 * route such as `/v1/account`, a flag, a string the code prints).
 */
export function verifyCodeSpan(span: string, index: RepoIndex, docDir: string = ''): VerifyResult {
    const text = span.trim();
    if (!text) return OK;
    // A bare flag says nothing checkable without the program it belongs to.
    if (/^--?[A-Za-z]/.test(text) && !/\s/.test(text)) return OK;
    // A file extension (`.uid`) is real if some tracked file has it.
    if (/^\.[A-Za-z0-9]{1,10}$/.test(text)) {
        return index.files.some(f => f.endsWith(text)) ? OK : fail(`no tracked file ends in \`${text}\``);
    }
    if (looksLikePath(text)) {
        if (index.hasPath(text, docDir)) return OK;
        if (index.hasLiteral(text)) return OK;
        return fail(`\`${text}\` is not a path in the repository`);
    }
    const first = text.split(/\s+/)[0];
    if (/\s/.test(text) && (KNOWN_TOOLS.has(first) || first.startsWith('./') || looksLikePath(first))) {
        return verifyCommand(text, index);
    }
    if (index.hasLiteral(text)) return OK;
    const missing = identifiersIn(text).filter(id => !index.hasWord(id));
    if (missing.length === 0) return OK;
    return fail(`\`${text}\`: ${missing.map(m => `\`${m}\``).join(', ')} not found in the code`);
}

/** Splits a command line into the segments `&&`, `||`, `;` and `|` separate. */
function commandSegments(command: string): string[][] {
    return command
        .split(/&&|\|\||;|\|/)
        .map(seg => seg.trim().split(/\s+/).map(w => w.replace(/^['"]|['"]$/g, '')).filter(Boolean))
        .filter(words => words.length > 0);
}

/**
 * A command line, checked without running it: every program is a known tool or a script
 * in the repository, `cd` targets and path arguments exist, and the packages, npm scripts
 * and make targets it names are defined somewhere in the tree.
 */
export function verifyCommand(command: string, index: RepoIndex): VerifyResult {
    let cwd = '';
    const pathFrom = (p: string) => index.hasPath(cwd ? path.posix.join(cwd, p) : p) || index.hasPath(p);
    for (const segment of commandSegments(command)) {
        let words = segment;
        while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
        if (words.length === 0) continue;
        const [program, ...args] = words;

        if (program === 'cd') {
            const target = args[0] ?? '';
            if (target && !pathFrom(target)) return fail(`\`${command}\`: no directory \`${target}\``);
            cwd = target ? path.posix.normalize(path.posix.join(cwd, target)) : '';
            continue;
        }
        if (program.includes('/')) {
            if (!pathFrom(program)) return fail(`\`${command}\`: no script \`${program}\``);
        } else if (!KNOWN_TOOLS.has(program) && !index.hasWord(program)) {
            return fail(`\`${command}\`: \`${program}\` is neither a known tool nor named in the code`);
        }

        // git's arguments are refs and remotes as often as paths; the program is all there is to check.
        if (program === 'git') continue;
        const programArgs = args.indexOf('--') === -1 ? args : args.slice(0, args.indexOf('--'));
        for (let i = 0; i < programArgs.length; i++) {
            const arg = programArgs[i];
            if (program === 'cargo' && (arg === '-p' || arg === '--package')) {
                const pkg = programArgs[i + 1];
                if (pkg && !index.hasCargoPackage(pkg)) return fail(`\`${command}\`: no Cargo package \`${pkg}\``);
                i++;
                continue;
            }
            if (arg.startsWith('-')) continue;
            if (arg.includes('/') && looksLikePath(arg)) {
                if (!pathFrom(arg)) return fail(`\`${command}\`: no path \`${arg}\``);
            }
        }

        const firstArg = programArgs.find(a => !a.startsWith('-'));
        if (['npm', 'pnpm', 'yarn', 'bun'].includes(program) && firstArg) {
            const isRun = firstArg === 'run' || firstArg === 'run-script';
            const script = isRun ? programArgs[programArgs.indexOf(firstArg) + 1] : firstArg;
            const implicitScript = program !== 'npm' && !PACKAGE_MANAGER_BUILTINS.has(firstArg);
            if (script && (isRun || implicitScript) && !index.hasPackageScript(script)) {
                return fail(`\`${command}\`: no package.json script \`${script}\``);
            }
        }
        if (program === 'make' && firstArg && !index.hasMakeTarget(firstArg)) {
            return fail(`\`${command}\`: no make target \`${firstArg}\``);
        }
    }
    return OK;
}

/** A link target, relative to the doc that holds it. */
export function verifyLink(target: string, index: RepoIndex, docDir: string): VerifyResult {
    const p = target.replace(/[#?].*$/, '');
    if (!p) return OK;
    const resolved = path.posix.normalize(path.posix.join(docDir, p)).replace(/\/+$/, '');
    if (resolved.startsWith('..')) return fail(`link \`${target}\` points outside the repository`);
    if (index.files.includes(resolved) || index.dirs.has(resolved)) return OK;
    return fail(`link \`${target}\` does not resolve to a file in the repository`);
}

export function verifyDocItem(item: DocItem, index: RepoIndex, docDir: string): VerifyResult {
    switch (item.kind) {
        case 'command': return verifyCommand(item.text, index);
        case 'link': return verifyLink(item.text, index, docDir);
        default: return verifyCodeSpan(item.text, index, docDir);
    }
}
