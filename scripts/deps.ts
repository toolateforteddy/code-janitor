import * as fs from 'fs';
import * as path from 'path';
import { installCmd, autoInstall, installTimeoutMs } from './config.js';
import { runCmd } from './git.js';

/**
 * Dependency directories that live inside the repository but are (almost always)
 * gitignored, so a freshly created `git worktree` checkout does not have them.
 * Go module/Cargo/Gradle caches are shared per-machine outside the repo, which is
 * why only Node/Python style projects break inside worktrees.
 */
export const LINKABLE_DEP_DIRS = ['node_modules', '.venv', 'venv'];

const IGNORED_SCAN_DIRS = new Set(['.git', 'dist', 'build', 'target', 'vendor', 'generated', '.gradle', '.idea', '.next', 'coverage']);
const MAX_SCAN_DEPTH = 3;

function isJanitorWorktreeDir(name: string): boolean {
    return name.startsWith('.janitor-worktree-') || name.startsWith('.janitor-test-worktree-');
}

function scan(rootDir: string, onDir: (relPath: string, absPath: string) => boolean | void): void {
    const walk = (currentDir: string, relativePrefix: string, depth: number) => {
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (IGNORED_SCAN_DIRS.has(entry.name) || isJanitorWorktreeDir(entry.name)) continue;

            const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
            const absPath = path.join(currentDir, entry.name);

            // `onDir` returns true when it claims the directory (e.g. it *is* a
            // dependency dir), in which case we never descend into it.
            if (onDir(relPath, absPath)) continue;
            if (depth < MAX_SCAN_DEPTH) walk(absPath, relPath, depth + 1);
        }
    };
    walk(rootDir, '', 1);
}

function isNonEmptyDir(absPath: string): boolean {
    try {
        if (!fs.statSync(absPath).isDirectory()) return false;
        return fs.readdirSync(absPath).length > 0;
    } catch {
        return false;
    }
}

function pathExists(absPath: string): boolean {
    try {
        // lstat, not existsSync: a broken symlink still occupies the path and
        // must not be silently replaced.
        fs.lstatSync(absPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Finds installed dependency directories (node_modules, .venv, ...) inside a
 * workspace, relative to its root. Nested matches are reported too so monorepo
 * layouts like `packages/api/node_modules` are covered.
 */
export function findDependencyDirs(rootDir: string): string[] {
    const found: string[] = [];
    scan(rootDir, (relPath, absPath) => {
        const baseName = path.basename(relPath);
        if (!LINKABLE_DEP_DIRS.includes(baseName)) return false;
        if (isNonEmptyDir(absPath)) found.push(relPath);
        return true;
    });
    return found.sort();
}

/**
 * Finds directories holding a package.json but no installed node_modules —
 * i.e. Node projects whose tests would fail with "Cannot find module".
 */
export function findUnsatisfiedNodeProjects(rootDir: string): string[] {
    const found: string[] = [];

    const check = (relPath: string, absPath: string) => {
        if (!fs.existsSync(path.join(absPath, 'package.json'))) return;
        if (isNonEmptyDir(path.join(absPath, 'node_modules'))) return;
        found.push(relPath);
    };

    check('', rootDir);
    scan(rootDir, (relPath, absPath) => {
        if (LINKABLE_DEP_DIRS.includes(path.basename(relPath))) return true;
        check(relPath, absPath);
        return false;
    });

    return found;
}

const PYTHON_MANIFESTS = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'];

/**
 * True when the workspace declares a Python project but carries no project-local
 * virtualenv. Such a repo either relies on a globally installed interpreter
 * environment (fine) or needs an explicit INSTALL_CMD (see installMissingDependencies).
 */
export function hasUnsatisfiedPythonProject(dir: string): boolean {
    const hasManifest = PYTHON_MANIFESTS.some(file => fs.existsSync(path.join(dir, file)));
    if (!hasManifest) return false;
    return !findDependencyDirs(dir).some(rel => rel === '.venv' || rel === 'venv');
}

/**
 * Picks the install command for a Node project from its lockfile, mirroring what
 * a CI setup step would run. Returns '' when the directory is not a Node project.
 */
export function detectInstallCommand(dir: string): string {
    const has = (file: string) => fs.existsSync(path.join(dir, file));
    if (!has('package.json')) return '';
    if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
    if (has('yarn.lock')) return 'yarn install --frozen-lockfile';
    if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm ci';
    return 'npm install';
}

/**
 * Symlinks dependency directories from the primary workspace into a worktree, so
 * `npm test` / `pytest` inside the worktree resolve the same packages the health
 * check on the main checkout already used — without paying for a reinstall per fix.
 */
export function linkDependencies(rootDir: string, worktreePath: string): string[] {
    const linked: string[] = [];

    for (const relPath of findDependencyDirs(rootDir)) {
        const source = path.resolve(rootDir, relPath);
        const destination = path.resolve(worktreePath, relPath);

        // Only link into a directory that exists in the worktree: a package dir
        // present in the main checkout but absent on the default branch means the
        // link would create a phantom (and untracked) directory tree.
        if (!fs.existsSync(path.dirname(destination))) continue;
        if (pathExists(destination)) continue;

        try {
            fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
            linked.push(relPath);
        } catch (err) {
            console.warn(`⚠️ Could not link dependencies '${relPath}' into worktree:`, err instanceof Error ? err.message : String(err));
        }
    }

    if (linked.length > 0) {
        console.log(`🔗 Linked ${linked.length} dependency director${linked.length === 1 ? 'y' : 'ies'} into worktree: ${linked.join(', ')}`);
    }
    return linked;
}

/**
 * Installs dependencies for Node projects that still have none, using INSTALL_CMD
 * when configured and an auto-detected lockfile command otherwise. Returns the
 * commands that ran successfully.
 */
export function installMissingDependencies(dir: string): string[] {
    const unsatisfied = findUnsatisfiedNodeProjects(dir);

    if (installCmd) {
        // An explicit command also covers ecosystems the janitor will not guess for
        // (pip/poetry/uv), so run it whenever anything looks uninstalled.
        if (unsatisfied.length === 0 && !hasUnsatisfiedPythonProject(dir)) return [];
        console.log(`📦 Installing dependencies via configured install command in ${dir}`);
        const res = runCmd(installCmd, 'install', installTimeoutMs, dir);
        if (!res.success) {
            console.warn(`⚠️ Install command failed; continuing with whatever is present.`);
            return [];
        }
        return [installCmd];
    }

    if (unsatisfied.length === 0) return [];

    if (!autoInstall) {
        console.warn(`⚠️ ${unsatisfied.length} project(s) missing dependencies and auto-install is disabled: ${unsatisfied.map(p => p || '.').join(', ')}`);
        return [];
    }

    const ran: string[] = [];
    for (const relPath of unsatisfied) {
        const projectDir = path.resolve(dir, relPath);
        // A root install with workspaces populates nested packages, so re-check.
        if (isNonEmptyDir(path.join(projectDir, 'node_modules'))) continue;

        const command = detectInstallCommand(projectDir);
        if (!command) continue;

        console.log(`📦 Installing dependencies for '${relPath || '.'}'`);
        const res = runCmd(command, 'install', installTimeoutMs, projectDir);
        if (res.success) {
            ran.push(command);
        } else {
            console.warn(`⚠️ Install command '${command}' failed in '${relPath || '.'}'; continuing with whatever is present.`);
        }
    }
    return ran;
}

/**
 * Makes a freshly created worktree runnable: reuse the primary workspace's
 * installed dependencies where possible, install what is still missing otherwise.
 */
export function prepareWorktreeDependencies(rootDir: string, worktreePath: string): void {
    linkDependencies(rootDir, worktreePath);
    installMissingDependencies(worktreePath);
}
