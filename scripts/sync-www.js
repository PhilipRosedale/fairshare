#!/usr/bin/env node
// Cross-platform www/ sync (replaces rsync for Windows and Mac).
// Mirrors the exclude list in package.json "build" script.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const EXCLUDE = new Set([
    'node_modules',
    'ios',
    'android',
    'www',
    '.git',
    '.github',
    '.well-known',
    '.cursor',
    'docs',
    'deploy',
    'sql',
    'supabase',
    'scripts',
    'package.json',
    'package-lock.json',
    'capacitor.config.json',
    'CNAME',
    'README.md',
]);

function shouldExclude(name) {
    return EXCLUDE.has(name);
}

function rmDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) rmDir(full);
        else fs.unlinkSync(full);
    }
    fs.rmdirSync(dir);
}

function copyEntry(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            if (shouldExclude(entry.name)) continue;
            copyEntry(path.join(src, entry.name), path.join(dest, entry.name));
        }
    } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

function sync() {
    if (fs.existsSync(WWW)) rmDir(WWW);
    fs.mkdirSync(WWW, { recursive: true });

    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (shouldExclude(entry.name)) continue;
        copyEntry(path.join(ROOT, entry.name), path.join(WWW, entry.name));
    }

    console.log('sync-www: copied web assets to www/');
}

sync();
