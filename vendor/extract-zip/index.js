const debug = require('debug')('extract-zip');
const { createWriteStream, promises: fs } = require('fs');
const getStream = require('get-stream');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const yauzl = require('yauzl');

const openZip = promisify(yauzl.open);
const pipeline = promisify(stream.pipeline);

function assertSafeEntry(targetDir, fileName) {
    const normalizedName = String(fileName || '').replace(/\\/g, '/');
    if (!normalizedName || normalizedName.startsWith('/') || /^[A-Za-z]:\//.test(normalizedName)) {
        throw new Error(`Unsafe archive path "${fileName}"`);
    }

    const destination = path.resolve(targetDir, normalizedName);
    const relativeDestination = path.relative(targetDir, destination);
    if (
        relativeDestination === '..' ||
        relativeDestination.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeDestination)
    ) {
        throw new Error(`Out of bound path found while processing file ${fileName}`);
    }

    return destination;
}

class Extractor {
    constructor(zipPath, opts) {
        this.zipPath = zipPath;
        this.opts = opts;
    }

    async extract() {
        debug('opening', this.zipPath, 'with opts', this.opts);
        this.zipfile = await openZip(this.zipPath, { lazyEntries: true });
        this.canceled = false;

        return new Promise((resolve, reject) => {
            this.zipfile.on('error', error => {
                this.canceled = true;
                reject(error);
            });
            this.zipfile.readEntry();

            this.zipfile.on('close', () => {
                if (!this.canceled) resolve();
            });

            this.zipfile.on('entry', async entry => {
                if (this.canceled) return;
                try {
                    if (entry.fileName.startsWith('__MACOSX/')) {
                        this.zipfile.readEntry();
                        return;
                    }

                    assertSafeEntry(this.opts.dir, entry.fileName);
                    await this.extractEntry(entry);
                    this.zipfile.readEntry();
                } catch (error) {
                    this.canceled = true;
                    this.zipfile.close();
                    reject(error);
                }
            });
        });
    }

    async extractEntry(entry) {
        if (this.canceled) return;
        if (this.opts.onEntry) this.opts.onEntry(entry, this.zipfile);

        const dest = assertSafeEntry(this.opts.dir, entry.fileName);
        const mode = (entry.externalFileAttributes >> 16) & 0xFFFF;
        const IFMT = 61440;
        const IFDIR = 16384;
        const IFLNK = 40960;
        const symlink = (mode & IFMT) === IFLNK;
        if (symlink) throw new Error(`Symlink archive entry rejected: ${entry.fileName}`);

        let isDir = (mode & IFMT) === IFDIR;
        if (!isDir && entry.fileName.endsWith('/')) isDir = true;
        const madeBy = entry.versionMadeBy >> 8;
        if (!isDir) isDir = madeBy === 0 && entry.externalFileAttributes === 16;

        const procMode = this.getExtractedMode(mode, isDir) & 0o777;
        const destDir = isDir ? dest : path.dirname(dest);
        const mkdirOptions = { recursive: true };
        if (isDir) mkdirOptions.mode = procMode;
        await fs.mkdir(destDir, mkdirOptions);
        if (isDir) return;

        const readStream = await promisify(this.zipfile.openReadStream.bind(this.zipfile))(entry);
        await pipeline(readStream, createWriteStream(dest, { mode: procMode, flags: 'wx' }));
    }

    getExtractedMode(entryMode, isDir) {
        let mode = entryMode;
        if (mode === 0) {
            mode = isDir
                ? parseInt(this.opts.defaultDirMode, 10) || 0o755
                : parseInt(this.opts.defaultFileMode, 10) || 0o644;
        }
        return mode;
    }
}

module.exports = async function extractZip(zipPath, opts) {
    if (!opts || !path.isAbsolute(opts.dir)) {
        throw new Error('Target directory is expected to be absolute');
    }

    await fs.mkdir(opts.dir, { recursive: true });
    opts.dir = await fs.realpath(opts.dir);
    return new Extractor(zipPath, opts).extract();
};
