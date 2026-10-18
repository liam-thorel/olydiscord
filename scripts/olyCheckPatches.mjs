/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Liam Thorel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// @ts-check

/**
 * Vérifie que les patchs d'OLYDISCORD s'appliquent toujours au code actuel de Discord.
 *
 * Télécharge le client web de Discord (le même code que l'appli de bureau), puis pour chaque patch de
 * src/olyplugins/olydiscord.desktop/patches.ts :
 *   - `find` doit désigner exactement un module webpack ;
 *   - chaque `match` doit y trouver au moins une occurrence (une seule de préférence) ;
 *   - le code patché doit rester du JavaScript valide.
 * Les motifs sont préparés avec les fonctions de Vencord (canonicalizeMatch / canonicalizeReplace),
 * donc exactement comme dans le client.
 *
 * Usage : node scripts/olyCheckPatches.mjs [--report rapport.md] [--cache dossier]
 * Code de sortie : 0 si tout va bien, 1 si au moins un patch est cassé.
 * Le code de Discord est seulement lu et analysé : il n'est jamais exécuté.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import esbuild from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const argValue = name => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
};
const REPORT_PATH = argValue("--report");
const CACHE_DIR = resolve(argValue("--cache") ?? join(tmpdir(), "olydiscord-discord-assets"));
const BASE = "https://discord.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const PARALLEL = 24;

// ── Patchs et utilitaires Vencord, compilés à la volée ─────────────────────────

async function loadPatches() {
    const result = await esbuild.build({
        stdin: {
            contents: [
                `export { patches } from "./src/olyplugins/olydiscord.desktop/patches.ts";`,
                `export { canonicalizeMatch, canonicalizeReplace } from "./src/utils/patches.ts";`,
            ].join("\n"),
            resolveDir: ROOT,
            loader: "ts",
        },
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        logLevel: "silent",
    });
    const code = result.outputFiles[0].text;
    return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

// ── Téléchargement du client web de Discord ─────────────────────────────────

async function fetchText(path) {
    const file = join(CACHE_DIR, path.replace(/^\/assets\//, ""));
    // les fichiers d'assets sont nommés par leur hash : une copie en cache reste valable
    if (path.startsWith("/assets/") && existsSync(file)) return readFileSync(file, "utf8");
    const res = await fetch(BASE + path, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    const text = await res.text();
    if (path.startsWith("/assets/")) writeFileSync(file, text);
    return text;
}

async function downloadDiscord() {
    mkdirSync(CACHE_DIR, { recursive: true });
    const html = await fetchText("/app");
    const initial = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
    const webPath = initial.find(p => /\/web\.[0-9a-f]+\.js$/.test(p));
    if (!webPath) throw new Error("Bundle web.*.js introuvable dans discord.com/app");
    const web = await fetchText(webPath);

    // morceaux chargés à la demande : "123"===e?""+e+".hash.js" puis table de repli ""+({123:"hash"})[e]+".js"
    const lazy = [...web.matchAll(/"(\d+)"===e\?""\+e\+"\.([0-9a-f]+)\.js"/g)].map(m => `/assets/${m[1]}.${m[2]}.js`);
    const mapEnd = web.indexOf('})[e]+".js"');
    if (mapEnd !== -1) {
        const mapStart = web.lastIndexOf("({", mapEnd);
        const table = web.slice(mapStart + 1, mapEnd + 1);
        lazy.push(...[...table.matchAll(/:"([0-9a-f]+)"/g)].map(m => `/assets/${m[1]}.js`));
    }

    const paths = [...new Set([...initial, ...lazy])];
    const files = new Map();
    let failed = 0;
    const queue = [...paths];
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while (queue.length) {
            const path = queue.shift();
            try {
                files.set(path, await fetchText(path));
            } catch {
                failed++;
            }
        }
    }));
    return { files, total: paths.length, failed, web: webPath };
}

// ── Découpage en modules webpack ────────────────────────────────────────────

/** En-têtes de module : `123(e,t,n){`, `123:(e,t,n)=>{` ou `123:function(e,t,n){` */
const MODULE_HEAD = /[{,](\d+)(?::function|:)?\((\w+(?:,\w+){0,2})?\)(?:=>)?\{/g;

function* modulesOf(path, code) {
    const heads = [...code.matchAll(MODULE_HEAD)].map(m => ({ index: m.index + 1, id: m[1] }));
    for (let i = 0; i < heads.length; i++) {
        yield { path, id: heads[i].id, start: heads[i].index, end: heads[i + 1]?.index ?? code.length };
    }
}

// ── Vérification ────────────────────────────────────────────────────────────

const PLUGIN_PATH = 'Vencord.Plugins.plugins["OLYDISCORD"]';

function checkPatch(patch, allModules, files, { canonicalizeMatch, canonicalizeReplace }) {
    const find = canonicalizeMatch(patch.find);
    const hits = allModules.filter(m => {
        const code = files.get(m.path).slice(m.start, m.end);
        return typeof find === "string" ? code.includes(find) : find.test(code);
    });
    // un même module (même id) peut être livré dans plusieurs fichiers : webpack n'en charge qu'un,
    // mais on ne sait pas lequel, donc chaque copie doit pouvoir être patchée
    const ids = new Set(hits.map(m => m.id));
    /** @type {{ find: string; modules: number; copies: number; replacements: { match: string; count: number; applied: boolean }[]; syntax: true | string | null; ok: boolean }} */
    const result = { find: String(patch.find), modules: ids.size, copies: hits.length, replacements: [], syntax: null, ok: true };

    if (ids.size !== 1) {
        result.ok = false;
        return result;
    }

    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    result.replacements = replacements.map(r => ({ match: String(r.match), count: Infinity, applied: true }));

    for (const mod of hits) {
        const fileCode = files.get(mod.path);
        let code = fileCode.slice(mod.start, mod.end);
        replacements.forEach((r, i) => {
            const match = canonicalizeMatch(r.match);
            const replace = canonicalizeReplace(r.replace, PLUGIN_PATH);
            const count = typeof match === "string"
                ? code.split(match).length - 1
                : [...code.matchAll(new RegExp(match.source, match.flags.includes("g") ? match.flags : match.flags + "g"))].length;
            const next = code.replace(match, replace);
            const rep = result.replacements[i];
            rep.count = Math.min(rep.count, count);
            if (next === code) {
                rep.applied = false;
                result.ok = false;
            }
            code = next;
        });

        // le fichier entier, avec le module patché, doit rester valide
        try {
            new Function(fileCode.slice(0, mod.start) + code + fileCode.slice(mod.end));
            result.syntax ??= true;
        } catch (e) {
            result.syntax = `${mod.path} : ${e instanceof Error ? e.message : e}`;
            result.ok = false;
        }
    }
    return result;
}

function formatReport(results, meta) {
    const ok = results.every(r => r.ok);
    const lines = [
        `# Patchs OLYDISCORD : ${ok ? "✅ tous valides" : "❌ au moins un patch cassé"}`,
        "",
        `Code de Discord du ${new Date().toISOString().slice(0, 10)} (${meta.web}, ${meta.total} fichiers` +
        (meta.failed ? `, ${meta.failed} non téléchargés` : "") + ").",
        "",
    ];
    for (const r of results) {
        lines.push(`## ${r.ok ? "✅" : "❌"} find \`${r.find}\`` + (r.copies > 1 && r.modules === 1 ? ` (1 module, ${r.copies} copies vérifiées)` : ""));
        if (r.modules !== 1) {
            lines.push(r.modules === 0
                ? "- Aucun module ne contient ce `find` : Discord a renommé ou déplacé ce code."
                : `- ${r.modules} modules contiennent ce \`find\` : il n'est plus assez précis.`);
        }
        for (const rep of r.replacements) {
            const status = !rep.applied ? "❌ aucune correspondance" : rep.count > 1 ? `⚠ ${rep.count} correspondances (seule la première est patchée)` : "✅";
            lines.push(`- ${status} : \`${rep.match}\``);
        }
        if (r.syntax !== null && r.syntax !== true) lines.push(`- ❌ Le code patché n'est plus du JavaScript valide : ${r.syntax}`);
        lines.push("");
    }
    if (!ok) {
        lines.push("Corrige les motifs dans `src/olyplugins/olydiscord.desktop/patches.ts`, puis relance `node scripts/olyCheckPatches.mjs`.");
    }
    return { ok, text: lines.join("\n") };
}

const { patches, canonicalizeMatch, canonicalizeReplace } = await loadPatches();
console.error(`Téléchargement du client web de Discord (cache : ${CACHE_DIR})…`);
const discord = await downloadDiscord();
console.error(`${discord.files.size}/${discord.total} fichiers récupérés. Vérification de ${patches.length} patchs…`);

const allModules = [...discord.files].flatMap(([path, code]) => [...modulesOf(path, code)]);
const results = patches.map(p => checkPatch(p, allModules, discord.files, { canonicalizeMatch, canonicalizeReplace }));
const report = formatReport(results, discord);

console.log(report.text);
if (REPORT_PATH) writeFileSync(REPORT_PATH, report.text);
process.exitCode = report.ok ? 0 : 1;
