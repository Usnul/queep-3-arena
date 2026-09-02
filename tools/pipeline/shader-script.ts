/*
 * shader-script.ts -- structural reader for Quake III `.shader` scripts.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * **This is not a `.shader` interpreter, and must not become one.**
 *
 * It reads the file's *structure* -- shader name, global directives, stage
 * directives -- and hands back the tokens. It never evaluates a `tcMod`,
 * `rgbGen`, `deformVertexes` or blend equation; those are 1999 fixed-function
 * tricks and the port drops them (brief section 2). Everything the reader
 * produces is consumed once, offline, by `shader-to-pbr.ts`, which picks out the
 * dozen or so directives that carry information a PBR material can represent.
 *
 * The distinction matters because the temptation to "just handle one more
 * directive" is how a 200-line extractor turns into a renderer.
 */

export interface ShaderStage {
    /** Raw directive lines inside `{ ... }`, each already split into tokens. */
    readonly directives: readonly (readonly string[])[];
}

export interface ShaderScriptEntry {
    /** Shader name, lowercased. Doubles as a texture path when no script defines it. */
    readonly name: string;
    /** Top-level directives, outside any stage block. */
    readonly directives: readonly (readonly string[])[];
    readonly stages: readonly ShaderStage[];
    /** File this came from, for diagnostics and for reporting conflicts. */
    readonly source: string;
}

/**
 * Tokenize a `.shader` file.
 *
 * Q3's tokenizer treats `{` and `}` as standalone tokens even when not
 * whitespace-separated, strips `//` line comments, and is otherwise
 * whitespace-delimited. `/* *\/` block comments appear in a handful of OA
 * scripts and Q3's parser does handle them, so they are handled here too.
 */
function tokenize(source: string): string[] {
    const tokens: string[] = [];
    let i = 0;
    const n = source.length;

    while (i < n) {
        const c = source[i]!;

        if (c <= ' ') {
            i += 1;
            continue;
        }

        if (c === '/' && source[i + 1] === '/') {
            while (i < n && source[i] !== '\n') i += 1;
            continue;
        }

        if (c === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }

        if (c === '{' || c === '}') {
            tokens.push(c);
            i += 1;
            continue;
        }

        if (c === '"') {
            i += 1;
            const start = i;
            while (i < n && source[i] !== '"') i += 1;
            tokens.push(source.slice(start, i));
            i += 1;
            continue;
        }

        const start = i;
        while (i < n) {
            const d = source[i]!;
            if (d <= ' ' || d === '{' || d === '}') break;
            if (d === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) break;
            i += 1;
        }
        tokens.push(source.slice(start, i));
    }

    return tokens;
}

/**
 * Group a token stream into directive lines.
 *
 * `.shader` files are line-oriented in practice but the tokenizer above has
 * discarded newlines, so lines are reconstructed the way Q3's parser effectively
 * does: a directive runs until the next token that starts a new one. Q3 gets
 * away with this because every directive it cares about has a known arity.
 *
 * Rather than encode arities for directives the port ignores anyway, this splits
 * on newlines *before* tokenizing each line. Simpler, and correct for every file
 * in the OA set.
 */
function directiveLines(block: string): (readonly string[])[] {
    const out: (readonly string[])[] = [];

    for (const rawLine of block.split('\n')) {
        const line = tokenize(rawLine);
        if (line.length === 0) continue;
        out.push(line);
    }

    return out;
}

/**
 * Parse one `.shader` file into entries.
 *
 * Malformed entries are skipped with a warning rather than aborting: the OA
 * shader set contains several files with unbalanced braces that the real Q3
 * parser also silently tolerates, and refusing to load 103 good files over one
 * bad one is not useful.
 */
export function parseShaderScript(
    source: string,
    filename: string,
    onWarning: (message: string) => void = () => {}
): ShaderScriptEntry[] {
    const out: ShaderScriptEntry[] = [];

    // Work line-wise so directive grouping is trivial, but track brace depth so
    // stage blocks are separated from globals.
    const lines = source.split('\n');

    let i = 0;
    const n = lines.length;

    /** Strip comments from a line and return its tokens. */
    const lineTokens = (s: string): string[] => tokenize(s);

    while (i < n) {
        // Find a shader name: a lone token at depth 0.
        let nameTokens = lineTokens(lines[i]!);
        i += 1;

        if (nameTokens.length === 0) continue;
        if (nameTokens[0] === '{' || nameTokens[0] === '}') continue;

        // The opening brace may be on the name line or the next non-blank line.
        let sawOpen = nameTokens.includes('{');

        while (!sawOpen && i < n) {
            const t = lineTokens(lines[i]!);
            i += 1;
            if (t.length === 0) continue;
            if (t[0] === '{') {
                sawOpen = true;
                break;
            }
            /*
             A second bare token before any brace means the previous one was not
             a shader name after all -- treat this one as the name instead, and
             then ask the replacement the same question the first line was asked.
             `sawOpen` used to be answered for the discarded line only, so a
             corrected name that opened its own block -- `foo {` -- fell through
             to the next line and lost its brace.
            */
            nameTokens = t;
            sawOpen = t.includes('{');
        }

        /*
         **The name is read after the loop that decides what the name is**, and
         used to be read before it. A shader reached by the correction above was
         filed under the token that was thrown away: the entry parsed correctly,
         in full, under the wrong key -- which is a shader that silently does not
         exist, and whose surfaces fall through `ShaderIndex.material` to the
         implicit-texture branch with no stages, no glow and no transparency.

         Five of OA's 2,226 were in that state and all five for one reason: a
         block comment more than one line long sitting directly above the
         declaration. The tokenizer does understand block comments, but it is
         applied *per line* here -- see the note above `directiveLines` -- so it
         strips one that opens and closes on a single line and never sees the
         continuation of one that does not. `weaponhits.shader` writes
         `take care when using it` on the closing line of a two-line comment
         above three of its explosions, which reads as a shader named `take`;
         `shells.shader` closes a 40-line commented-out block with a terminator
         alone on the line above `powerups/quad`, which reads as a shader whose
         name is that terminator. Both then hit the correction above, and both
         were filed under the prose.

         Carrying comment state across lines would be the deeper repair and is
         deliberately not this one: the line-oriented reader is a documented
         choice, and a block comment that *ended* mid-line would still land here.
         Reading the name after the loop costs nothing and is right either way.
        */
        const name = nameTokens[0]!.replace(/\\/g, '/').toLowerCase();

        if (!sawOpen) {
            onWarning(`${filename}: '${name}' has no opening brace; skipped`);
            continue;
        }

        const globals: (readonly string[])[] = [];
        const stages: ShaderStage[] = [];

        let depth = 1;
        let stageBuffer: string[] | null = null;

        while (i < n && depth > 0) {
            const raw = lines[i]!;
            i += 1;

            const t = lineTokens(raw);
            if (t.length === 0) continue;

            /*
             A brace is applied wherever it appears on the line, not only when it
             is the first token.

             Q3's tokenizer reads token by token and carries on with whatever
             follows a brace; this reader is line-oriented and drops it, because
             separating `{ map $lightmap blendfunc filter }` back into three
             directives needs the per-directive arities the note above
             `directiveLines` explains this reader does not have. Thirty-six lines
             across five OA scripts are written that way, none of them on a
             converted map.

             What is *not* optional is the depth. Reading the braces only in
             leading position left a line ending in `}` never closing its stage,
             so the rest of the shader was swallowed into that stage and the entry
             ended short a brace -- a whole shader misread, rather than one line
             of it. The tokens are still dropped; they are now warned about, and
             the structure around them survives.
            */
            const braces = t.filter((x) => x === '{' || x === '}');

            if (braces.length > 0) {
                if (braces.length !== t.length) {
                    onWarning(
                        `${filename}: '${name}': ${t.length - braces.length} token(s) share a brace line and are dropped`
                    );
                }

                for (const brace of braces) {
                    if (brace === '{') {
                        depth += 1;
                        if (depth === 2) stageBuffer = [];
                    } else {
                        depth -= 1;
                        if (depth === 1 && stageBuffer !== null) {
                            stages.push({ directives: directiveLines(stageBuffer.join('\n')) });
                            stageBuffer = null;
                        }
                        // The entry ended; anything after this brace is the next one's.
                        if (depth <= 0) break;
                    }
                }

                continue;
            }

            if (stageBuffer !== null) {
                stageBuffer.push(raw);
            } else {
                globals.push(t);
            }
        }

        if (depth > 0) {
            onWarning(`${filename}: '${name}' is missing ${depth} closing brace(s); kept as-is`);
        }

        out.push({ name, directives: globals, stages, source: filename });
    }

    return out;
}

/** First directive matching `keyword` (case-insensitive), or `null`. */
export function directive(
    directives: readonly (readonly string[])[],
    keyword: string
): readonly string[] | null {
    const want = keyword.toLowerCase();
    for (const d of directives) {
        if (d[0]?.toLowerCase() === want) return d;
    }
    return null;
}

/** Every directive matching `keyword` (case-insensitive). */
export function directivesAll(
    directives: readonly (readonly string[])[],
    keyword: string
): (readonly string[])[] {
    const want = keyword.toLowerCase();
    return directives.filter((d) => d[0]?.toLowerCase() === want);
}
