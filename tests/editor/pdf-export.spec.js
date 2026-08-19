/**
 * The document PDF/Word export: justified body text, and keeping content inside
 * the PDF page.
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
 * The page-geometry tests below use html2pdf's REAL container width. It builds
 * its own container at the printable width (210mm - 2*12.7mm = 184.6mm) and
 * html2canvas crops at that box, so anything wider is silently rasterised away.
 * Measuring at any other width would not see the bug.
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

test.describe('content stays inside the PDF page', () => {
  // exportPdf's options verbatim: the margin is what fixes the container width.
  const PDF_OPT = `{
    margin: [12.7, 12.7, 12.7, 12.7],
    html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
    jsPDF: { format: 'a4', orientation: 'portrait' },
    image: { type: 'jpeg', quality: 0.98 },
  }`;

  // Each of these overflowed the capture box, or sat on its boundary, before the fix.
  const CASES = {
    'justified paragraph': `<p style="margin:0">${PROSE}</p>`,
    'unbreakable token': `<p style="margin:0">https://www.economy.ge/${'x'.repeat(200)}/final.pdf</p>`,
    'eight-column table':
      '<table><tbody><tr>' +
      Array.from({ length: 8 }, (_, i) => `<th>Column ${i + 1}</th>`).join('') +
      '</tr><tr>' +
      Array.from({ length: 8 }, (_, i) => `<td>Value ${i + 1} of the row</td>`).join('') +
      '</tr></tbody></table>',
    'oversized image':
      '<img width="1400" height="120" src="data:image/svg+xml;base64,' +
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="120">' +
        '<rect width="1400" height="120" fill="#333"/></svg>').toString('base64') + '">',
  };

  for (const [label, fragment] of Object.entries(CASES)) {
    test(`${label} is not clipped at the right edge`, async ({ page }) => {
      test.skip(!fs.existsSync(PDF_BUNDLE), 'html2pdf bundle not cached — see header comment');

      const bundle = fs.readFileSync(PDF_BUNDLE, 'utf8').replace(/<\/script>/g, '<\\/script>');
      await page.setContent(page$(`<script>${bundle}</script>`));
      // The export inherits the app's global table styling; without it the
      // measurement would be more forgiving than reality.
      for (const css of ['frontend/css/base.css', 'frontend/css/components.css']) {
        await page.addStyleTag({ content: read(css) });
      }

      const res = await page.evaluate(async ({ html, optSrc }) => {
        const host = document.createElement('div');
        // Mirrors exportPdf's wrapper, including the right inset.
        host.style.cssText =
          'background:#fff;font-family:Arial,sans-serif;font-size:11pt;padding-right:3px;';
        host.innerHTML = '<div>' +
          LibraryDoc.constrainForPdf(LibraryDoc.justifyBodyHtml(html)) + '</div>';
        document.body.appendChild(host);

        // eslint-disable-next-line no-eval
        const canvas = await html2pdf().from(host).set(eval('(' + optSrc + ')'))
          .toCanvas().get('canvas');
        // html2pdf removes its container once rendering finishes, so the captured
        // canvas is what tells us the width that was actually rasterised.
        const boxW = canvas.width / 2;   // html2canvas scale: 2

        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        const d = ctx.getImageData(0, 0, width, height).data;
        let maxInk = -1;
        for (let y = 0; y < height; y++) {
          for (let x = width - 1; x > maxInk; x--) {
            const i = (y * width + x) * 4;
            if (d[i] < 160 || d[i + 1] < 160 || d[i + 2] < 160) { maxInk = x; break; }
          }
        }
        host.remove();
        return { boxW, canvasW: width, gapDevicePx: width - 1 - maxInk };
      }, { html: fragment, optSrc: PDF_OPT });

      // Guard the premise: 210mm - 2*12.7mm = 184.6mm = 697.7px, captured as 698.
      // If this drifts the test is no longer measuring the real capture box.
      expect(res.boxW).toBe(698);
      // Ink must stop clear of the crop edge. Justified text used to land within
      // 0.5 css px of it, and the image and long token were clipped outright.
      expect(res.gapDevicePx).toBeGreaterThanOrEqual(4);
    });
  }

  test('no text line is left crossing a page boundary', async ({ page }) => {
    test.skip(!fs.existsSync(PDF_BUNDLE), 'html2pdf bundle not cached — see header comment');

    const bundle = fs.readFileSync(PDF_BUNDLE, 'utf8').replace(/<\/script>/g, '<\\/script>');
    await page.setContent(page$(`<script>${bundle}</script>`));

    const res = await page.evaluate(async ({ prose, optSrc }) => {
      document.querySelectorAll('.html2pdf__overlay').forEach(e => e.remove());
      const host = document.createElement('div');
      host.style.cssText = 'background:#fff;font-family:Arial,sans-serif;font-size:11pt;';
      // Four pages of prose with a table in the middle — enough boundaries that
      // at least one is bound to land on a line.
      host.innerHTML = Array.from({ length: 30 },
        (_, i) => `<p style="text-align:justify;margin:0 0 10px">${i + 1}. ${prose}</p>`).join('')
        + '<table style="width:100%"><tbody>'
        + Array.from({ length: 12 }, (_, r) =>
          '<tr>' + Array.from({ length: 4 }, (_, c) =>
            `<td style="padding:6px 10px">Cell ${r + 1}.${c + 1}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>'
        + Array.from({ length: 12 },
          (_, i) => `<p style="text-align:justify;margin:0 0 10px">${i + 31}. ${prose}</p>`).join('');
      document.body.appendChild(host);

      // eslint-disable-next-line no-eval
      const opt = eval('(' + optSrc + ')');
      const worker = html2pdf().from(host).set(opt);
      await worker.toCanvas();
      const canvas = worker.prop.canvas;
      // Exactly what html2pdf's toPdf uses to slice.
      const band = Math.floor(canvas.width * worker.prop.pageSize.inner.ratio);

      const boundaryInk = c => {
        const ctx = c.getContext('2d');
        const out = [];
        for (let y = band; y < c.height; y += band) {
          const d = ctx.getImageData(0, y, c.width, 1).data;
          let n = 0;
          for (let x = 0; x < c.width; x++) {
            const i = x * 4;
            if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++;
          }
          out.push(n);
        }
        return out;
      };

      const before = boundaryInk(canvas);
      const aligned = LibraryDoc.alignCanvasToPages(canvas, band);
      const after = boundaryInk(aligned);

      host.remove();
      document.querySelectorAll('.html2pdf__overlay').forEach(e => e.remove());
      return { band, width: canvas.width, before, after,
               pagesBefore: Math.ceil(canvas.height / band),
               pagesAfter: Math.ceil(aligned.height / band) };
    }, { prose: PROSE, optSrc: PDF_OPT });

    // The document must actually run to several pages, or nothing is proven.
    expect(res.pagesBefore).toBeGreaterThanOrEqual(3);
    // The bug reproduces: at least one raw boundary cuts through inked pixels.
    expect(Math.max(...res.before)).toBeGreaterThan(res.width * 0.02);
    // After alignment every boundary sits in whitespace. The allowance is the
    // same 2% the aligner uses, so a break between two table rows — which still
    // crosses the vertical borders — counts as clean.
    res.after.forEach(n => expect(n).toBeLessThanOrEqual(Math.round(res.width * 0.02)));
    // Pushing lines down may add a page, but must not lose one.
    expect(res.pagesAfter).toBeGreaterThanOrEqual(res.pagesBefore);
  });
});

test.describe('alignCanvasToPages', () => {
  // A synthetic canvas of evenly spaced "lines": 10 inked rows, 5 blank, repeat.
  // With band = 50 the first boundary lands inside the line at rows 45-54.
  const STRIPES = `(width, height, band) => {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    for (let y = 0; y + 10 <= height; y += 15) ctx.fillRect(0, y, width, 10);
    return c;
  }`;

  const INK = `(c) => {
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const rows = [];
    for (let y = 0; y < c.height; y++) {
      let n = 0;
      const base = y * c.width * 4;
      for (let x = 0; x < c.width; x++) {
        const i = base + x * 4;
        if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++;
      }
      rows.push(n);
    }
    return rows;
  }`;

  test.beforeEach(async ({ page }) => { await page.setContent(page$()); });

  test('moves every boundary off a line and keeps all the ink', async ({ page }) => {
    const res = await page.evaluate(({ stripesSrc, inkSrc }) => {
      // eslint-disable-next-line no-eval
      const stripes = eval(stripesSrc), ink = eval(inkSrc);
      const band = 50;
      const src = stripes(100, 300, band);
      const out = LibraryDoc.alignCanvasToPages(src, band);
      const before = ink(src), after = ink(out);
      const at = (rows, y) => (y < rows.length ? rows[y] : 0);
      return {
        beforeBoundaries: [50, 100, 150, 200, 250].map(y => at(before, y)),
        afterBoundaries: [50, 100, 150, 200, 250].map(y => at(after, y)),
        inkBefore: before.reduce((a, b) => a + b, 0),
        inkAfter: after.reduce((a, b) => a + b, 0),
        heightBefore: src.height, heightAfter: out.height,
      };
    }, { stripesSrc: STRIPES, inkSrc: INK });

    // Without alignment the boundaries fall inside a stripe.
    expect(Math.max(...res.beforeBoundaries)).toBeGreaterThan(2);
    // With it, every boundary is blank.
    res.afterBoundaries.forEach(n => expect(n).toBe(0));
    // Nothing is cropped away — the same ink comes out, on a taller sheet.
    expect(res.inkAfter).toBe(res.inkBefore);
    expect(res.heightAfter).toBeGreaterThan(res.heightBefore);
  });

  test('leaves a canvas that fits on one page alone', async ({ page }) => {
    const same = await page.evaluate(({ stripesSrc }) => {
      // eslint-disable-next-line no-eval
      const stripes = eval(stripesSrc);
      const src = stripes(100, 40, 50);
      return LibraryDoc.alignCanvasToPages(src, 50) === src;
    }, { stripesSrc: STRIPES });
    expect(same).toBe(true);
  });

  test('cuts where it falls when the block is taller than the search window', async ({ page }) => {
    // A solid block spanning the whole page has no blank row to retreat to; the
    // aligner must give up rather than push it forever or loop.
    const res = await page.evaluate(({ inkSrc }) => {
      // eslint-disable-next-line no-eval
      const ink = eval(inkSrc);
      const c = document.createElement('canvas');
      c.width = 100; c.height = 300;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 100, 300);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 100, 300);
      const out = LibraryDoc.alignCanvasToPages(c, 50);
      return { height: out.height, rows: ink(out).length };
    }, { inkSrc: INK });
    expect(res.height).toBe(300);
    expect(res.rows).toBe(300);
  });
});

test.describe('constrainForPdf', () => {
  test.beforeEach(async ({ page }) => { await page.setContent(page$()); });

  test('lets long tokens wrap', async ({ page }) => {
    const out = await page.evaluate(() => LibraryDoc.constrainForPdf('<p>x</p>'));
    expect(out).toMatch(/overflow-wrap:\s*break-word/);
    expect(out).toMatch(/word-break:\s*break-word/);
  });

  test('constrains images and tables', async ({ page }) => {
    const out = await page.evaluate(() => LibraryDoc.constrainForPdf(
      '<img width="1400" src="x.png"><table><tbody><tr><th>H</th><td>C</td></tr></tbody></table>'));
    expect(out).toMatch(/max-width:\s*100%/);
    expect(out).toMatch(/table-layout:\s*fixed/);
    // The editor's cell padding, not the app's roomier global rule.
    expect(out).toMatch(/padding:\s*6px 10px/);
    // Undo the global uppercasing, which widens header cells.
    expect(out).toMatch(/text-transform:\s*none/);
  });

  test('preserves tracked changes and comment anchors', async ({ page }) => {
    const out = await page.evaluate(() => LibraryDoc.constrainForPdf(
      '<p>a <ins data-tc-id="tc1">added</ins>' +
      '<span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-1">flagged</span></p>'));
    expect(out).toContain('<ins data-tc-id="tc1">added</ins>');
    expect(out).toContain('data-cmt-anchor-id="cmt-1"');
  });

  test('handles empty input', async ({ page }) => {
    expect(await page.evaluate(() => LibraryDoc.constrainForPdf(''))).toBe('');
    expect(await page.evaluate(() => LibraryDoc.constrainForPdf(null))).toBe('');
  });
});
