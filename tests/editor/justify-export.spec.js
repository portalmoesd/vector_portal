/**
 * Justified body text in the document exports.
 *
 * Body prose in the exported PDF and Word files is set flush to both margins.
 * `LibraryDoc.justifyBodyHtml` does that once, on the section HTML, and both
 * exporters pick it up — the PDF renders the inline styles, and Word converts
 * them through docx-export's existing getAlignment().
 *
 * The PDF assertions are geometric on purpose: html2pdf rasterizes through
 * html2canvas, so it is not enough that the CSS says justify — the rendered
 * pixels have to show it. The Word assertions read the produced OOXML
 * (`<w:jc w:val="both"/>`).
 *
 * The html2pdf bundle is cached at tests/fixtures/.cache/, same as the docx one:
 *   curl -o tests/fixtures/.cache/html2pdf.bundle.min.js \
 *     https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DOCX_BUNDLE = path.join(__dirname, '../fixtures/.cache/docx.umd.js');
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

function readZipEntry(zipPath, entry) {
  return execFileSync('python3', [
    '-c',
    'import zipfile,sys; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())',
    zipPath, entry,
  ], { encoding: 'utf8' });
}

// Long enough to wrap over several lines at the export width.
const PROSE = 'The Ministry of Economy and Sustainable Development reports that trade turnover '
  + 'increased substantially over the reporting period, driven by exports of agricultural goods '
  + 'and a marked recovery in tourism receipts across the principal partner markets.';

test.describe('justifyBodyHtml', () => {
  test.beforeEach(async ({ page }) => { await page.setContent(page$()); });

  test('justifies paragraphs and list items', async ({ page }) => {
    const out = await page.evaluate(() => LibraryDoc.justifyBodyHtml(
      '<p>one</p><ul><li>two</li></ul><blockquote>three</blockquote>'));
    expect(out).toContain('<p style="text-align: justify;">one</p>');
    expect(out).toContain('<li style="text-align: justify;">two</li>');
    expect(out).toContain('<blockquote style="text-align: justify;">three</blockquote>');
  });

  test('overrides alignment the author chose', async ({ page }) => {
    // The export is uniform by request, so a centred body paragraph is justified.
    const out = await page.evaluate(() => LibraryDoc.justifyBodyHtml(
      '<p style="text-align:center">one</p><p style="text-align:right">two</p>'));
    expect(out).not.toMatch(/text-align:\s*center/);
    expect(out).not.toMatch(/text-align:\s*right/);
    expect((out.match(/text-align: justify/g) || []).length).toBe(2);
  });

  test('leaves headings alone', async ({ page }) => {
    const out = await page.evaluate(() => LibraryDoc.justifyBodyHtml(
      '<h2>Section</h2><h3 style="text-align:center">Topic</h3><p>body</p>'));
    expect(out).toContain('<h2>Section</h2>');
    // Left verbatim, hence the original unspaced serialization.
    expect(out).toContain('<h3 style="text-align:center">Topic</h3>');
    expect(out).toContain('<p style="text-align: justify;">body</p>');
  });

  test('leaves table content alone', async ({ page }) => {
    // Justifying a narrow column opens ugly gaps between words.
    const out = await page.evaluate(() => LibraryDoc.justifyBodyHtml(
      '<table><tbody><tr><td><p>cell</p></td></tr></tbody></table><p>body</p>'));
    expect(out).toContain('<td><p>cell</p></td>');
    expect(out).toContain('<p style="text-align: justify;">body</p>');
  });

  test('wraps loose top-level text so it is not left unaligned in Word', async ({ page }) => {
    const out = await page.evaluate(() => LibraryDoc.justifyBodyHtml('loose text<p>block</p>'));
    expect(out).toContain('<p style="text-align: justify;">loose text</p>');
    expect(out).toContain('<p style="text-align: justify;">block</p>');
  });

  test('preserves tracked changes and comment anchors', async ({ page }) => {
    // The Word export turns these into native revisions and comments; losing or
    // reshaping them here would break both.
    const out = await page.evaluate(() => LibraryDoc.justifyBodyHtml(
      '<p>a <ins data-tc-id="tc1" data-tc-author="A">added</ins>' +
      '<del data-tc-id="tc2">gone</del>' +
      '<span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-1">flagged</span></p>'));
    expect(out).toContain('<ins data-tc-id="tc1" data-tc-author="A">added</ins>');
    expect(out).toContain('<del data-tc-id="tc2">gone</del>');
    expect(out).toContain('<span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-1">flagged</span>');
  });

  test('handles empty input', async ({ page }) => {
    expect(await page.evaluate(() => LibraryDoc.justifyBodyHtml(''))).toBe('');
    expect(await page.evaluate(() => LibraryDoc.justifyBodyHtml(null))).toBe('');
  });
});

test.describe('PDF output is really justified once rasterized', () => {
  test('justified lines end flush, left-aligned ones do not', async ({ page }) => {
    test.skip(!fs.existsSync(PDF_BUNDLE), 'html2pdf bundle not cached — see header comment');

    const bundle = fs.readFileSync(PDF_BUNDLE, 'utf8').replace(/<\/script>/g, '<\\/script>');
    await page.setContent(page$(`<script>${bundle}</script>`));

    const measure = await page.evaluate(async (prose) => {
      const W = 560;   // roughly the A4 content width the export renders at

      async function render(html) {
        const host = document.createElement('div');
        host.style.cssText =
          `width:${W}px;font-family:Arial,sans-serif;font-size:11pt;background:#fff;`;
        host.innerHTML = html;
        document.body.appendChild(host);

        // The same worker chain exportPdf() uses, so this measures the real path.
        const canvas = await html2pdf()
          .set({ html2canvas: { scale: 2, backgroundColor: '#fff', logging: false, scrollX: 0, scrollY: 0 } })
          .from(host).toCanvas().get('canvas');

        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        const data = ctx.getImageData(0, 0, width, height).data;

        // Rightmost inked pixel per row, grouped into line bands.
        const lines = [];
        let cur = null;
        for (let y = 0; y < height; y++) {
          let last = -1;
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i] < 160 || data[i + 1] < 160 || data[i + 2] < 160) last = x;
          }
          if (last >= 0) { cur = cur || { max: 0 }; cur.max = Math.max(cur.max, last); }
          else if (cur) { lines.push(cur.max); cur = null; }
        }
        if (cur) lines.push(cur.max);
        host.remove();
        return lines;
      }

      // Ragged baseline vs the justified output the exporter now produces.
      const ragged = await render(`<p style="margin:0">${prose}</p>`);
      const justified = await render(LibraryDoc.justifyBodyHtml(`<p style="margin:0">${prose}</p>`));
      const spread = ls => {
        const nonLast = ls.slice(0, -1);   // justification never stretches the last line
        return nonLast.length ? Math.max(...nonLast) - Math.min(...nonLast) : 0;
      };
      return { raggedLines: ragged.length, justifiedLines: justified.length,
               raggedSpread: spread(ragged), justifiedSpread: spread(justified) };
    }, PROSE);

    // Needs to actually wrap, or there is nothing to justify.
    expect(measure.justifiedLines).toBeGreaterThan(2);
    // Justified: every line but the last ends at the same x.
    expect(measure.justifiedSpread).toBeLessThan(6);
    // And that is a real difference from the ragged original.
    expect(measure.raggedSpread).toBeGreaterThan(measure.justifiedSpread + 5);
  });
});

test.describe('PDF layout, measured as html2canvas sees it', () => {
  test('paragraphs and list items go flush; headings and table cells do not', async ({ page }) => {
    await page.setContent(page$());

    const measured = await page.evaluate((prose) => {
      // Reproduce exportPdf's container: no stylesheet, inline styles only.
      const container = document.createElement('div');
      container.style.cssText = 'width:560px;font-family:Arial,sans-serif;font-size:11pt;';
      container.innerHTML = '<div>' + LibraryDoc.justifyBodyHtml(
        `<h2>Overview</h2><p>${prose}</p>` +
        `<p style="text-align:center">${prose}</p>` +
        `<ul><li>${prose}</li></ul>` +
        `<table><tbody><tr><td>${prose}</td></tr></tbody></table>`) + '</div>';
      document.body.appendChild(container);

      const out = [];
      container.querySelectorAll('p, li, td').forEach(el => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const rects = [...r.getClientRects()].filter(x => x.width > 1);
        if (rects.length < 2) return;            // must wrap to be meaningful
        const right = el.getBoundingClientRect().right;
        out.push({
          tag: el.tagName,
          lines: rects.length,
          maxGap: Math.max(...rects.slice(0, -1).map(x => right - x.right)),
        });
      });
      return out;
    }, PROSE);

    const byTag = t => measured.filter(m => m.tag === t);
    // Both paragraphs (including the one the author centred) and the list item
    // end flush on every line but the last.
    expect(byTag('P')).toHaveLength(2);
    byTag('P').forEach(m => expect(m.maxGap).toBeLessThan(2));
    expect(byTag('LI')).toHaveLength(1);
    byTag('LI').forEach(m => expect(m.maxGap).toBeLessThan(2));
    // The table cell stays ragged.
    expect(byTag('TD')).toHaveLength(1);
    byTag('TD').forEach(m => expect(m.maxGap).toBeGreaterThan(5));
  });
});

test.describe('Word output carries the justification', () => {
  test('body paragraphs and list items get w:jc both, headings and cells do not', async ({ page }, testInfo) => {
    test.skip(!fs.existsSync(DOCX_BUNDLE), 'docx bundle not cached');

    const docxSrc = fs.readFileSync(DOCX_BUNDLE, 'utf8').replace(/<\/script>/g, '<\\/script>');
    await page.setContent(page$(
      `<script>${docxSrc}</script><script>${read('frontend/js/docx-export.js')}</script>`));

    const b64 = await page.evaluate(async (prose) => {
      const html = LibraryDoc.justifyBodyHtml(
        `<h2>A heading that is long enough to wrap across more than a single line in the document</h2>` +
        `<p>${prose}</p>` +
        `<ul><li>${prose}</li></ul>` +
        `<table><tbody><tr><td><p>${prose}</p></td></tr></tbody></table>`);
      const doc = GCP.buildDocx('Justified Doc', [{ sectionLabel: 'Section One', htmlContent: html }]);
      return await docx.Packer.toBase64String(doc);
    }, PROSE);

    const zipPath = testInfo.outputPath('justified.docx');
    fs.writeFileSync(zipPath, Buffer.from(b64, 'base64'));
    const xml = readZipEntry(zipPath, 'word/document.xml');

    // Justification reached the file at all.
    expect(xml).toContain('<w:jc w:val="both"/>');

    // Per-paragraph: split on paragraph boundaries and check the right ones.
    const paras = xml.split('<w:p>').slice(1);
    const justified = p => p.includes('<w:jc w:val="both"/>');
    const bodyParas = paras.filter(p => p.includes('trade turnover'));
    expect(bodyParas.length).toBeGreaterThanOrEqual(3);   // paragraph, list item, table cell

    // The plain paragraph and the list item are justified.
    expect(bodyParas.filter(justified).length).toBeGreaterThanOrEqual(2);

    // The section heading paragraph must not be.
    const headingPara = paras.find(p => p.includes('Section One'));
    expect(headingPara).toBeTruthy();
    expect(justified(headingPara)).toBe(false);

    // Nor the authored <h2>.
    const h2Para = paras.find(p => p.includes('long enough to wrap'));
    expect(h2Para).toBeTruthy();
    expect(justified(h2Para)).toBe(false);

    // Table cell content stays as it was. Match the table regions themselves —
    // slicing from the first <w:tbl> to the end of the document would sweep in
    // everything that follows it.
    const tables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
    expect(tables.length).toBeGreaterThan(0);
    tables.forEach(t => expect(justified(t)).toBe(false));
  });
});
