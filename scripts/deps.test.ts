import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    findDependencyDirs,
    findUnsatisfiedNodeProjects,
    detectInstallCommand,
    linkDependencies,
    hasUnsatisfiedPythonProject,
    installMissingDependencies,
} from './deps.js';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-deps-'));
}

function writeFile(root: string, relPath: string, content = '{}') {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
}

describe('deps module test suite', () => {
    let root: string;

    beforeEach(() => {
        root = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('findDependencyDirs()', () => {
        it('finds installed node_modules and virtualenvs, including nested ones', () => {
            writeFile(root, 'node_modules/left-pad/index.js', 'module.exports = 1;');
            writeFile(root, '.venv/pyvenv.cfg', 'home = /usr');
            writeFile(root, 'packages/api/node_modules/dep/index.js', 'x');

            assert.deepEqual(findDependencyDirs(root), ['.venv', 'node_modules', 'packages/api/node_modules']);
        });

        it('ignores empty dependency directories and unrelated folders', () => {
            fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
            writeFile(root, 'src/index.ts', 'export {};');

            assert.deepEqual(findDependencyDirs(root), []);
        });

        it('does not descend into other janitor worktrees', () => {
            writeFile(root, '.janitor-worktree-foo-1/node_modules/dep/index.js', 'x');

            assert.deepEqual(findDependencyDirs(root), []);
        });
    });

    describe('findUnsatisfiedNodeProjects()', () => {
        it('reports the workspace root when package.json has no node_modules', () => {
            writeFile(root, 'package.json');

            assert.deepEqual(findUnsatisfiedNodeProjects(root), ['']);
        });

        it('skips projects that already have dependencies installed', () => {
            writeFile(root, 'package.json');
            writeFile(root, 'node_modules/dep/index.js', 'x');

            assert.deepEqual(findUnsatisfiedNodeProjects(root), []);
        });

        it('reports nested packages missing dependencies without recursing into node_modules', () => {
            writeFile(root, 'package.json');
            writeFile(root, 'node_modules/dep/package.json');
            writeFile(root, 'packages/api/package.json');

            assert.deepEqual(findUnsatisfiedNodeProjects(root), ['packages/api']);
        });

        it('returns nothing for a repository with no Node projects', () => {
            writeFile(root, 'go.mod', 'module example.com/x\n');

            assert.deepEqual(findUnsatisfiedNodeProjects(root), []);
        });
    });

    describe('detectInstallCommand()', () => {
        it('returns empty string when the directory is not a Node project', () => {
            assert.equal(detectInstallCommand(root), '');
        });

        it('prefers pnpm, then yarn, then npm ci based on lockfiles', () => {
            writeFile(root, 'package.json');
            assert.equal(detectInstallCommand(root), 'npm install');

            writeFile(root, 'package-lock.json');
            assert.equal(detectInstallCommand(root), 'npm ci');

            writeFile(root, 'yarn.lock', '');
            assert.equal(detectInstallCommand(root), 'yarn install --frozen-lockfile');

            writeFile(root, 'pnpm-lock.yaml', '');
            assert.equal(detectInstallCommand(root), 'pnpm install --frozen-lockfile');
        });

        it('treats npm-shrinkwrap.json as a clean-install lockfile', () => {
            writeFile(root, 'package.json');
            writeFile(root, 'npm-shrinkwrap.json');
            assert.equal(detectInstallCommand(root), 'npm ci');
        });
    });

    describe('hasUnsatisfiedPythonProject()', () => {
        it('is false when there is no Python manifest', () => {
            writeFile(root, 'package.json');
            assert.equal(hasUnsatisfiedPythonProject(root), false);
        });

        it('is true when a Python manifest has no project-local virtualenv', () => {
            writeFile(root, 'requirements.txt', 'pytest\n');
            assert.equal(hasUnsatisfiedPythonProject(root), true);
        });

        it('is false once a virtualenv is present', () => {
            writeFile(root, 'pyproject.toml', '[project]\nname = "demo"\n');
            writeFile(root, '.venv/pyvenv.cfg', 'home = /usr');
            assert.equal(hasUnsatisfiedPythonProject(root), false);
        });
    });

    describe('installMissingDependencies()', () => {
        it('runs nothing for a workspace with no Node or Python projects', () => {
            writeFile(root, 'go.mod', 'module example.com/x\n');
            assert.deepEqual(installMissingDependencies(root), []);
        });

        it('runs nothing when Node dependencies are already installed', () => {
            writeFile(root, 'package.json');
            writeFile(root, 'node_modules/dep/index.js', 'x');
            assert.deepEqual(installMissingDependencies(root), []);
        });
    });

    describe('linkDependencies()', () => {
        it('symlinks dependency directories into the worktree so tests can resolve them', () => {
            writeFile(root, 'node_modules/left-pad/index.js', 'module.exports = 1;');
            const worktree = path.join(root, 'wt');
            fs.mkdirSync(worktree, { recursive: true });

            const linked = linkDependencies(root, worktree);

            assert.deepEqual(linked, ['node_modules']);
            assert.equal(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink(), true);
            assert.equal(
                fs.readFileSync(path.join(worktree, 'node_modules/left-pad/index.js'), 'utf-8'),
                'module.exports = 1;'
            );
        });

        it('links nested dependency directories only when the package exists in the worktree', () => {
            writeFile(root, 'packages/api/node_modules/dep/index.js', 'x');
            writeFile(root, 'packages/web/node_modules/dep/index.js', 'x');
            const worktree = path.join(root, 'wt');
            fs.mkdirSync(path.join(worktree, 'packages/api'), { recursive: true });

            const linked = linkDependencies(root, worktree);

            assert.deepEqual(linked, ['packages/api/node_modules']);
            assert.equal(fs.existsSync(path.join(worktree, 'packages/web')), false);
        });

        it('never overwrites dependencies already present in the worktree', () => {
            writeFile(root, 'node_modules/left-pad/index.js', 'from-root');
            const worktree = path.join(root, 'wt');
            writeFile(worktree, 'node_modules/left-pad/index.js', 'from-worktree');

            const linked = linkDependencies(root, worktree);

            assert.deepEqual(linked, []);
            assert.equal(
                fs.readFileSync(path.join(worktree, 'node_modules/left-pad/index.js'), 'utf-8'),
                'from-worktree'
            );
        });
    });
});
