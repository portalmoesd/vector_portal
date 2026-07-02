/**
 * End-to-end check of the Word export: builds a real .docx in the browser via
 * the bundled docx library, then unzips it and asserts the OOXML contains
 * native revision marks (w:ins / w:del), a real table (w:tbl), and Word
 * comments (comments.xml + commentReference).
 *
 * Requires the docx UMD bundle cached at tests/fixtures/.cache/docx.umd.js
 * (same build the app loads from the CDN). Skipped when absent:
 *   curl -o tests/fixtures/.cache/docx.umd.js \
 *     https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BUNDLE = path.join(__dirname, '../fixtures/.cache/docx.umd.js');
const exporterSrc = fs
  .readFileSync(path.join(__dirname, '../../frontend/js/docx-export.js'), 'utf8')
  .replace(/<\/script>/g, '<\\/script>');

function readZipEntry(zipPath, entry) {
  return execFileSync('python3', [
    '-c',
    'import zipfile,sys; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())',
    zipPath, entry,
  ], { encoding: 'utf8' });
}

test('exports tracked changes, tables and comments as native Word markup', async ({ page }, testInfo) => {
  test.skip(!fs.existsSync(BUNDLE), 'docx UMD bundle not cached — see header comment');

  const bundleSrc = fs.readFileSync(BUNDLE, 'utf8').replace(/<\/script>/g, '<\\/script>');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <script>${bundleSrc}</script>
    <script>${exporterSrc}</script>
  </body></html>`);

  const b64 = await page.evaluate(async () => {
    const html =
      '<p>keep <ins data-tc-id="tc1" data-tc-author="Alice Author" data-tc-time="2026-01-01T00:00:00Z">added</ins>' +
      '<del data-tc-id="tc2" data-tc-author="Bob Reviewer" data-tc-time="2026-01-01T00:00:00Z">removed</del> ' +
      '<span class="gcp-cmt-anchor" data-cmt-anchor-id="cmt-a">flagged text</span></p>' +
      '<table><tbody><tr><td>c1</td><td colspan="2">c2</td></tr></tbody></table>';
    const doc = GCP.buildDocx('Test Doc', [{
      sectionLabel: 'Section One',
      htmlContent: html,
      comments: [
        { id: 10, anchorId: 'cmt-a', parentId: null, authorName: 'Carol', text: 'root comment', createdAt: '2026-01-02T00:00:00Z' },
        { id: 11, anchorId: null, parentId: 10, authorName: 'Dave', text: 'a reply', createdAt: '2026-01-03T00:00:00Z' },
      ],
    }], { countryName: 'Georgia' });
    return await docx.Packer.toBase64String(doc);
  });

  const zipPath = testInfo.outputPath('export.docx');
  fs.writeFileSync(zipPath, Buffer.from(b64, 'base64'));

  const documentXml = readZipEntry(zipPath, 'word/document.xml');
  // Native revision marks with attribution
  expect(documentXml).toContain('<w:ins ');
  expect(documentXml).toContain('<w:del ');
  expect(documentXml).toContain('w:author="Alice Author"');
  expect(documentXml).toContain('w:author="Bob Reviewer"');
  // Real Word table, not flattened text
  expect(documentXml).toContain('<w:tbl>');
  expect(documentXml).toContain('c1');
  // Comment range + reference around the anchored text
  expect(documentXml).toContain('commentRangeStart');
  expect(documentXml).toContain('commentRangeEnd');
  expect(documentXml).toContain('commentReference');

  const commentsXml = readZipEntry(zipPath, 'word/comments.xml');
  expect(commentsXml).toContain('root comment');
  expect(commentsXml).toContain('a reply');
  expect(commentsXml).toContain('w:author="Carol"');
});
