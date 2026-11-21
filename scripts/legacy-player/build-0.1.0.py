#!/usr/bin/env python3
"""
Rebuild the "original" embed player 0.1.0 (pre-adoption correction, see EMBED.md).

0.1.0 is defined as: the player's control API as it was BEFORE the 10 Nov 2026 work (SR-3 pausable
clock/time API, SR-4 mount-failure events, labelled-node knob keys, ramp-stop knobs), i.e. the
player-side files at commit f631124, running on TODAY's renderer (which scenes from the current
editor need), PLUS the security fixes (bounded inflate, image data-URL guard, artifact shape check)
and the player-feedback behaviour (set() returns boolean, warn-once reports, capabilities).

What it does: restores src/embed/{player,perf-harness,index}.ts from BASE, patches them (every patch
asserts it matched exactly once), swaps in the legacy capability list and EMBED_VERSION 0.1.0, type-checks,
builds the embed bundle, copies the bytes to public/embed/, then restores your working files and
rebuilds the current player. Run from the repo root:  python3 scripts/legacy-player/build-0.1.0.py
"""
import re, shutil, subprocess, sys, os

BASE = 'f631124'
FILES = ['src/embed/player.ts', 'src/embed/perf-harness.ts', 'src/embed/index.ts', 'src/embed/feedback.ts', 'src/embed/version.ts']
OUT = 'public/embed/sombra-player.0.1.0.umd.js'
LEGACY_CAPS = ["knobs", "knobs.byNode", "clock.play", "events.load", "events.contextlost", "events.warning", "set.returnsBoolean", "capabilities"]

def sh(*a, check=True):
    r = subprocess.run(a, capture_output=True, text=True)
    if check and r.returncode != 0:
        print(r.stdout[-2000:], r.stderr[-2000:]); sys.exit(f'command failed: {" ".join(a)}')
    return r.stdout

def edit(s, a, b, n=1):
    assert s.count(a) == n, f'patch anchor matched {s.count(a)}x (expected {n}): {a[:70]!r}'
    return s.replace(a, b)

def between(s, start, end):
    i, j = s.index(start), s.index(end)
    return s[i:j]

backup = {f: open(f).read() for f in FILES}
current_player = backup['src/embed/player.ts']
try:
    old = {f: sh('git', 'show', f'{BASE}:{f}') for f in ['src/embed/player.ts', 'src/embed/perf-harness.ts', 'src/embed/index.ts']}

    # --- player.ts ---
    p = old['src/embed/player.ts']
    last_import = list(re.finditer(r"^import .*$", p, re.M))[-1]
    p = p[:last_import.end()] + "\nimport { CAPABILITIES, createReporter, closest, checkKnobValue } from './feedback'\nimport type { SombraWarning } from './feedback'\nimport { isSafeImageDataUrl } from './image-guard'" + p[last_import.end():]
    p = edit(p, "  set(key: string, value: number | number[]): void\n", "  /** Returns true when applied, false when not (never throws; the reason is reported once). */\n  set(key: string, value: number | number[]): boolean\n")
    p = edit(p, "  set(nodeId: string, param: string, value: number | number[]): void\n", "  set(nodeId: string, param: string, value: number | number[]): boolean\n")
    p = edit(p, "  on(event: 'load' | 'error' | 'contextlost', cb: (...a: unknown[]) => void): void\n}\n",
             "  /** 'warning' delivers a SombraWarning (non-fatal misuse, with a stable code). */\n  on(event: 'load' | 'error' | 'contextlost' | 'warning', cb: (...a: unknown[]) => void): void\n  /** What this player build can do: feature-detect instead of version-sniffing. */\n  readonly capabilities: readonly string[]\n}\n\nexport type { SombraWarning }\n\nconst EVENTS: readonly string[] = ['load', 'error', 'contextlost', 'warning']\n")
    p = edit(p, "const NOOP_HANDLE: SceneHandle = {\n  set() {}, get()", "const NOOP_HANDLE: SceneHandle = {\n  capabilities: CAPABILITIES,\n  set() { return false }, get()")
    p = edit(p, "  const emit = (ev: string, ...a: unknown[]) => (listeners[ev] ?? []).forEach((f) => f(...a))\n",
             "  const emit = (ev: string, ...a: unknown[]) => (listeners[ev] ?? []).forEach((f) => f(...a))\n  // Non-fatal misuse of the API: console.warn once per problem + the 'warning' event.\n  const report = createReporter((w) => emit('warning', w))\n")
    # the validated set/get implementation is shared with the current player: take it verbatim
    new_block = between(current_player, "  // set(key, value) OR set(nodeId, param, value) — arity disambiguates.", "  const withValue =")
    old_block = between(p, "  // set(key, value) OR set(nodeId, param, value) — arity disambiguates.", "  const withValue =")
    p = p.replace(old_block, new_block)
    p = edit(p, "    const img = new Image()\n", "    // Only real, sanely-sized image data URLs (see src/embed/image-guard.ts).\n    if (!isSafeImageDataUrl(asset?.dataUrl)) continue\n    const img = new Image()\n")
    p = edit(p, "  const handle: SceneHandle = {\n    set: setImpl,", "  const handle: SceneHandle = {\n    capabilities: CAPABILITIES,\n    set: setImpl as SceneHandle['set'],")
    p = edit(p, "    on: (ev, cb) => {\n      (listeners[ev] ??= []).push(cb)",
             "    on: (ev, cb) => {\n      if (!EVENTS.includes(ev)) {\n        report({ code: 'UNKNOWN_EVENT', key: String(ev), message: `unknown event \"${String(ev)}\"; ignored.`, hint: `Supported: ${EVENTS.join(', ')}.` })\n        return\n      }\n      if (typeof cb !== 'function') {\n        report({ code: 'BAD_VALUE', key: `on:${ev}`, message: `on(\"${ev}\"): the callback must be a function.` })\n        return\n      }\n      (listeners[ev] ??= []).push(cb)")
    open('src/embed/player.ts', 'w').write(p)

    # --- index.ts ---
    i = old['src/embed/index.ts']
    i = edit(i, "import { configureEmbed } from './config'", "import { configureEmbed } from './config'\nimport { CAPABILITIES, supports } from './feedback'")
    i = edit(i, "export type { MountOptions, SceneHandle } from './player'", "export type { MountOptions, SceneHandle, SombraWarning } from './player'")
    i = edit(i, "export const version = EMBED_VERSION", "export const version = EMBED_VERSION\nexport { CAPABILITIES as capabilities, supports } from './feedback'")
    i = edit(i, "w.Sombra = { mount, init, get: getHandle, configure: configureEmbed, version }", "w.Sombra = { mount, init, get: getHandle, configure: configureEmbed, version, capabilities: CAPABILITIES, supports }")
    open('src/embed/index.ts', 'w').write(i)

    open('src/embed/perf-harness.ts', 'w').write(old['src/embed/perf-harness.ts'])

    # --- legacy capability list + version ---
    fb = backup['src/embed/feedback.ts']
    caps_block = between(fb, "export const CAPABILITIES: readonly string[] = [", "export function supports")
    fb = fb.replace(caps_block, "export const CAPABILITIES: readonly string[] = [\n" + "".join(f"  '{c}',\n" for c in LEGACY_CAPS) + "]\n\n")
    open('src/embed/feedback.ts', 'w').write(fb)
    open('src/embed/version.ts', 'w').write(edit(backup['src/embed/version.ts'], "export const EMBED_VERSION = '0.2.0'", "export const EMBED_VERSION = '0.1.0'"))

    print('type-checking the legacy sources...'); sh('npx', 'tsc', '-b')
    print('building...'); sh('npm', 'run', '-s', 'build:embed')
    shutil.copyfile('dist/embed/sombra-player.0.1.0.umd.js', OUT)
    print('wrote', OUT, os.path.getsize(OUT), 'bytes')
finally:
    for f, c in backup.items(): open(f, 'w').write(c)
    print('restored working sources; rebuilding the current player...')
    sh('npm', 'run', '-s', 'build:embed')
