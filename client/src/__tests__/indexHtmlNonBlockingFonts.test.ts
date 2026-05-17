/**
 * Guard the dashboard's first-paint boot path.
 *
 * Bug class: a render-blocking `<link rel="stylesheet">` to an external
 * host (Google Fonts) in <head> means a corporate DNS / ad-blocking DNS /
 * intercepting proxy that black-holes `fonts.googleapis.com` makes the
 * browser stall *before* React ever runs. That failure is invisible to
 * the React-Query fetch timeout (queryClient.ts), so the dashboard spins
 * forever on a blank page on affected desktops while mobile and clean
 * networks load fine.
 *
 * This test pins the mitigation: the Google Fonts stylesheet must be
 * loaded non-blocking (media="print" + onload swap), with a <noscript>
 * fallback for no-JS visitors, AND #root must contain a pre-React boot
 * marker so a bundle-load failure still shows something instead of a
 * white tab.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --test client/src/__tests__/indexHtmlNonBlockingFonts.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = resolve(__dirname, "..", "..", "index.html");

function readIndex(): string {
  return readFileSync(INDEX_HTML, "utf8");
}

describe("client/index.html — render-blocking guard", () => {
  it("does NOT load fonts.googleapis.com via a blocking stylesheet link", () => {
    const html = readIndex();
    // Find every stylesheet link tag that references fonts.googleapis.com.
    // A blocking link is one that does NOT carry media="print" (the swap
    // trick) — those are exactly the regression we want to prevent.
    const linkTagRegex = /<link\b[^>]*\bhref=["'][^"']*fonts\.googleapis\.com[^"']*["'][^>]*>/gi;
    const matches = html.match(linkTagRegex) ?? [];
    assert.ok(matches.length > 0, "expected at least one Google Fonts link in index.html");

    // Only the <noscript> fallback may be a plain `rel=stylesheet`. We
    // detect that by checking the surrounding context.
    for (const tag of matches) {
      const isNoscriptFallback = html.includes(`<noscript>\n      ${tag}`) ||
        html.includes(`<noscript>${tag}`) ||
        new RegExp(`<noscript>[\\s\\S]*?${tag.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[\\s\\S]*?</noscript>`).test(html);
      if (isNoscriptFallback) continue;

      const hasRelStylesheet = /\brel=["']stylesheet["']/i.test(tag);
      const hasMediaPrint = /\bmedia=["']print["']/i.test(tag);
      const isPreconnect = /\brel=["']preconnect["']/i.test(tag);

      if (isPreconnect) continue;

      assert.ok(
        !hasRelStylesheet || hasMediaPrint,
        `render-blocking Google Fonts <link> detected: ${tag}\n` +
        `Either keep media="print" with the onload swap, or move it into <noscript>.`,
      );
    }
  });

  it("swaps the deferred font stylesheet to media='all' on load", () => {
    const html = readIndex();
    // The onload swap is what actually applies the fonts once they've
    // loaded. If someone deletes it the page works but stays in fallback
    // fonts forever even on healthy networks — keep the swap pinned.
    const hasOnloadSwap = /onload=["']this\.media=['"]all['"]/i.test(html);
    assert.ok(
      hasOnloadSwap,
      "expected onload=\"this.media='all'…\" swap on the deferred font stylesheet",
    );
  });

  it("ships a pre-React boot marker inside #root so a bundle failure is visible", () => {
    const html = readIndex();
    // The exact pre-React placeholder copy can change; pin the structural
    // invariants instead. (1) #root must not be empty when the page is
    // first served — an empty #root means a bundle-load failure shows a
    // blank tab. (2) #boot-diagnostic + a 30s timer must be present so
    // long hangs surface DevTools instructions to the user.
    const rootOpenIdx = html.search(/<div\s+id=["']root["'][^>]*>/i);
    assert.ok(rootOpenIdx >= 0, "could not locate #root in index.html");
    const afterOpen = html.slice(rootOpenIdx).replace(/<div[^>]*>/i, "");
    // Require at least some visible text content before the closing
    // </div> that pairs with #root (i.e. between root open and the
    // first <script> tag at body level).
    const tailEnd = afterOpen.search(/<script\b/i);
    const rootSegment = tailEnd >= 0 ? afterOpen.slice(0, tailEnd) : afterOpen;
    assert.ok(
      rootSegment.replace(/<[^>]+>/g, "").trim().length > 0,
      "#root must contain visible pre-React placeholder text (currently empty)",
    );
    assert.match(
      html,
      /id=["']boot-diagnostic["']/,
      "expected a #boot-diagnostic element that surfaces after the boot timeout",
    );
    // The setTimeout(..., 30000) call should reference boot-diagnostic.
    // Don't pin the inner shape (function body, arrow vs function literal,
    // etc.) — just require the two tokens co-locate inside one <script>.
    const scriptBlocks = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
      .map((m) => m[1]);
    const hasBootTimer = scriptBlocks.some(
      (body) => body.includes("boot-diagnostic") && /\b30000\b/.test(body) && /setTimeout/.test(body),
    );
    assert.ok(
      hasBootTimer,
      "expected an inline <script> with setTimeout(..., 30000) that reveals #boot-diagnostic",
    );
  });
});
