/**
 * PDF export layout: content stays inside the sheet.
 *
 * html2pdf lays the export out in a box exactly as wide as the A4 printable
 * area, rasterizes it, and slices the bitmap into pages. Two things follow, and
 * both used to go wrong: anything wider than that box is missing from the right
 * of the page, and without page-break rules the slice lands wherever it lands —
 * through the middle of a paragraph.
 *
 * So the assertions here are geometric. One test measures the exported layout at
 * the real export width; another drives html2pdf's own container — the DOM its
 * page-break plugin has just finished padding — and checks that no block spans a
 * page boundary and that the sheets stay full. Both carry a control run of the
 * untreated content, so a test that stopped exercising the fix would fail rather
 * than quietly pass.
 *
 * The html2pdf bundle is cached at tests/fixtures/.cache/, same as the docx one:
 *   curl -o tests/fixtures/.cache/html2pdf.bundle.min.js \
 *     https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PDF_BUNDLE = path.join(__dirname, '../fixtures/.cache/html2pdf.bundle.min.js');

const read = p => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8')
  .replace(/<\/script>/g, '<\\/script>');

// library-doc.js needs a handful of app globals before it will load.
const STUBS = `
  window.I18n = { tr: k => k, t: k => k, getLocale: () => 'ka' };
  window.escapeHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  window.toast = { warn(){}, error(){}, info(){} };
  window.Api = { get: async () => [], getUser: () => ({ id: 1, role: 'ADMIN' }) };
  window.formatDate = d => d;
  window.localizedCountryName = c => c.name_en;
  window.SectionVisibility = { seesAllSections: () => true, isOwnSection: () => true };
`;

function page$(extraScripts = '') {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <script>${STUBS}</script>
    <script>${read('frontend/js/core/discussion-points.js')}</script>
    <script>${read('frontend/js/core/library-doc.js')}</script>
    ${extraScripts}
  </body></html>`;
}

const PROSE = 'The Ministry of Economy and Sustainable Development reports that trade turnover '
  + 'increased substantially over the reporting period, driven by exports of agricultural goods '
  + 'and a marked recovery in tourism receipts across the principal partner markets.';

const DOC = {
  title: 'Trade and Economic Cooperation',
  countryCode: 'de',
  countryName: 'Germany',
  countryNameKa: 'გერმანია',
  endedAt: '2026-03-01T00:00:00.000Z',
};

// Every way the editor lets an author exceed the printable width: a table
// pasted at its original pixel width, an image at its natural size, and a token
// no line break can fall inside. All of it survives the server sanitizer, which
// allows inline width/height in absolute units and width/height on <img>.
const WIDE_TABLE = '<table style="width:1400px"><tbody><tr>'
  + [1, 2, 3, 4, 5, 6].map(i => `<td style="width:230px">Indicator ${i} — ${PROSE}</td>`).join('')
  + '</tr></tbody></table>';
const WIDE_IMAGE = '<img width="1200" height="300" style="width:1200px;height:300px" '
  + 'src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">';
const LONG_TOKEN = `<p>Reference ${'A'.repeat(200)} follows.</p>`;

const WIDE_SECTION = { id: 1, title: 'Overview', htmlContent: `<p>${PROSE}</p>${WIDE_TABLE}${WIDE_IMAGE}${LONG_TOKEN}` };

// Long enough to run over several sheets, so page boundaries fall inside prose.
const LONG_SECTIONS = [1, 2, 3].map(n => ({
  id: n,
  title: `Section ${n}`,
  htmlContent: new Array(12).fill(0).map((_, i) => `<p>${i + 1}. ${PROSE} ${PROSE}</p>`).join('')
    + '<ul>' + new Array(6).fill(0).map(() => `<li>${PROSE}</li>`).join('') + '</ul>',
}));

test.describe('fitToPageHtml', () => {
  test.beforeEach(async ({ page }) => { await page.setContent(page$()); });

  test('drops absolute sizing and keeps relative sizing', async ({ page }) => {
    const out = await page.evaluate(() => LibraryDoc.fitToPageHtml(
      '<table style="width:1400px"><tbody><tr><td style="min-width:300px">a</td></tr></tbody></table>'
      + '<table style="width:50%"><tbody><tr><td>b</td></tr></tbody></table>'
      + '<img width="1200" height="300" style="width:1200px;height:300px" src="x.png">'));
    expect(out).not.toMatch(/width:\s*1400px/);
    expect(out).not.toMatch(/min-width:\s*300px/);
    expect(out).not.toMatch(/width:\s*1200px/);
    expect(out).not.toMatch(/height:\s*300px/);
    expect(out).not.toMatch(/width="1200"/);
    expect(out).not.toMatch(/height="300"/);
    // Percentages are relative to the container, so they already fit.
    expect(out).toMatch(/width:\s*50%/);
  });

  test('preserves tracked changes, comment anchors and formatting', async ({ page }) => {
    // The same guarantee justifyBodyHtml() makes: only sizing is touched.
    const out = await page.evaluate(() => LibraryDoc.fitToPageHtml(
      '<p style="text-align: justify;">a <ins data-tc-id="tc1" data-tc-author="A">added</ins>'
      + '<del data-tc-id="tc2">gone</del>'
      + '<span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-1" style="color: rgb(255, 0, 0);">flagged</span></p>'));
    expect(out).toContain('<ins data-tc-id="tc1" data-tc-author="A">added</ins>');
    expect(out).toContain('<del data-tc-id="tc2">gone</del>');
    expect(out).toContain('data-cmt-anchor-id="cmt-1"');
    expect(out).toMatch(/color:\s*rgb\(255, 0, 0\)/);
    expect(out).toMatch(/text-align:\s*justify/);
  });

  test('handles empty input', async ({ page }) => {
    expect(await page.evaluate(() => LibraryDoc.fitToPageHtml(''))).toBe('');
    expect(await page.evaluate(() => LibraryDoc.fitToPageHtml(null))).toBe('');
  });
});

test.describe('The export fits the printable width', () => {
  test('nothing reaches past the right edge of the page', async ({ page }) => {
    await page.setContent(page$());

    const spills = await page.evaluate(({ doc, section }) => {
      // Rendered at the width html2pdf uses for its own container: A4 portrait
      // less the page margins.
      function overflowing(html) {
        const host = document.createElement('div');
        host.style.cssText = `position:absolute; left:0; top:0; width:${LibraryDoc.CONTENT_WIDTH_MM}mm;`;
        host.innerHTML = html;
        document.body.appendChild(host);
        const right = host.getBoundingClientRect().right;
        const out = Array.from(host.querySelectorAll('*'))
          .filter(el => el.getBoundingClientRect().right > right + 1)
          .map(el => el.tagName.toLowerCase());
        host.remove();
        return out;
      }
      return {
        exported: overflowing(LibraryDoc.buildExportHtml(doc, [section], null)),
        // Control: the section as authored, with none of the export treatment.
        raw: overflowing(section.htmlContent),
      };
    }, { doc: DOC, section: WIDE_SECTION });

    // The fixture has to actually overflow, or the test proves nothing.
    expect(spills.raw).toEqual(expect.arrayContaining(['table', 'img']));
    expect(spills.exported).toEqual([]);
  });
});

test.describe('The export breaks between blocks', () => {
  test('groups a section title with one block, and nothing larger', async ({ page }) => {
    await page.setContent(page$());

    const shape = await page.evaluate(({ doc, sections }) => {
      const host = document.createElement('div');
      host.innerHTML = LibraryDoc.buildExportHtml(doc, sections, null);
      const root = host.querySelector('.pdf-export');
      return {
        keeps: Array.from(root.querySelectorAll('.pdf-keep')).map(el => el.children.length),
        topLevel: Array.from(root.children).map(el => el.tagName.toLowerCase()),
      };
    }, { doc: DOC, sections: LONG_SECTIONS });

    // The document header, then one group per section: its title and the first
    // block of its body. Grouping anything larger hands `avoid-all` a unit
    // almost a sheet tall, which it then moves whole and leaves the page before
    // it blank — so the rest of a section stays at the top level, one block at a
    // time, free to break wherever it has to.
    expect(shape.keeps).toEqual([1, 2, 2, 2]);
    // Four groups (header + three titles) and nothing else wrapping content.
    expect(shape.topLevel.filter(t => t === 'div')).toHaveLength(4);
    // 12 paragraphs a section, less the one taken into each title group.
    expect(shape.topLevel.filter(t => t === 'p')).toHaveLength(3 * 11);
    expect(shape.topLevel.filter(t => t === 'ul')).toHaveLength(3);
  });

  test('no paragraph, list item or row is sliced by a page boundary', async ({ page }) => {
    test.skip(!fs.existsSync(PDF_BUNDLE), 'html2pdf bundle not cached — see header comment');

    const bundle = fs.readFileSync(PDF_BUNDLE, 'utf8').replace(/<\/script>/g, '<\\/script>');
    await page.setContent(page$(`<script>${bundle}</script>`));

    const split = await page.evaluate(async ({ doc, sections }) => {
      // A4 portrait inner height in CSS pixels — the same number html2pdf's
      // page-break plugin measures against, and the height jsPDF slices at.
      const PAGE_H = Math.floor((297 - 2 * LibraryDoc.PAGE_MARGIN_MM) * (96 / 25.4));

      // Run html2pdf as far as the container: that is the DOM its page-break
      // plugin has just padded, before html2canvas photographs it.
      async function measure(opt) {
        const container = document.createElement('div');
        container.innerHTML = LibraryDoc.buildExportHtml(doc, sections, null);
        await html2pdf().from(container).set(opt).toContainer();

        const live = document.querySelector('.html2pdf__container');
        const top0 = live.getBoundingClientRect().top;
        const blocks = Array.from(live.querySelectorAll('p, li, tr, table, hr'))
          .map(el => {
            const r = el.getBoundingClientRect();
            return { tag: el.tagName.toLowerCase(), top: r.top - top0, bottom: r.bottom - top0,
                     height: r.height, text: (el.textContent || '').trim().slice(0, 40) };
          });

        // Blocks a page boundary runs through.
        const split = blocks.filter(b => {
          if (['p', 'li', 'tr'].indexOf(b.tag) === -1) return false;
          // A block taller than a sheet has to be split somewhere.
          if (b.height <= 0 || b.height >= PAGE_H) return false;
          return Math.floor((b.bottom - 2) / PAGE_H) !== Math.floor((b.top + 2) / PAGE_H);
        }).map(b => `${b.tag}: ${b.text}`);

        // How much of each sheet the content reaches down to. Pushing a block to
        // the next page always leaves some slack at the foot of this one; leaving
        // half a sheet blank means something far too large was kept together.
        const fill = [];
        for (let top = 0; top < live.getBoundingClientRect().height; top += PAGE_H) {
          const reach = blocks
            .filter(b => b.top >= top && b.top < top + PAGE_H)
            .reduce((max, b) => Math.max(max, b.bottom), top);
          fill.push((reach - top) / PAGE_H);
        }

        document.querySelector('.html2pdf__overlay').remove();
        return { split, fill };
      }

      const opt = LibraryDoc.pdfOptions('layout.pdf', 2);
      // Control: html2pdf's defaults, which is what the export used to send.
      const noBreaks = Object.assign({}, opt);
      delete noBreaks.pagebreak;

      return { fixed: await measure(opt), control: await measure(noBreaks) };
    }, { doc: DOC, sections: LONG_SECTIONS });

    // The document has to be long enough for boundaries to fall inside prose.
    expect(split.control.split.length).toBeGreaterThan(0);
    expect(split.fixed.split).toEqual([]);

    // And the sheets stay full: every page but the last is used to the foot of
    // it. Keeping too coarse a unit together — a whole section, say — would push
    // it wholesale and leave the page before it mostly blank.
    expect(split.fixed.fill.slice(0, -1).filter(f => f < 0.5)).toEqual([]);
  });
});
