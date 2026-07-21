/**
 * Statistics Word (.docx) export — sibling of statistics-pdf.js.
 *
 * Produces a docx whose content, fonts, page geometry, and table styling
 * mirror the existing PDF output. The runtime loads the `docx` library
 * lazily on first export click — `statistics.js` injects the CDN script
 * and awaits it before invoking `StatisticsWord.build`. So `window.docx`
 * is guaranteed to exist by the time we reach this file's runtime code.
 *
 * Public API:
 *   await StatisticsWord.build(state, { lang, country, countryNameEn, charts });
 */
(function () {
  'use strict';

  // ── Labels ──────────────────────────────────────────────────────────────
  // Mirrored from statistics-pdf.js T table verbatim so the two builders
  // stay diff-able. Any new label added there must be added here too.
  const T = {
    en: {
      tradeOverview: 'Trade Overview',
      turnover: 'Trade Turnover',
      export: 'Export',
      import: 'Import',
      balance: 'Balance',
      dynamics: 'Export-Import Dynamics',
      mainExport: 'Main Export Products',
      mainImport: 'Main Import Products',
      exportIncrease: 'Most Increased Export Products',
      exportDrop: 'Most Decreased Export Products',
      importIncrease: 'Most Increased Import Products',
      importDrop: 'Most Decreased Import Products',
      internationalVisitors: 'International Visitors',
      fdi: 'Foreign Direct Investment',
      fdiShort: 'FDI, mln $',
      hsProduct: 'Product (HS 4-digit)',
      volumeHeader: 'Volume, mln $',
      changeHeader: 'Change %',
      reexportShareShort: 'Re-exp. share %',
      differenceHeader: 'Difference, mln $',
      year: 'Year',
      period: 'Period',
      visitors: 'Visitors',
      mln: 'mln $',
      noTrade: 'No trade conducted',
      noExports: 'No exports conducted',
      noImports: 'No imports conducted',
      positive: 'positive',
      negative: 'negative',
      increase: 'increase',
      decrease: 'decrease',
      generated: 'Generated',
      noData: 'No data available',
      noTourismData: 'No visitor records from this country to Georgia.',
      noFdiData: 'No foreign direct investment records from this country to Georgia.',
      page: 'page',
      of: 'of',
      tradeSection: 'Foreign Trade',
      tourismSection: 'Tourism',
      investmentsSection: 'Investments',
      appendixSection: 'Appendix',
      appTurnoverGrp: 'Turnover',
      appExportGrp: 'Export',
      appImportGrp: 'Import',
      appBalanceGrp: 'Balance',
      appChange: 'Change %',
      appShare: 'Share %',
    },
    ka: {
      tradeOverview: 'სავაჭრო მიმოხილვა',
      turnover: 'სავაჭრო ბრუნვა',
      export: 'ექსპორტი',
      import: 'იმპორტი',
      balance: 'ბალანსი',
      dynamics: 'ექსპორტ-იმპორტის დინამიკა',
      mainExport: 'ძირითადი საექსპორტო პროდუქცია',
      mainImport: 'ძირითადი საიმპორტო პროდუქცია',
      exportIncrease: 'ექსპორტში ყველაზე მეტად გაზრდილი პროდუქცია',
      exportDrop: 'ექსპორტში ყველაზე მეტად შემცირებული პროდუქცია',
      importIncrease: 'იმპორტში ყველაზე მეტად გაზრდილი პროდუქცია',
      importDrop: 'იმპორტში ყველაზე მეტად შემცირებული პროდუქცია',
      internationalVisitors: 'საერთაშორისო ვიზიტორები',
      fdi: 'პირდაპირი უცხოური ინვესტიციები',
      fdiShort: 'პირდაპირი უცხოური ინვესტიციები, მლნ. $',
      hsProduct: 'პროდუქცია (HS 4-ნიშნა)',
      volumeHeader: 'მოცულობა მლნ.$',
      changeHeader: 'ცვლილება %',
      reexportShareShort: 'რეექს. წილი %',
      differenceHeader: 'სხვაობა მლნ.$',
      year: 'წელი',
      period: 'პერიოდი',
      visitors: 'ვიზიტორები',
      mln: 'მლნ. $',
      noTrade: 'ვაჭრობა არ განხორციელდა',
      noExports: 'ექსპორტი არ განხორციელდა',
      noImports: 'იმპორტი არ განხორციელდა',
      positive: 'პოზიტიური',
      negative: 'ნეგატიური',
      increase: 'ზრდა',
      decrease: 'კლება',
      generated: 'თარიღი',
      noData: 'მონაცემები ვერ მოიძებნა',
      noTourismData: 'აღნიშნული ქვეყნიდან ვიზიტორები საქართველოში არ ფიქსირდება.',
      noFdiData: 'აღნიშნული ქვეყნიდან საქართველოში პირდაპირი უცხოური ინვესტიცია არ ფიქსირდება.',
      page: 'გვ.',
      of: '/',
      tradeSection: 'საგარეო ვაჭრობა',
      tourismSection: 'ტურიზმი',
      investmentsSection: 'ინვესტიციები',
      appendixSection: 'დანართი',
      appTurnoverGrp: 'ბრუნვა',
      appExportGrp: 'ექსპორტი',
      appImportGrp: 'იმპორტი',
      appBalanceGrp: 'სალდო',
      appChange: 'ცვლილება %',
      appShare: 'წილი %',
    },
  };

  // ── Georgian month declensions + English month abbreviations ───────────
  const KA_MONTHS = {
    1:  { stem: 'იანვარ',     gen: 'იანვრის',     loc: 'იანვარში'    },
    2:  { stem: 'თებერვალ',   gen: 'თებერვლის',   loc: 'თებერვალში'  },
    3:  { stem: 'მარტ',       gen: 'მარტის',      loc: 'მარტში'      },
    4:  { stem: 'აპრილ',      gen: 'აპრილის',     loc: 'აპრილში'     },
    5:  { stem: 'მაის',       gen: 'მაისის',      loc: 'მაისში'      },
    6:  { stem: 'ივნის',      gen: 'ივნისის',     loc: 'ივნისში'     },
    7:  { stem: 'ივლის',      gen: 'ივლისის',     loc: 'ივლისში'     },
    8:  { stem: 'აგვისტო',    gen: 'აგვისტოს',    loc: 'აგვისტოში'   },
    9:  { stem: 'სექტემბერ',  gen: 'სექტემბრის',  loc: 'სექტემბერში' },
    10: { stem: 'ოქტომბერ',   gen: 'ოქტომბრის',   loc: 'ოქტომბერში'  },
    11: { stem: 'ნოემბერ',    gen: 'ნოემბრის',    loc: 'ნოემბერში'   },
    12: { stem: 'დეკემბერ',   gen: 'დეკემბრის',   loc: 'დეკემბერში'  },
  };

  const EN_MONTHS = { 1:'Jan', 2:'Feb', 3:'Mar', 4:'Apr', 5:'May', 6:'Jun', 7:'Jul', 8:'Aug', 9:'Sep', 10:'Oct', 11:'Nov', 12:'Dec' };
  const KA_MONTHS_SHORT = { 1:'იან', 2:'თებ', 3:'მარ', 4:'აპრ', 5:'მაი', 6:'ივნ', 7:'ივლ', 8:'აგვ', 9:'სექ', 10:'ოქტ', 11:'ნოე', 12:'დეკ' };

  // ── Period formatters (locale-aware, copied from statistics-pdf.js) ────
  function gePeriodGen(year, latestMonth) {
    if (latestMonth === 12) return `${year} წლის`;
    if (latestMonth === 1)  return `${year} წლის ${KA_MONTHS[1].gen}`;
    return `${year} წლის ${KA_MONTHS[1].stem}-${KA_MONTHS[latestMonth].gen}`;
  }
  function gePeriodLoc(year, latestMonth) {
    if (latestMonth === 12) return `${year} წელს`;
    if (latestMonth === 1)  return `${year} წლის ${KA_MONTHS[1].loc}`;
    return `${year} წლის ${KA_MONTHS[1].stem}-${KA_MONTHS[latestMonth].loc}`;
  }
  function periodShortLabel(latestMonth, lang) {
    const months = lang === 'ka' ? KA_MONTHS_SHORT : EN_MONTHS;
    if (latestMonth === 12) return '';
    if (latestMonth === 1) return months[1];
    return `${months[1]}-${months[latestMonth]}`;
  }
  function enPeriod(year, latestMonth) {
    if (latestMonth === 12) return String(year);
    if (latestMonth === 1) return `${EN_MONTHS[1]} ${year}`;
    return `${EN_MONTHS[1]}-${EN_MONTHS[latestMonth]} ${year}`;
  }
  function gePeriodGenRange(startYear, endYear, latestMonth) {
    const years = `${startYear}-${endYear}`;
    if (latestMonth === 12) return `${years} წლების`;
    if (latestMonth === 1)  return `${years} წლის ${KA_MONTHS[1].gen}`;
    return `${years} წლის ${KA_MONTHS[1].stem}-${KA_MONTHS[latestMonth].gen}`;
  }
  function enPeriodRange(startYear, endYear, latestMonth) {
    const years = `${startYear}-${endYear}`;
    if (latestMonth === 12) return years;
    if (latestMonth === 1) return `${EN_MONTHS[1]} ${years}`;
    return `${EN_MONTHS[1]}-${EN_MONTHS[latestMonth]} ${years}`;
  }
  function gePlace(rank) {
    if (rank === 1) return 'პირველ';
    if (rank >= 2 && rank <= 20) return `მე-${rank}`;
    if (rank % 10 === 0) return `მე-${rank}`;
    if (rank % 100 === 0) return `მე-${rank}`;
    return `${rank}-ე`;
  }
  function enOrdinal(rank) {
    const n = Math.abs(rank);
    const m100 = n % 100;
    if (m100 >= 11 && m100 <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }

  // ── Numeric formatters (copied from statistics-pdf.js) ─────────────────
  function formatMln(val) {
    let str;
    const abs = Math.abs(val);
    if (abs >= 100) str = val.toFixed(1);
    else if (abs >= 10) str = val.toFixed(2);
    else if (abs >= 0.01) str = val.toFixed(2);
    else if (abs > 0) str = val.toFixed(3);
    else str = '0.00';
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function formatMln2(val) {
    return val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function formatPct(pct) {
    const rounded = Math.round(pct);
    if (rounded === 0 && pct !== 0) return pct.toFixed(1) + '%';
    return rounded + '%';
  }
  function calcChange(current, previous) {
    if (!previous || previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / Math.abs(previous)) * 100;
  }
  function formatDate() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }

  // ── docx unit helpers ──────────────────────────────────────────────────
  // docx uses two odd unit conventions:
  //   - Page geometry / table widths: TWIPS (1 pt = 20 twips, 1 inch = 1440)
  //   - Font sizes: HALF-POINTS (10pt = 20)
  // These wrappers keep the rest of the file in plain points.
  function pt(n) { return Math.round(n * 20); }     // pt → twips
  function hp(n) { return Math.round(n * 2); }      // pt → half-points
  function px(n) { return Math.round(n * 96 / 72); } // pt → CSS pixels (chart sizes)

  // ── Font embedding ─────────────────────────────────────────────────────
  // Arial covers Latin/digits/Cyrillic universally but has zero Georgian
  // glyphs; Sylfaen is Microsoft's classic Georgian companion. We embed
  // both into the .docx via Document({fonts: [...]}) so recipients on
  // any OS see identical output regardless of what's installed locally.
  // Sylfaen Bold isn't bundled — we declare Sylfaen Regular and accept
  // that bold Georgian renders at regular weight (same precedent as the
  // previous FiraGO setup which mapped italics to Regular).
  let fontsPromise = null;
  async function ensureFontBytes() {
    if (fontsPromise) return fontsPromise;
    fontsPromise = (async () => {
      const [arialReg, arialBold, sylfaen] = await Promise.all([
        fetch('/fonts/Arial-Regular.ttf').then(r => r.arrayBuffer()),
        fetch('/fonts/Arial-Bold.ttf').then(r => r.arrayBuffer()),
        fetch('/fonts/Sylfaen.ttf').then(r => r.arrayBuffer()),
      ]);
      return {
        arialReg: new Uint8Array(arialReg),
        arialBold: new Uint8Array(arialBold),
        sylfaen: new Uint8Array(sylfaen),
      };
    })();
    return fontsPromise;
  }

  // ── Color palette (matches PDF) ────────────────────────────────────────
  const COLOR = {
    text:       '1F2937',
    textMuted:  '6B7280',
    headerText: '475569',
    headerFill: 'F8FAFC',
    border:     'E5E7EB',
    borderTop:  '94A3B8',
    groupFill:  'F1F5F9',
    positive:   '16A34A',
    negative:   'DC2626',
    titleDark:  '0F172A',
  };

  // ── docx paragraph + run helpers ──────────────────────────────────────
  // Each helper returns a `Paragraph` so section builders can list
  // children and concat them. The `docx` namespace is captured at build()
  // time and passed in via the closure parameter `D`.
  function paragraph(D, runs, opts = {}) {
    return new D.Paragraph({
      children: Array.isArray(runs) ? runs : [runs],
      ...opts,
    });
  }
  // tr() — TextRun factory that splits the text by script and returns an
  // array of TextRuns: Latin/digit segments use Arial, Georgian segments
  // use Sylfaen. Caller-provided `font` is intentionally ignored; the
  // per-segment font always wins. Children-only runs (page-number markers,
  // breaks) bypass splitting and return a single-element array.
  function tr(D, opts) {
    const o = opts || {};
    if (o.text == null && o.children) {
      const { font: _f, ...rest } = o;
      return [new D.TextRun({ font: 'Arial', ...rest })];
    }
    const text = o.text == null ? '' : String(o.text);
    const { text: _t, font: _f, ...rest } = o;
    if (text === '' || !window.FontUtils.hasGeorgian(text)) {
      return [new D.TextRun({ ...rest, text, font: 'Arial' })];
    }
    return window.FontUtils.splitByScript(text).map(seg =>
      new D.TextRun({ ...rest, text: seg.text, font: seg.font }));
  }
  function run(D, text, opts = {}) {
    return tr(D, {
      text: String(text),
      size: hp(9.5),
      color: COLOR.text,
      ...opts,
    });
  }
  function boldRun(D, text, opts = {}) {
    return run(D, text, { ...opts, bold: true });
  }
  function italicRun(D, text, opts = {}) {
    return run(D, text, { ...opts, italics: true });
  }

  function sectionTitleP(D, text, opts = {}) {
    return new D.Paragraph({
      spacing: { before: pt(10), after: pt(6) },
      // Keep the title attached to whatever follows so Word doesn't
      // dump it alone at the bottom of a page when the next block
      // (table or chart) doesn't fit.
      keepNext: true,
      keepLines: true,
      children: tr(D, {
        text, bold: true,
        size: hp(13), color: COLOR.titleDark,
      }),
      ...opts,
    });
  }
  function subTitleP(D, text, opts = {}) {
    return new D.Paragraph({
      spacing: { before: pt(8), after: pt(4) },
      keepNext: true,
      keepLines: true,
      children: tr(D, {
        text, bold: true,
        size: hp(10.5), color: COLOR.text,
      }),
      ...opts,
    });
  }
  function captionP(D, text) {
    return new D.Paragraph({
      spacing: { after: pt(4) },
      // Chart captions stay attached to the chart image that follows.
      keepNext: true,
      keepLines: true,
      children: tr(D, {
        text, bold: true,
        size: hp(9.5), color: COLOR.text,
      }),
    });
  }

  // ── Image helpers (Base64 data URL → ImageRun) ────────────────────────
  function dataUrlToBytes(dataUrl) {
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(',');
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function chartImageP(D, dataUrl, widthPt = 500, heightPt = 153) {
    const bytes = dataUrlToBytes(dataUrl);
    if (!bytes) return null;
    return new D.Paragraph({
      alignment: D.AlignmentType.CENTER,
      spacing: { before: pt(2), after: pt(8) },
      // Image-only paragraph still gets keepLines so the image isn't
      // split mid-page; keepNext keeps the next block (sub-title /
      // table) attached too.
      keepLines: true,
      children: [new D.ImageRun({
        data: bytes,
        transformation: { width: px(widthPt), height: px(heightPt) },
      })],
    });
  }
  // Combined caption + chart image as one paragraph. Using a single
  // paragraph + keepLines + keepNext is the most reliable way to keep
  // a chart caption glued to its image across page breaks — the prior
  // two-paragraph version still let Word push the image to the next
  // page on its own when it didn't fit alongside the caption.
  function captionedChartP(D, captionText, dataUrl, widthPt = 500, heightPt = 153) {
    const bytes = dataUrlToBytes(dataUrl);
    if (!bytes) return null;
    return new D.Paragraph({
      alignment: D.AlignmentType.CENTER,
      spacing: { before: pt(2), after: pt(8) },
      keepLines: true,
      keepNext: true,
      children: [
        ...tr(D, {
          text: captionText, bold: true,
          size: hp(9.5), color: COLOR.text,
        }),
        new D.TextRun({ text: '', break: 1 }),
        new D.ImageRun({
          data: bytes,
          transformation: { width: px(widthPt), height: px(heightPt) },
        }),
      ],
    });
  }

  // ── docx table cell helpers ───────────────────────────────────────────
  // pdfmake's tableLayout collapses to "1pt under header, 0.5pt between
  // rows, no verticals". docx requires per-cell border specs, so these
  // helpers produce the equivalent. The cell at position (row, col)
  // receives:
  //   top:    1pt #94a3b8 if row === 1 (under header)
  //           0.5pt #e5e7eb otherwise
  //           none if row === 0 (no top border on the first row)
  //   left/right: none
  //   bottom: 0.5pt #e5e7eb (for the last data row, the next row's top
  //           supplies the line; on the very last row it's also nothing).
  function cellBorders(rowIdx, isLastRow) {
    const NONE = { style: 'none', size: 0, color: 'auto' };
    const headerLine = { style: 'single', size: 8 /* eighths-of-a-point: 8 = 1pt */, color: COLOR.borderTop };
    const rowLine    = { style: 'single', size: 4 /* 0.5pt */,                       color: COLOR.border };
    const top = rowIdx === 0 ? NONE : (rowIdx === 1 ? headerLine : rowLine);
    const bottom = isLastRow ? NONE : NONE; // bottoms left to next-row tops
    return { top, bottom, left: NONE, right: NONE };
  }
  // Word's default table style applies all-sided borders when the Table
  // omits a `borders` option. Pass an explicit all-NONE table-level
  // border set so the cell-level top borders (above) supply the only
  // horizontal lines and there are no verticals.
  function tableBorders() {
    const NONE = { style: 'none', size: 0, color: 'auto' };
    return {
      top: NONE,
      bottom: NONE,
      left: NONE,
      right: NONE,
      insideHorizontal: NONE,
      insideVertical: NONE,
    };
  }
  function cellMargins() {
    return { top: pt(4), bottom: pt(4), left: pt(6), right: pt(6) };
  }
  function makeCell(D, opts) {
    const { children, rowIdx, isLastRow, shading, columnSpan, width } = opts;
    return new D.TableCell({
      children,
      verticalAlign: D.VerticalAlign.CENTER,
      borders: cellBorders(rowIdx, !!isLastRow),
      margins: cellMargins(),
      shading: shading ? { type: 'clear', color: 'auto', fill: shading } : undefined,
      columnSpan,
      width,
    });
  }
  // `opts.keepWithNext` → docx keepNext on the cell's inner paragraph.
  // Used by tables that must not split across pages (Tourism, FDI,
  // Appendix). When the helpers are called for non-last rows of those
  // tables, every cell's inner paragraph gets keepNext: true, which
  // chains the rows together so Word treats the whole table as one
  // unbreakable block.
  function headerCell(D, text, opts = {}) {
    return makeCell(D, {
      children: [new D.Paragraph({
        alignment: opts.align === 'right' ? D.AlignmentType.RIGHT
                 : opts.align === 'center' ? D.AlignmentType.CENTER
                 : D.AlignmentType.LEFT,
        keepNext: !!opts.keepWithNext,
        children: tr(D, {
          text, bold: true,
          size: hp(8), color: COLOR.headerText,
        }),
      })],
      rowIdx: 0,
      shading: COLOR.headerFill,
      columnSpan: opts.columnSpan,
      width: opts.width,
    });
  }
  function dataCell(D, text, opts = {}) {
    const align = opts.align || 'left';
    const color = opts.color || COLOR.text;
    return makeCell(D, {
      children: [new D.Paragraph({
        alignment: align === 'right' ? D.AlignmentType.RIGHT
                 : align === 'center' ? D.AlignmentType.CENTER
                 : D.AlignmentType.LEFT,
        keepNext: !!opts.keepWithNext,
        children: tr(D, {
          text: String(text),
          size: hp(9), color, bold: !!opts.bold,
        }),
      })],
      rowIdx: opts.rowIdx,
      isLastRow: opts.isLastRow,
      shading: opts.shading,
      columnSpan: opts.columnSpan,
      width: opts.width,
    });
  }

  // ── Document factory ──────────────────────────────────────────────────
  // Builds the docx Document with A4 portrait, the same margins as the
  // PDF (32 / 46 / 32 / 40 pt → twips), Arial as the base font with
  // Sylfaen embedded for Georgian, and a single section with country-
  // name + generated-date header and a "page X / N" footer. Per-section
  // content is supplied as the `children` array; embedded font binaries
  // are supplied as `opts.fontBytes`.
  function buildDocxDocument(D, children, opts) {
    const lang = opts.lang || 'en';
    const t = T[lang] || T.en;
    const country = lang === 'en' && opts.countryNameEn ? opts.countryNameEn : (opts.country || '');
    const dateStr = formatDate();
    const fontBytes = opts.fontBytes || {};

    const headerP = new D.Paragraph({
      tabStops: [{ type: D.TabStopType.RIGHT, position: pt(531) }],
      children: [
        ...tr(D, { text: country, size: hp(8.5), color: COLOR.textMuted }),
        new D.TextRun({ text: '\t', font: 'Arial', size: hp(8.5) }),
        ...tr(D, { text: `${t.generated}: ${dateStr}`, size: hp(8.5), color: COLOR.textMuted }),
      ],
    });

    const footerP = new D.Paragraph({
      alignment: D.AlignmentType.CENTER,
      children: [
        ...tr(D, { text: `${t.page} `, size: hp(8), color: COLOR.textMuted }),
        ...tr(D, { children: [D.PageNumber.CURRENT], size: hp(8), color: COLOR.textMuted }),
        ...tr(D, { text: ` ${t.of} `, size: hp(8), color: COLOR.textMuted }),
        ...tr(D, { children: [D.PageNumber.TOTAL_PAGES], size: hp(8), color: COLOR.textMuted }),
      ],
    });

    // docx 8.5.0 reads `fonts: [{name, data}]` and packages each as an
    // obfuscated .odttf inside word/fonts/ with a fontTable.xml entry.
    // Recipients on Word/Win, Word/Mac, and modern LibreOffice render the
    // embedded fonts; older readers fall back to system installs.
    const fonts = [];
    if (fontBytes.arialReg)  fonts.push({ name: 'Arial',   data: fontBytes.arialReg });
    if (fontBytes.arialBold) fonts.push({ name: 'Arial',   data: fontBytes.arialBold });
    if (fontBytes.sylfaen)   fonts.push({ name: 'Sylfaen', data: fontBytes.sylfaen });

    // Set the document run language so Word's spell-checker tags Georgian
    // text as Georgian (otherwise every Georgian word appears underlined
    // red as a misspelled English word). docx 8.5.0's run properties
    // accept `language: { value, eastAsia, bidirectional }`; setting it
    // in styles.default.document.run propagates to every TextRun.
    const docLang = lang === 'ka' ? 'ka-GE' : 'en-US';
    return new D.Document({
      creator: 'Vector Portal',
      title: `${country} statistics`,
      fonts,
      styles: {
        default: {
          document: {
            run: { font: 'Arial', size: hp(9.5), color: COLOR.text, language: { value: docLang } },
            paragraph: { spacing: { line: 300, lineRule: 'auto' } },
          },
        },
      },
      sections: [{
        properties: {
          page: {
            size: { width: pt(595), height: pt(842), orientation: D.PageOrientation.PORTRAIT }, // A4
            margin: { top: pt(46), bottom: pt(40), left: pt(32), right: pt(32),
                      header: pt(18), footer: pt(14) },
          },
        },
        headers: { default: new D.Header({ children: [headerP] }) },
        footers: { default: new D.Footer({ children: [footerP] }) },
        children,
      }],
    });
  }

  // ── Tourism section ────────────────────────────────────────────────────
  // Mirrors statistics-pdf.js buildTourismSection / buildTourismSummary.
  function formatTourismPeriodKa(label) {
    const m = /^(\d{4})\s+([IVX]+(?:-[IVX]+)?)\s+კვ$/.exec(label || '');
    if (!m) return label || '';
    return `${m[1]} წლის ${m[2]} კვარტლის`;
  }
  function formatTourismPeriodEn(label) {
    const m = /^(\d{4})\s+([IVX]+(?:-[IVX]+)?)\s+კვ$/.exec(label || '');
    if (!m) return label || '';
    const roman = { I: 1, II: 2, III: 3, IV: 4 };
    const q = m[2].split('-').map(r => `Q${roman[r] || r}`).join('-');
    return `${q} ${m[1]}`;
  }

  function buildTourismSummary(D, tourism, t, country, lang, grammar) {
    if (!tourism || !tourism.hasData) return [];
    const isKa = lang === 'ka';
    const B = (s) => ({ text: s, bold: true });
    const fmt = (n) => Number(n).toLocaleString();
    const kaFrom = (name) => (grammar && grammar.from) || (name + 'დან');

    const out = [];
    if (tourism.fiveYearSum > 0) {
      if (isKa) {
        out.push(summaryProseParagraph(D, [
          B(`${tourism.fiveYearStart} - ${tourism.fiveYearEnd}`),
          ` წლებში ${kaFrom(country)} საქართველოში შემოვიდა `,
          B(fmt(tourism.fiveYearSum)), ` ვიზიტორი.`,
        ]));
      } else {
        out.push(summaryProseParagraph(D, [
          `Between `, B(`${tourism.fiveYearStart}-${tourism.fiveYearEnd}`),
          `, `, B(fmt(tourism.fiveYearSum)), ` visitors came to Georgia from ${country}.`,
        ]));
      }
    }
    if (tourism.currentRank && tourism.currentPeriodLabel) {
      if (isKa) {
        out.push(summaryProseParagraph(D, [
          B(formatTourismPeriodKa(tourism.currentPeriodLabel)),
          ` მონაცემებით ვიზიტორების რაოდენობის მიხედვით ${country} არის `,
          B(`${gePlace(tourism.currentRank)} ადგილზე`), `.`,
        ]));
      } else {
        out.push(summaryProseParagraph(D, [
          `By visitor count in `, B(formatTourismPeriodEn(tourism.currentPeriodLabel)),
          `, ${country} ranks `, B(enOrdinal(tourism.currentRank)), `.`,
        ]));
      }
    }
    return out;
  }

  function buildTourismTable(D, tourism, t, lang) {
    const rows = [...(tourism.quarterlyRows || []), ...[...(tourism.annualRows || [])].reverse()];
    if (rows.length === 0) return emptyTablePlaceholder(D, t);
    const totalRows = 1 + rows.length;
    const rankHeader = lang === 'ka' ? 'ადგილი' : 'Rank';
    const shareHeader = lang === 'ka' ? 'წილი, %' : 'Share, %';

    // Show the rank column whenever any row has rank data.
    const showRank = rows.some(r => r.rank);

    // Tourism table must not cut across pages → every cell paragraph
    // in non-last rows gets keepNext:true so Word treats the whole
    // table as a single block.
    const headerCells = [headerCell(D, t.period, { keepWithNext: true })];
    if (showRank) headerCells.push(headerCell(D, rankHeader, { align: 'right', keepWithNext: true }));
    headerCells.push(
      headerCell(D, t.visitors,     { align: 'right', keepWithNext: true }),
      headerCell(D, t.changeHeader, { align: 'right', keepWithNext: true }),
      headerCell(D, shareHeader,    { align: 'right', keepWithNext: true }),
    );
    const tableRows = [new D.TableRow({ children: headerCells })];

    rows.forEach((r, idx) => {
      const rowIdx = idx + 1;
      const isLast = rowIdx === totalRows - 1;
      const keep = !isLast;
      let changeColor = COLOR.text;
      let changeText = '-';
      if (r.changePct !== null && r.changePct !== undefined) {
        changeColor = r.changePct > 0 ? COLOR.positive : (r.changePct < 0 ? COLOR.negative : COLOR.headerText);
        const sign = r.changePct > 0 ? '+' : '';
        changeText = `${sign}${formatPct(r.changePct)}`;
      }
      const rankText = r.rank ? String(r.rank) : '-';
      const shareText = r.share != null ? `${(Math.round(r.share * 10) / 10).toFixed(1)}%` : '-';
      const cells = [dataCell(D, r.label, { bold: !!r.isCurrent, rowIdx, isLastRow: isLast, keepWithNext: keep })];
      if (showRank) cells.push(dataCell(D, rankText, { align: 'right', rowIdx, isLastRow: isLast, keepWithNext: keep }));
      cells.push(
        dataCell(D, r.visitors.toLocaleString(), { align: 'right', rowIdx, isLastRow: isLast, keepWithNext: keep }),
        dataCell(D, changeText, { align: 'right', color: changeColor, rowIdx, isLastRow: isLast, keepWithNext: keep }),
        dataCell(D, shareText, { align: 'right', rowIdx, isLastRow: isLast, keepWithNext: keep }),
      );
      tableRows.push(new D.TableRow({ cantSplit: true, children: cells }));
    });

    return new D.Table({
      borders: tableBorders(),
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      rows: tableRows,
    });
  }

  function buildTourismSection(D, tourism, charts, t, country, lang, grammar) {
    if (!tourism) return [];
    const blocks = [];
    blocks.push(sectionTitleP(D, `${country} - ${t.internationalVisitors}`));
    if (!tourism.hasData) {
      blocks.push(emptyTablePlaceholder(D, t, t.noTourismData));
      return blocks;
    }
    blocks.push(...buildTourismSummary(D, tourism, t, country, lang, grammar));
    blocks.push(buildTourismTable(D, tourism, t, lang));
    if (charts && charts.tourism) {
      const block = captionedChartP(D, t.internationalVisitors, charts.tourism);
      if (block) blocks.push(block);
    }
    return blocks;
  }

  // ── Investments section ────────────────────────────────────────────────
  // Mirrors statistics-pdf.js buildInvestmentsSection /
  // buildInvestmentsSummary / buildFdiSectorsTable.

  function buildInvestmentsSummary(D, inv, t, country, lang, grammar) {
    if (!inv || !inv.hasData) return [];
    const isKa = lang === 'ka';
    const B = (s) => ({ text: s, bold: true });
    const fmt = (n) => (Math.round(Math.abs(n) * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const kaFrom = (name) => (grammar && grammar.from) || (name + 'დან');
    const countryFrom = isKa ? kaFrom(country) : country;
    const out = [];

    // Sentence 1: first year + total + total rank
    if (inv.firstYear && inv.totalSum > 0) {
      if (isKa) {
        const parts = [
          `${countryFrom} საქართველოში პირდაპირი უცხოური ინვესტიცია პირველად `,
          B(`${inv.firstYear}`), ` წელს განხორციელდა. ჯამური განხორციელებული პირდაპირი უცხოური ინვესტიცია შეადგენს `,
          B(`${fmt(inv.totalSum)} მლნ. აშშ დოლარს`), `.`,
        ];
        if (inv.totalRank) {
          parts.push(` ${country} იკავებს `, B(`${gePlace(inv.totalRank)} ადგილს`),
            ` ჯამური განხორციელებული ინვესტიციის მოცულობით საქართველოში.`);
        }
        out.push(summaryProseParagraph(D, parts));
      } else {
        const parts = [
          `Foreign direct investment from ${country} to Georgia was first made in `,
          B(`${inv.firstYear}`), `. Total FDI amounts to `,
          B(`${fmt(inv.totalSum)} mln USD`), `.`,
        ];
        if (inv.totalRank) {
          parts.push(` ${country} ranks `, B(enOrdinal(inv.totalRank)), ` by total FDI volume in Georgia.`);
        }
        out.push(summaryProseParagraph(D, parts));
      }
    }

    // Sentence 2: 5-year sum
    if (inv.fiveYearSum > 0) {
      if (isKa) {
        out.push(summaryProseParagraph(D, [
          B(`${inv.fiveYearStart} - ${inv.fiveYearEnd}`),
          ` წლებში ${countryFrom} საქართველოში შემოსული ინვესტიციების მოცულობამ შეადგინა `,
          B(`${fmt(inv.fiveYearSum)} მლნ. აშშ დოლარი`), `.`,
        ]));
      } else {
        out.push(summaryProseParagraph(D, [
          `Between `, B(`${inv.fiveYearStart}-${inv.fiveYearEnd}`),
          `, investments from ${country} to Georgia amounted to `,
          B(`${fmt(inv.fiveYearSum)} mln USD`), `.`,
        ]));
      }
    }

    // Per-year sentences (latest + previous)
    const yearSentence = (year, value, rank) => {
      if (!(value > 0) || !year) return null;
      if (isKa) {
        const parts = [
          B(`${year} წელს`), ` ${countryFrom} საქართველოში განხორციელდა `,
          B(`${fmt(value)} მლნ. აშშ დოლარის`), ` პირდაპირი უცხოური ინვესტიცია.`,
        ];
        if (rank) {
          parts.push(` ${country} განხორციელებული პირდაპირი უცხოური ინვესტიციის მოცულობით `,
            `${year} წელს `, B(`${gePlace(rank)} ადგილს`), ` იკავებს.`);
        }
        return summaryProseParagraph(D, parts);
      }
      const parts = [
        `In `, B(`${year}`), `, `, B(`${fmt(value)} mln USD`),
        ` of foreign direct investment came to Georgia from ${country}.`,
      ];
      if (rank) parts.push(` ${country} ranked `, B(enOrdinal(rank)), ` by FDI volume in ${year}.`);
      return summaryProseParagraph(D, parts);
    };
    const noInv = (year) => isKa
      ? summaryProseParagraph(D, [B(`${year} წელს`), ` ${countryFrom} ინვესტიცია არ განხორციელდა.`])
      : summaryProseParagraph(D, [`In `, B(`${year}`), `, no investment was conducted from ${country}.`]);

    if (inv.latestYear) {
      const s = yearSentence(inv.latestYear, inv.latestYearValue, inv.latestYearRank);
      out.push(s || noInv(inv.latestYear));
    }
    if (inv.prevYear) {
      const s = yearSentence(inv.prevYear, inv.prevYearValue, inv.prevYearRank);
      out.push(s || noInv(inv.prevYear));
    }

    return out;
  }

  function buildFdiTable(D, inv, t, lang) {
    const data = [...(inv.tableData || [])].reverse();
    if (data.length === 0) return emptyTablePlaceholder(D, t);
    const totalRows = 1 + data.length;
    const rankHeader = lang === 'ka' ? 'ადგილი' : 'Rank';
    const shareHeader = lang === 'ka' ? 'წილი, %' : 'Share, %';

    // Show the rank column whenever any year has rank data.
    const showRank = data.some(r => r.valueMln > 0 && r.rank);

    // FDI table must not cut across pages (same approach as Tourism).
    const headerCells = [headerCell(D, t.year, { keepWithNext: true })];
    if (showRank) headerCells.push(headerCell(D, rankHeader, { align: 'right', keepWithNext: true }));
    headerCells.push(
      headerCell(D, t.volumeHeader, { align: 'right', keepWithNext: true }),
      headerCell(D, t.changeHeader, { align: 'right', keepWithNext: true }),
      headerCell(D, shareHeader,    { align: 'right', keepWithNext: true }),
    );
    const rows = [new D.TableRow({ children: headerCells })];

    data.forEach((r, idx) => {
      const rowIdx = idx + 1;
      const isLast = rowIdx === totalRows - 1;
      const keep = !isLast;
      const isCurNeg = !(r.valueMln > 0);
      const isPrevNeg = !(r.prevMln > 0);
      const valueText = isCurNeg ? '-' : formatMln(r.valueMln);
      let changeText = '-';
      let changeColor = COLOR.text;
      if (!(isCurNeg || isPrevNeg)) {
        const pct = ((r.valueMln - r.prevMln) / r.prevMln) * 100;
        changeColor = pct > 0 ? COLOR.positive : (pct < 0 ? COLOR.negative : COLOR.headerText);
        const sign = pct > 0 ? '+' : '';
        changeText = `${sign}${formatPct(pct)}`;
      }
      const rankText = (!isCurNeg && r.rank) ? String(r.rank) : '-';
      const shareText = (!isCurNeg && r.share != null) ? `${(Math.round(r.share * 10) / 10).toFixed(1)}%` : '-';
      const cells = [dataCell(D, String(r.year), { rowIdx, isLastRow: isLast, keepWithNext: keep })];
      if (showRank) cells.push(dataCell(D, rankText, { align: 'right', rowIdx, isLastRow: isLast, keepWithNext: keep }));
      cells.push(
        dataCell(D, valueText, { align: 'right', rowIdx, isLastRow: isLast, keepWithNext: keep }),
        dataCell(D, changeText, { align: 'right', color: changeColor, rowIdx, isLastRow: isLast, keepWithNext: keep }),
        dataCell(D, shareText, { align: 'right', rowIdx, isLastRow: isLast, keepWithNext: keep }),
      );
      rows.push(new D.TableRow({ cantSplit: true, children: cells }));
    });

    return new D.Table({
      borders: tableBorders(),
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      rows,
    });
  }

  function buildFdiSectorsTable(D, sectors, country, lang) {
    if (!sectors || !sectors.data) return null;
    const isKa = lang === 'ka';
    const { years, data } = sectors;
    const yrRange = years.length > 1 ? `${years[0]}-${years[years.length - 1]}` : String(years[0]);
    const titleText = isKa
      ? `${country} - პირდაპირი უცხოური ინვესტიციები სექტორების მიხედვით, ${yrRange}`
      : `${country} - Foreign Direct Investment by Sector, ${yrRange}`;
    const subtitleText = isKa ? 'მლნ. აშშ დოლარი' : 'mln USD';
    const totalLabel = isKa ? 'სულ' : 'Total';
    const sectorHeader = isKa ? 'სექტორი' : 'Sector';

    function fmt(v) {
      if (v === null || v === undefined || v === 0) return '-';
      const sign = v < 0 ? '-' : '';
      const abs = Math.abs(v);
      const str = abs >= 100 ? abs.toFixed(1) : abs.toFixed(2);
      return sign + str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    function colorOf(v) {
      if (v === null || v === undefined || v === 0) return COLOR.headerText;
      return v < 0 ? COLOR.negative : COLOR.titleDark;
    }

    const sectorNames = Object.keys(data.sectors || {});
    const sortYear = years[years.length - 1];
    sectorNames.sort((a, b) => {
      const va = (data.sectors[a] && data.sectors[a][sortYear]) || 0;
      const vb = (data.sectors[b] && data.sectors[b][sortYear]) || 0;
      return vb - va;
    });
    const nameMap = sectors.sectorNameMap || {};

    const totalRows = 1 + 1 + sectorNames.length; // header + totals + sector rows
    const headerCells = [
      headerCell(D, sectorHeader),
      ...years.map(y => headerCell(D, String(y), { align: 'right' })),
    ];
    const rows = [new D.TableRow({ children: headerCells })];

    // Totals row
    const totalCells = [dataCell(D, totalLabel, { bold: true, shading: COLOR.groupFill, rowIdx: 1, isLastRow: false })];
    for (const y of years) {
      const v = data.totals ? data.totals[y] : null;
      totalCells.push(dataCell(D, fmt(v), {
        align: 'right', bold: true, color: colorOf(v),
        shading: COLOR.groupFill, rowIdx: 1, isLastRow: false,
      }));
    }
    rows.push(new D.TableRow({ cantSplit: true, children: totalCells }));

    // Sector rows
    sectorNames.forEach((sector, sIdx) => {
      const rowIdx = 2 + sIdx;
      const isLast = rowIdx === totalRows - 1;
      const displayName = isKa ? sector : (nameMap[sector] || sector);
      const cells = [dataCell(D, displayName, { rowIdx, isLastRow: isLast })];
      const vals = data.sectors[sector] || {};
      for (const y of years) {
        const v = vals[y];
        cells.push(dataCell(D, fmt(v), { align: 'right', color: colorOf(v), rowIdx, isLastRow: isLast }));
      }
      rows.push(new D.TableRow({ cantSplit: true, children: cells }));
    });

    return [
      new D.Paragraph({
        spacing: { before: pt(12), after: pt(2) },
        children: tr(D, { text: titleText, bold: true, size: hp(11), color: COLOR.titleDark }),
      }),
      new D.Paragraph({
        spacing: { after: pt(4) },
        children: tr(D, { text: subtitleText, size: hp(8.5), color: '64748B' }),
      }),
      new D.Table({
        borders: tableBorders(),
        width: { size: 100, type: D.WidthType.PERCENTAGE },
        rows,
      }),
    ];
  }

  function buildInvestmentsSection(D, inv, charts, t, country, lang, grammar) {
    if (!inv) return [];
    const blocks = [];
    blocks.push(sectionTitleP(D, `${country} - ${t.fdi}`));
    if (!inv.hasData) {
      blocks.push(emptyTablePlaceholder(D, t, t.noFdiData));
      return blocks;
    }
    blocks.push(...buildInvestmentsSummary(D, inv, t, country, lang, grammar));
    blocks.push(buildFdiTable(D, inv, t, lang));
    if (charts && charts.fdi) {
      const block = captionedChartP(D, t.fdiShort, charts.fdi);
      if (block) blocks.push(block);
    }
    if (inv.sectors) {
      const sectorsBlocks = buildFdiSectorsTable(D, inv.sectors, country, lang);
      if (sectorsBlocks) blocks.push(...sectorsBlocks);
    }
    return blocks;
  }

  // ── Companies section ──────────────────────────────────────────────────
  // Mirrors statistics-pdf.js buildCompaniesSection. Bullet list of
  // company-count breakdowns by capital origin.
  function buildCompaniesSection(D, state, t, country, lang, countryNameEn, grammar) {
    const hasOwn = !!(state && state.hasData && state.counts);
    const combined = state && state.combined;
    if (!hasOwn && !combined) return [];
    const isKa = lang === 'ka';
    const displayCountry = isKa
      ? (state.countryKa || country)
      : (state.countryEn || countryNameEn || country);
    // Georgian genitive ("of <country>") from the grammar sheet, falling
    // back to the suffix concatenation for countries the sheet doesn't
    // cover. Replaces the previous `${displayCountry}-ის` which produced
    // "თურქეთი-ის" instead of "თურქეთის".
    const countryOf = isKa
      ? ((grammar && grammar.of) || (displayCountry + 'ის'))
      : displayCountry;
    const c = (state && state.counts) || {};
    const B = (s) => ({ text: s, bold: true });
    const fmt = (n) => Number(n || 0).toLocaleString();
    const title = isKa ? 'კომპანიები' : 'Companies';

    const out = [];
    out.push(sectionTitleP(D, title));

    if (hasOwn) {
      if (isKa) {
        out.push(summaryProseParagraph(D, [
          `${countryOf} კაპიტალის მონაწილეობით დარეგისტრირებული მოქმედი კომპანიები:`,
        ]));
        out.push(summaryProseParagraph(D, [
          B(fmt(c.total)), ` მოქმედი კომპანია ${countryOf} კაპიტალის მონაწილეობით.`,
        ]));
      } else {
        out.push(summaryProseParagraph(D, [
          `Active companies with capital originating from ${displayCountry}:`,
        ]));
        out.push(summaryProseParagraph(D, [
          B(fmt(c.total)), ` active companies with capital originating from ${displayCountry}.`,
        ]));
      }
    }

    // Bulleted list — docx bullets via numbering. Use a built-in
    // bullet style instead of declaring our own. Each bullet is one
    // Paragraph with bullet: { level: 0 }.
    const bullet = (parts) => new D.Paragraph({
      bullet: { level: 0 },
      spacing: { after: pt(2), line: 312, lineRule: 'auto' },
      children: parts.flatMap(p => {
        if (p == null) return [];
        if (typeof p === 'string') {
          return tr(D, { text: p, size: hp(10), color: COLOR.text });
        }
        return tr(D, {
          text: String(p.text || ''),
          size: hp(10),
          color: p.color || COLOR.text,
          bold: !!p.bold,
          italics: !!p.italics,
        });
      }),
    });

    if (hasOwn && !(state && state.suppressBreakdown)) {
      if (isKa) {
        out.push(bullet([B(fmt(c.solo)), ` კომპანია - ${countryOf} კაპიტალით შექმნილი;`]));
        out.push(bullet([B(fmt(c.withGeorgia)), ` კომპანია - ${displayCountry} - საქართველოს წილობრივი კაპიტალით შექმნილი;`]));
        out.push(bullet([B(fmt(c.withGeorgiaAndThird)), ` კომპანია - ${displayCountry}, საქართველოსა და მესამე ქვეყნის კაპიტალით შექმნილი;`]));
        out.push(bullet([B(fmt(c.withThirdOnly)), ` კომპანია - ${countryOf} და მესამე ქვეყნების წილობრივი კაპიტალით შექმნილი.`]));
      } else {
        out.push(bullet([B(fmt(c.solo)), ` companies - established with capital from only ${displayCountry};`]));
        out.push(bullet([B(fmt(c.withGeorgia)), ` companies - established with joint capital from ${displayCountry} and Georgia;`]));
        out.push(bullet([B(fmt(c.withGeorgiaAndThird)), ` companies - established with joint capital from ${displayCountry}, Georgia and the third country;`]));
        out.push(bullet([B(fmt(c.withThirdOnly)), ` companies - established with joint capital from ${displayCountry} and third countries.`]));
      }
    }

    if (combined) {
      // Single sentence for the legacy Serbia-Montenegro union — no
      // breakdown bullets.
      const cbOf = isKa ? combined.labelKaOf : combined.labelEn;
      const cbNom = isKa ? combined.labelKa : combined.labelEn;
      if (isKa) {
        out.push(summaryProseParagraph(D, [
          B(fmt(combined.total)), ` მოქმედი კომპანია ${cbOf} კაპიტალის მონაწილეობით.`,
        ]));
      } else {
        out.push(summaryProseParagraph(D, [
          B(fmt(combined.total)), ` active companies with capital originating from ${cbNom}.`,
        ]));
      }
    }

    return out;
  }

  // ── Appendix section ──────────────────────────────────────────────────
  // Multi-year trade matrix mirroring statistics-pdf.js
  // buildAppendixSection. Each metric block (turnover/export/import)
  // contributes 4 rows: group totals, country values, change %, share %.
  // The final balance row uses the same group styling. Starts on a new
  // page because the table is too wide to share a page with other
  // content.
  function buildAppendixSection(D, appendix, t, country, lang) {
    if (!appendix || !Array.isArray(appendix.columns) || !appendix.columns.length) return [];
    const hasAny = (appendix.data || []).some(d => d && d.totals);
    if (!hasAny) return [];

    const cols = appendix.columns;
    const N = cols.length;
    const countryAbbr = (country || '').slice(0, 3);

    function canCompareChange(i) {
      if (i === 0) return false;
      const a = cols[i - 1], b = cols[i];
      if (a.kind !== b.kind) return false;
      if (b.year - a.year !== 1) return false;
      if (b.kind === 'ytd' && a.months.length !== b.months.length) return false;
      return true;
    }
    const getCountry = (i, flow) => {
      const d = appendix.data[i];
      return d && d.country ? d.country[flow] : null;
    };
    const getTotal = (i, flow) => {
      const d = appendix.data[i];
      return d && d.totals ? d.totals[flow] : null;
    };

    function formatNumOr(v) { return v == null || !isFinite(v) ? '-' : formatMln2(v); }
    function pctColored(v, signed) {
      if (v == null || !isFinite(v)) return { text: '-', color: COLOR.text };
      const color = v > 0 ? COLOR.positive : (v < 0 ? COLOR.negative : COLOR.headerText);
      const sign = signed && v > 0 ? '+' : '';
      return { text: `${sign}${formatPct(v)}`, color };
    }
    function pctPlain(v) {
      if (v == null || !isFinite(v)) return { text: '-' };
      return { text: formatPct(v) };
    }

    // Tiny appendix-only cell helpers — 7pt body / 7.5pt header. The
    // global dataCell defaults are 9pt so we override in opts.
    const APP_BODY = 7;
    const APP_HDR  = 7.5;
    function appCell(text, opts) {
      const { rowIdx, isLastRow, align, color, bold, shading, keepWithNext } = opts || {};
      const al = align === 'right' ? D.AlignmentType.RIGHT
               : align === 'center' ? D.AlignmentType.CENTER
               : D.AlignmentType.LEFT;
      return makeCell(D, {
        children: [new D.Paragraph({
          alignment: al,
          keepNext: !!keepWithNext,
          children: tr(D, {
            text: String(text),
            size: hp(opts && opts.size ? opts.size : APP_BODY),
            color: color || COLOR.text, bold: !!bold,
          }),
        })],
        rowIdx,
        isLastRow,
        shading,
      });
    }
    function appHeaderCell(text, opts) {
      return makeCell(D, {
        children: [new D.Paragraph({
          alignment: opts && opts.align === 'left' ? D.AlignmentType.LEFT : D.AlignmentType.RIGHT,
          keepNext: !!(opts && opts.keepWithNext),
          children: tr(D, {
            text: String(text),
            size: hp(APP_HDR), color: COLOR.headerText, bold: true,
          }),
        })],
        rowIdx: 0,
        shading: COLOR.headerFill,
      });
    }

    // 1 + 4×3 + 1 = 14 rows total (header + turnover/export/import × 4 + balance)
    const totalRows = 1 + 4 * 3 + 1;

    // Appendix table must not cut. Every cell paragraph in non-last
    // rows gets keepNext: true so Word treats the whole table as a
    // single block.
    const headerRow = new D.TableRow({
      children: [appHeaderCell('', { align: 'left', keepWithNext: true })]
        .concat(cols.map(c => appHeaderCell(c.label, { keepWithNext: true }))),
    });
    const rows = [headerRow];

    // groupRow: bold totals row that doubles as a section break.
    function pushGroupRow(grpLabel, flow, rowIdx) {
      const isLast = rowIdx === totalRows - 1;
      const keep = !isLast;
      const cells = [appCell(grpLabel, {
        rowIdx, isLastRow: isLast, bold: true, size: APP_HDR,
        shading: COLOR.groupFill, color: COLOR.titleDark, keepWithNext: keep,
      })];
      cols.forEach((_, i) => {
        const v = getTotal(i, flow);
        cells.push(appCell(formatNumOr(v), {
          rowIdx, isLastRow: isLast, align: 'right', bold: true, size: APP_HDR,
          shading: COLOR.groupFill, color: COLOR.titleDark, keepWithNext: keep,
        }));
      });
      rows.push(new D.TableRow({ cantSplit: true, children: cells }));
    }
    function pushValueRow(label, flow, rowIdx) {
      const isLast = rowIdx === totalRows - 1;
      const keep = !isLast;
      const cells = [appCell(label, { rowIdx, isLastRow: isLast, color: COLOR.headerText, keepWithNext: keep })];
      cols.forEach((_, i) => {
        cells.push(appCell(formatNumOr(getCountry(i, flow)), {
          rowIdx, isLastRow: isLast, align: 'right', keepWithNext: keep,
        }));
      });
      rows.push(new D.TableRow({ cantSplit: true, children: cells }));
    }
    function pushChangeRow(flow, rowIdx) {
      const isLast = rowIdx === totalRows - 1;
      const keep = !isLast;
      const cells = [appCell(t.appChange, { rowIdx, isLastRow: isLast, color: COLOR.headerText, keepWithNext: keep })];
      cols.forEach((_, i) => {
        let cell;
        if (!canCompareChange(i)) cell = { text: '-', color: COLOR.text };
        else {
          const cur = getCountry(i, flow);
          const prev = getCountry(i - 1, flow);
          if (cur == null || prev == null || prev === 0) cell = { text: '-', color: COLOR.text };
          else cell = pctColored(((cur - prev) / prev) * 100, true);
        }
        cells.push(appCell(cell.text, {
          rowIdx, isLastRow: isLast, align: 'right', color: cell.color, keepWithNext: keep,
        }));
      });
      rows.push(new D.TableRow({ cantSplit: true, children: cells }));
    }
    function pushShareRow(flow, rowIdx) {
      const isLast = rowIdx === totalRows - 1;
      const keep = !isLast;
      const cells = [appCell(t.appShare, { rowIdx, isLastRow: isLast, color: COLOR.headerText, keepWithNext: keep })];
      cols.forEach((_, i) => {
        const cur = getCountry(i, flow);
        const tot = getTotal(i, flow);
        let cell;
        if (cur == null || !tot) cell = { text: '-' };
        else cell = pctPlain((cur / tot) * 100);
        cells.push(appCell(cell.text, {
          rowIdx, isLastRow: isLast, align: 'right', keepWithNext: keep,
        }));
      });
      rows.push(new D.TableRow({ cantSplit: true, children: cells }));
    }
    function pushFlowBlock(grpLabel, flow, startRowIdx) {
      pushGroupRow(grpLabel, flow, startRowIdx);
      pushValueRow(`${grpLabel}-${countryAbbr}`, flow, startRowIdx + 1);
      pushChangeRow(flow, startRowIdx + 2);
      pushShareRow(flow, startRowIdx + 3);
    }

    pushFlowBlock(t.appTurnoverGrp, 'turnover', 1);
    pushFlowBlock(t.appExportGrp,   'export',   5);
    pushFlowBlock(t.appImportGrp,   'import',   9);

    // Balance row (last)
    const balRowIdx = totalRows - 1;
    const balCells = [appCell(t.appBalanceGrp, {
      rowIdx: balRowIdx, isLastRow: true, bold: true, size: APP_HDR,
      shading: COLOR.groupFill, color: COLOR.titleDark,
    })];
    cols.forEach((_, i) => {
      const c = appendix.data[i] && appendix.data[i].country;
      let text = '-';
      let color = COLOR.titleDark;
      // Same null-on-either-side rule as the on-screen appendix:
      // unknown flow → balance is undefined, render '-'.
      if (c && c.export != null && c.import != null) {
        const bal = c.export - c.import;
        color = bal > 0 ? COLOR.positive : (bal < 0 ? COLOR.negative : COLOR.titleDark);
        const sign = bal < 0 ? '-' : '';
        text = `${sign}${formatMln2(Math.abs(bal))}`;
      }
      balCells.push(appCell(text, {
        rowIdx: balRowIdx, isLastRow: true, align: 'right', bold: true, size: APP_HDR,
        shading: COLOR.groupFill, color,
      }));
    });
    rows.push(new D.TableRow({ cantSplit: true, children: balCells }));

    return [
      sectionTitleP(D, `${country} - ${t.appendixSection}`),
      new D.Table({
        borders: tableBorders(),
        width: { size: 100, type: D.WidthType.PERCENTAGE },
        rows,
      }),
    ];
  }


  // ── Multi-run data cell ────────────────────────────────────────────────
  // Some trade-overview cells need two coloured runs in the same cell,
  // e.g. "1,234.56 mln $, increase 12%" where the value is black and the
  // change is green or red. dataCell takes a single string; this variant
  // takes an array of `{ text, color, bold }` descriptors.
  function dataCellRuns(D, runDescs, opts = {}) {
    const align = opts.align || 'left';
    const runs = runDescs.flatMap(r => tr(D, {
      text: String(r.text || ''),
      size: hp(r.size || 9),
      color: r.color || COLOR.text,
      bold: !!r.bold,
      italics: !!r.italics,
    }));
    return makeCell(D, {
      children: [new D.Paragraph({
        alignment: align === 'right' ? D.AlignmentType.RIGHT
                 : align === 'center' ? D.AlignmentType.CENTER
                 : D.AlignmentType.LEFT,
        keepNext: !!opts.keepWithNext,
        children: runs,
      })],
      rowIdx: opts.rowIdx,
      isLastRow: opts.isLastRow,
      shading: opts.shading,
      width: opts.width,
    });
  }

  // ── Trade overview table ──────────────────────────────────────────────
  // Mirrors statistics-pdf.js buildOverviewTable: 5 rows × 3 columns.
  // Header: blank, colFull (prevYear), colMonth ("Jan-Feb 2026").
  // Each subsequent row: bold label, fullYear cell, latestPeriod cell.
  // Cells encode either the standard "value, increase X%" two-run format,
  // a "positive/negative balance" line, or a centred grey "no trade"
  // sentinel.
  function buildOverviewTable(D, trade, t, periodLabel, lang) {
    const data = trade.overview;
    const colFull  = String(trade.prevYear);
    const colMonth = `${periodLabel} ${trade.latestYear}`;

    const rows = [
      { key: 'turnover', label: t.turnover },
      { key: 'export',   label: t.export   },
      { key: 'import',   label: t.import   },
      { key: 'balance',  label: t.balance  },
    ];
    const zeroMsg = { turnover: t.noTrade, export: t.noExports, import: t.noImports };

    function buildCell(value, prev, isBalance, key, periodData, rowIdx, isLastRow) {
      // "-" when balance shown for a no-trade period.
      if (isBalance && periodData.turnover === 0) {
        return dataCellRuns(D, [{ text: '-' }], { align: 'center', rowIdx, isLastRow });
      }
      // Centered grey sentinel for zero export/import/turnover.
      if (value === 0 && !isBalance && zeroMsg[key]) {
        return dataCellRuns(D, [{ text: zeroMsg[key], color: '94A3B8', size: 8.5 }], { align: 'center', rowIdx, isLastRow });
      }
      if (isBalance) {
        const sign  = value < 0 ? t.negative : t.positive;
        const color = value < 0 ? COLOR.negative : COLOR.positive;
        return dataCellRuns(D, [{
          text: `${sign} ${formatMln2(Math.abs(value))} ${t.mln}`, color,
        }], { align: 'center', rowIdx, isLastRow });
      }
      const pct = calcChange(value, prev);
      const dir = pct >= 0 ? t.increase : t.decrease;
      const changeColor = pct >= 0 ? COLOR.positive : COLOR.negative;
      return dataCellRuns(D, [
        { text: `${formatMln2(value)} ${t.mln}`, color: COLOR.titleDark },
        { text: `, ${dir} ${formatPct(pct)}`, color: changeColor },
      ], { align: 'center', rowIdx, isLastRow });
    }

    const totalRows = rows.length + 1; // header + data
    const headerRow = new D.TableRow({
      children: [
        headerCell(D, ''),
        headerCell(D, colFull,  { align: 'center' }),
        headerCell(D, colMonth, { align: 'center' }),
      ],
    });
    const bodyRows = rows.map((r, idx) => {
      const isBalance = r.key === 'balance';
      const fullVal = data.fullYear[r.key];
      const fullPrev = data.fullYear[r.key + 'Prev'];
      const monthVal = data.latestPeriod[r.key];
      const monthPrev = data.latestPeriod[r.key + 'Prev'];
      const rowIdx = idx + 1; // +1 for header
      const isLast = rowIdx === totalRows - 1;
      return new D.TableRow({
        cantSplit: true,
        children: [
          dataCell(D, r.label, { bold: true, rowIdx, isLastRow: isLast }),
          buildCell(fullVal,  fullPrev,  isBalance, r.key, data.fullYear,     rowIdx, isLast),
          buildCell(monthVal, monthPrev, isBalance, r.key, data.latestPeriod, rowIdx, isLast),
        ],
      });
    });

    return new D.Table({
      borders: tableBorders(),
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      rows: [headerRow, ...bodyRows],
    });
  }

  // ── Trade summary paragraphs ───────────────────────────────────────────
  // Mirrors statistics-pdf.js buildTradeSummary. Returns an array of
  // Paragraph blocks (heading + body paragraphs separated by faint
  // dividers). The text mixes plain runs with bold and italic spans —
  // each run is a TextRun in docx terms.
  //
  // `parts` is an array of either plain strings or { text, bold,
  // italics, color } descriptors. `prose(parts)` returns one Paragraph.
  function summaryProseParagraph(D, parts, opts = {}) {
    const runs = parts.flatMap(p => {
      if (p == null) return [];
      if (typeof p === 'string') {
        return tr(D, { text: p, size: hp(10), color: COLOR.text });
      }
      return tr(D, {
        text: String(p.text || ''),
        size: hp(10),
        color: p.color || COLOR.text,
        bold: !!p.bold,
        italics: !!p.italics,
      });
    });
    return new D.Paragraph({
      alignment: D.AlignmentType.JUSTIFIED,
      spacing: { after: pt(4), line: 312, lineRule: 'auto' },
      children: runs,
      ...opts,
    });
  }
  function summaryHeadingParagraph(D, text) {
    return new D.Paragraph({
      spacing: { before: pt(2), after: pt(4) },
      children: tr(D, {
        text, bold: true,
        size: hp(11), color: COLOR.titleDark,
      }),
    });
  }
  function summaryDividerParagraph(D) {
    // pdfmake draws a 0.5pt grey rule; in docx the closest analogue
    // without a real <hr> is a paragraph with a bottom border.
    return new D.Paragraph({
      spacing: { before: pt(6), after: pt(6) },
      border: {
        bottom: { color: 'D1D5DB', space: 1, style: 'single', size: 4 },
      },
      children: [new D.TextRun({ text: '', font: 'Arial', size: hp(2) })],
    });
  }

  function buildTradeSummary(D, trade, t, country, lang) {
    if (!trade) return [];
    const isKa = lang === 'ka';
    const periodGen = isKa ? gePeriodGen(trade.latestYear, trade.latestMonth) : null;
    const periodLoc = isKa ? gePeriodLoc(trade.latestYear, trade.latestMonth) : null;
    const periodEn  = !isKa ? enPeriod(trade.latestYear, trade.latestMonth)  : null;
    const rank = trade.ranking && trade.ranking.country ? trade.ranking.country : null;
    // Hide rank-prose when the country sits outside the top 20 — bare
    // ordinals like "47th" don't add value. Volumes still render.
    const TOP_RANK_LIMIT = 20;
    const inTop = (r) => r && r.rank <= TOP_RANK_LIMIT;

    const B = (s) => ({ text: s, bold: true });
    const I = (s) => ({ text: s, italics: true });
    const pctInt = (x) => Math.round(Math.abs(x));
    const pctOne = (x) => (Math.round(x * 10) / 10).toFixed(1);

    function changeVerbParts(current, prev) {
      const c = calcChange(current, prev);
      const abs = pctInt(c);
      if (isKa) {
        const verb = c >= 0 ? 'გაიზარდა' : 'შემცირდა';
        return B(`${verb} ${abs}%-ით`);
      }
      const verb = c >= 0 ? 'increased' : 'decreased';
      return B(`${verb} by ${abs}%`);
    }

    function productListParts(products) {
      if (!products || !products.length) return [];
      const parts = [];
      const items = products.slice(0, 10);
      const unit = isKa ? 'მლნ. $' : 'mln $';
      items.forEach((p, i) => {
        const sign = p.change > 0 ? '+' : '';
        const name = isKa ? p.name : (p.nameEn || p.name);
        parts.push(name + ' ');
        parts.push(I(`(${formatMln(p.valueMln)} ${unit}, ${sign}${formatPct(p.change)})`));
        parts.push(i < items.length - 1 ? ', ' : '.');
      });
      return parts;
    }

    const out = [];

    const curTurn  = trade.overview.latestPeriod.turnover;
    const prevTurn = trade.overview.latestPeriod.turnoverPrev;
    const curExp   = trade.overview.latestPeriod.export;
    const prevExp  = trade.overview.latestPeriod.exportPrev;
    const curImp   = trade.overview.latestPeriod.import;
    const prevImp  = trade.overview.latestPeriod.importPrev;

    // ── Turnover ──────────────────────────────────────────────────────
    out.push(summaryHeadingParagraph(D, isKa ? 'სავაჭრო ბრუნვა' : 'Trade Turnover'));
    if (curTurn < 0.01) {
      const widen = trade.hasAnyTrade === false && trade.fiveYearStart;
      const kaLabel = widen
        ? gePeriodGenRange(trade.fiveYearStart, trade.latestYear, trade.latestMonth)
        : periodGen;
      const enLabel = widen
        ? enPeriodRange(trade.fiveYearStart, trade.latestYear, trade.latestMonth)
        : periodEn;
      out.push(summaryProseParagraph(D, [
        isKa
          ? `${kaLabel} მონაცემებით, ვაჭრობა არ განხორციელდა.`
          : `For ${enLabel}, no trade was conducted.`,
      ]));
      return out;
    }
    if (isKa) {
      out.push(summaryProseParagraph(D, [
        `${periodGen} მონაცემებით, სავაჭრო ბრუნვა, წინა წლის ანალოგიურ პერიოდთან შედარებით, `,
        changeVerbParts(curTurn, prevTurn),
        ` და `, B(`${formatMln(curTurn)} მლნ. აშშ დოლარი`), ` შეადგინა.`,
      ]));
      if (inTop(rank && rank.turnover)) {
        out.push(summaryProseParagraph(D, [
          `${country} აღნიშნულ პერიოდში სავაჭრო ბრუნვის მოცულობის მიხედვით არის `,
          B(`${gePlace(rank.turnover.rank)} ადგილზე`), `, წილი `, B(`${pctOne(rank.turnover.sharePct)}%`), `.`,
        ]));
      }
    } else {
      out.push(summaryProseParagraph(D, [
        `For ${periodEn}, trade turnover `,
        changeVerbParts(curTurn, prevTurn),
        ` compared to the same period last year, amounting to `, B(`${formatMln(curTurn)} mln USD`), `.`,
      ]));
      if (inTop(rank && rank.turnover)) {
        out.push(summaryProseParagraph(D, [
          `${country} ranks `, B(enOrdinal(rank.turnover.rank)),
          ` by trade turnover with a `, B(`${pctOne(rank.turnover.sharePct)}%`), ` share.`,
        ]));
      }
    }

    // ── Export ────────────────────────────────────────────────────────
    out.push(summaryDividerParagraph(D));
    out.push(summaryHeadingParagraph(D, isKa ? 'ექსპორტი' : 'Export'));
    if (!trade.hasExport || curExp < 0.01) {
      out.push(summaryProseParagraph(D, [
        isKa ? `ექსპორტი ${periodLoc} არ განხორციელდა.` : `No exports were conducted in ${periodEn}.`,
      ]));
    } else {
      if (isKa) {
        out.push(summaryProseParagraph(D, [
          `ექსპორტი ${periodLoc} `,
          changeVerbParts(curExp, prevExp),
          ` და `, B(`${formatMln(curExp)} მლნ. აშშ დოლარი`), ` შეადგინა.`,
          ...(inTop(rank && rank.export) ? [
            ` საქართველოსთვის ექსპორტის მიხედვით ${country} არის `,
            B(`${gePlace(rank.export.rank)} ადგილზე`),
            ` საქართველოს სავაჭრო პარტნიორებს შორის, წილი `,
            B(`${pctOne(rank.export.sharePct)}%`), `.`,
          ] : []),
        ]));
      } else {
        out.push(summaryProseParagraph(D, [
          `Exports in ${periodEn} `,
          changeVerbParts(curExp, prevExp),
          `, amounting to `, B(`${formatMln(curExp)} mln USD`), `.`,
          ...(inTop(rank && rank.export) ? [
            ` ${country} ranks `, B(enOrdinal(rank.export.rank)),
            ` by export volume with a `, B(`${pctOne(rank.export.sharePct)}%`), ` share.`,
          ] : []),
        ]));
      }
      if (rank && rank.domesticExport && curExp > 0) {
        const domVal = rank.domesticExport.valueMln;
        const domPct = (100 * domVal / curExp).toFixed(0);
        const reVal = rank.reExport ? rank.reExport.valueMln : (curExp - domVal);
        const rePct = (100 * reVal / curExp).toFixed(0);
        const showDomRank = inTop(rank.domesticExport);
        if (isKa) {
          out.push(summaryProseParagraph(D, [
            `${periodGen} პერიოდში განხორციელდა `,
            B(`${formatMln(domVal)} მლნ. აშშ დოლარის`),
            ` `, B('ადგილობრივი ექსპორტი'), `, რაც შეადგენს `, B(`${domPct}%-ს`), ` სრული ექსპორტის. `,
            ...(showDomRank ? [
              `ადგილობრივი ექსპორტით ${country} იკავებს `,
              B(`${gePlace(rank.domesticExport.rank)} ადგილს`),
              ` საქართველოს სავაჭრო პარტნიორებს შორის. `,
            ] : []),
            `რე-ექსპორტმა იმავე პერიოდში შეადგინა `,
            B(`${formatMln(reVal)} მლნ. აშშ დოლარი`), ` `, I(`(წილი ${rePct}%)`), `.`,
          ]));
        } else {
          out.push(summaryProseParagraph(D, [
            `In the given period, domestic exports amounted to `,
            B(`${formatMln(domVal)} mln USD`),
            `, comprising `, B(`${domPct}%`), ` of total exports. `,
            ...(showDomRank ? [
              `By domestic exports, ${country} ranks `, B(enOrdinal(rank.domesticExport.rank)),
              ` among Georgia's trading partners. `,
            ] : []),
            `Re-exports in the same period amounted to `,
            B(`${formatMln(reVal)} mln USD`), ` `, I(`(${rePct}% share)`), `.`,
          ]));
        }
      }
      const expParts = productListParts(trade.exportProducts);
      if (expParts.length) {
        out.push(summaryProseParagraph(D, [
          B(isKa ? 'ძირითადი საექსპორტო პროდუქცია: ' : 'Main export products: '),
          ...expParts,
        ]));
      }
    }

    // ── Import ────────────────────────────────────────────────────────
    out.push(summaryDividerParagraph(D));
    out.push(summaryHeadingParagraph(D, isKa ? 'იმპორტი' : 'Import'));
    if (!trade.hasImport || curImp < 0.01) {
      out.push(summaryProseParagraph(D, [
        isKa ? `იმპორტი ${periodLoc} არ განხორციელდა.` : `No imports were conducted in ${periodEn}.`,
      ]));
    } else {
      if (isKa) {
        out.push(summaryProseParagraph(D, [
          `იმპორტი ${periodLoc} `,
          changeVerbParts(curImp, prevImp),
          ` და `, B(`${formatMln(curImp)} მლნ. აშშ დოლარი`), ` შეადგინა.`,
          ...(inTop(rank && rank.import) ? [
            ` იმპორტის მიხედვით ${country} არის `,
            B(`${gePlace(rank.import.rank)} ადგილზე`),
            ` საქართველოს სავაჭრო პარტნიორებს შორის, წილი `,
            B(`${pctOne(rank.import.sharePct)}%`), `.`,
          ] : []),
        ]));
      } else {
        out.push(summaryProseParagraph(D, [
          `Imports in ${periodEn} `,
          changeVerbParts(curImp, prevImp),
          `, amounting to `, B(`${formatMln(curImp)} mln USD`), `.`,
          ...(inTop(rank && rank.import) ? [
            ` ${country} ranks `, B(enOrdinal(rank.import.rank)),
            ` by import volume with a `, B(`${pctOne(rank.import.sharePct)}%`), ` share.`,
          ] : []),
        ]));
      }
      const impParts = productListParts(trade.importProducts);
      if (impParts.length) {
        out.push(summaryProseParagraph(D, [
          B(isKa ? 'ძირითადი საიმპორტო პროდუქცია: ' : 'Main import products: '),
          ...impParts,
        ]));
      }
    }

    return out;
  }

  // ── Trade products + change tables ─────────────────────────────────────
  // Both tables share the "row of HS code + value + change %" structure
  // with optional extra columns. Mirrors statistics-pdf.js
  // buildProductsTable / buildChangeTable.

  function emptyTablePlaceholder(D, t, customText) {
    return new D.Paragraph({
      spacing: { before: pt(4), after: pt(8) },
      children: tr(D, {
        text: customText || t.noData, italics: true,
        size: hp(9), color: '94A3B8',
      }),
    });
  }

  function buildProductsTable(D, products, t, lang) {
    if (!products || products.length === 0) return emptyTablePlaceholder(D, t);
    const showReexport = products.some(p => p.reexportShare !== undefined);
    const totalRows = 1 + products.length;

    const headerCells = [
      headerCell(D, t.hsProduct),
      headerCell(D, t.volumeHeader, { align: 'right' }),
      headerCell(D, t.changeHeader, { align: 'right' }),
    ];
    if (showReexport) headerCells.push(headerCell(D, t.reexportShareShort, { align: 'right' }));
    const rows = [new D.TableRow({ children: headerCells })];

    products.forEach((p, idx) => {
      const change = p.change;
      const changeColor = change > 0 ? COLOR.positive : (change < 0 ? COLOR.negative : COLOR.headerText);
      const sign = change > 0 ? '+' : '';
      const rowIdx = idx + 1;
      const isLast = rowIdx === totalRows - 1;
      const cells = [
        dataCell(D, lang === 'en' && p.nameEn ? p.nameEn : p.name, { rowIdx, isLastRow: isLast }),
        dataCell(D, formatMln(p.valueMln), { align: 'right', rowIdx, isLastRow: isLast }),
        dataCell(D, `${sign}${formatPct(change)}`, { align: 'right', color: changeColor, rowIdx, isLastRow: isLast }),
      ];
      if (showReexport) {
        cells.push(dataCell(D,
          p.reexportShare === 0 || p.reexportShare == null ? '-' : formatPct(p.reexportShare),
          { align: 'right', rowIdx, isLastRow: isLast },
        ));
      }
      rows.push(new D.TableRow({ cantSplit: true, children: cells }));
    });

    // Column widths (twips). Matches the PDF widths roughly:
    //   product name fills, value 80pt, change 62pt, reexport 80pt.
    const cols = showReexport
      ? [{ size: '*' }, { size: pt(80) }, { size: pt(62) }, { size: pt(80) }]
      : [{ size: '*' }, { size: pt(80) }, { size: pt(70) }];
    return new D.Table({
      borders: tableBorders(),
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      columnWidths: cols.map(c => c.size === '*' ? pt(280) : c.size),
      rows,
    });
  }

  function buildChangeTable(D, products, t, lang) {
    if (!products || products.length === 0) return emptyTablePlaceholder(D, t);
    const totalRows = 1 + products.length;
    const headerCells = [
      headerCell(D, t.hsProduct),
      headerCell(D, t.volumeHeader, { align: 'right' }),
      headerCell(D, t.changeHeader, { align: 'right' }),
      headerCell(D, t.differenceHeader, { align: 'right' }),
    ];
    const rows = [new D.TableRow({ children: headerCells })];

    products.forEach((p, idx) => {
      const changeColor = p.changePct > 0 ? COLOR.positive : COLOR.negative;
      const diffColor = p.diffMln > 0 ? COLOR.positive : COLOR.negative;
      const changeSign = p.changePct > 0 ? '+' : '';
      const diffSign = p.diffMln > 0 ? '+' : '';
      const valueText = p.valueMln > 0 ? formatMln(p.valueMln) : '-';
      const rowIdx = idx + 1;
      const isLast = rowIdx === totalRows - 1;
      rows.push(new D.TableRow({
        cantSplit: true,
        children: [
          dataCell(D, lang === 'en' && p.nameEn ? p.nameEn : p.name, { rowIdx, isLastRow: isLast }),
          dataCell(D, valueText, { align: 'right', rowIdx, isLastRow: isLast }),
          dataCell(D, `${changeSign}${formatPct(p.changePct)}`, { align: 'right', color: changeColor, rowIdx, isLastRow: isLast }),
          dataCell(D, `${diffSign}${formatMln(Math.abs(p.diffMln))}`, { align: 'right', color: diffColor, rowIdx, isLastRow: isLast }),
        ],
      }));
    });

    return new D.Table({
      borders: tableBorders(),
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      columnWidths: [pt(280), pt(80), pt(62), pt(80)],
      rows,
    });
  }

  // ── Trade section ──────────────────────────────────────────────────────
  // Mirrors statistics-pdf.js buildTradeSection but emits docx blocks.
  // Step 3a only: section title + summary placeholder + overview table +
  // the two chart images. Product/change tables and the prose summary
  // land in subsequent commits.
  function buildTradeSection(D, trade, charts, t, country, lang) {
    if (!trade) return [];
    const periodLabel = periodShortLabel(trade.latestMonth, lang) || trade.periodLabel;
    const title = `${country} - ${t.tradeOverview}, ${periodLabel} ${trade.latestYear}`;

    const blocks = [];
    blocks.push(sectionTitleP(D, title));
    // Real summary paragraphs (step 3b).
    blocks.push(...buildTradeSummary(D, trade, t, country, lang));
    blocks.push(buildOverviewTable(D, trade, t, periodLabel, lang));

    // Chart caption + image as a single paragraph so Word can't drop
    // the caption on one page and the image on the next.
    if (charts && charts.turnover) {
      const block = captionedChartP(D, t.turnover, charts.turnover);
      if (block) blocks.push(block);
    }
    if (charts && charts.dynamics) {
      // Same one-paragraph approach, but with an inline legend on the
      // line between caption and image. Three TextRun groups joined by
      // line breaks, all wrapped in keepLines: true.
      const bytes = dataUrlToBytes(charts.dynamics);
      if (bytes) {
        blocks.push(new D.Paragraph({
          alignment: D.AlignmentType.CENTER,
          spacing: { before: pt(2), after: pt(8) },
          keepLines: true,
          keepNext: true,
          children: [
            ...tr(D, { text: t.dynamics, bold: true, size: hp(9.5), color: COLOR.text }),
            new D.TextRun({ text: '', break: 1 }),
            ...tr(D, { text: '■ ', size: hp(8), color: COLOR.positive }),
            ...tr(D, { text: `${t.export}    `, size: hp(8), color: COLOR.text }),
            ...tr(D, { text: '■ ', size: hp(8), color: COLOR.negative }),
            ...tr(D, { text: t.import, size: hp(8), color: COLOR.text }),
            new D.TextRun({ text: '', break: 1 }),
            new D.ImageRun({
              data: bytes,
              transformation: { width: px(500), height: px(153) },
            }),
          ],
        }));
      }
    }

    // ── Export products + most-increased / -decreased ────────────────
    if (trade.hasExport) {
      blocks.push(subTitleP(D, `${t.mainExport}, ${periodLabel} ${trade.latestYear}`));
      blocks.push(buildProductsTable(D, trade.exportProducts, t, lang));

      const incLabel = trade.exportGrowing ? t.exportIncrease : t.exportDrop;
      const dropLabel = trade.exportGrowing ? t.exportDrop : t.exportIncrease;
      const incProds = trade.exportGrowing ? trade.exportChange.increase : trade.exportChange.drop;
      const dropProds = trade.exportGrowing ? trade.exportChange.drop : trade.exportChange.increase;

      if (incProds && incProds.length) {
        blocks.push(subTitleP(D, `${incLabel}, ${periodLabel} ${trade.latestYear}`));
        blocks.push(buildChangeTable(D, incProds, t, lang));
      }
      if (dropProds && dropProds.length) {
        blocks.push(subTitleP(D, `${dropLabel}, ${periodLabel} ${trade.latestYear}`));
        blocks.push(buildChangeTable(D, dropProds, t, lang));
      }
    }

    // ── Import products + most-increased / -decreased ────────────────
    if (trade.hasImport) {
      blocks.push(subTitleP(D, `${t.mainImport}, ${periodLabel} ${trade.latestYear}`));
      blocks.push(buildProductsTable(D, trade.importProducts, t, lang));

      const incLabel = trade.importGrowing ? t.importIncrease : t.importDrop;
      const dropLabel = trade.importGrowing ? t.importDrop : t.importIncrease;
      const incProds = trade.importGrowing ? trade.importChange.increase : trade.importChange.drop;
      const dropProds = trade.importGrowing ? trade.importChange.drop : trade.importChange.increase;

      if (incProds && incProds.length) {
        blocks.push(subTitleP(D, `${incLabel}, ${periodLabel} ${trade.latestYear}`));
        blocks.push(buildChangeTable(D, incProds, t, lang));
      }
      if (dropProds && dropProds.length) {
        blocks.push(subTitleP(D, `${dropLabel}, ${periodLabel} ${trade.latestYear}`));
        blocks.push(buildChangeTable(D, dropProds, t, lang));
      }
    }

    return blocks;
  }

  // ── Public API ─────────────────────────────────────────────────────────
  function filenameFor(country, lang) {
    const safeCountry = (country || 'report').replace(/[^a-zA-Z0-9Ⴀ-ჿ]/g, '_');
    return `${safeCountry}_statistics_${lang || 'en'}.docx`;
  }
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function build(state, opts) {
    if (typeof window.docx === 'undefined') {
      throw new Error('docx library not loaded');
    }
    const D = window.docx;
    const fontBytes = await ensureFontBytes();
    const lang = (opts && opts.lang) || 'en';
    const t = T[lang] || T.en;
    const country = lang === 'en' && opts && opts.countryNameEn ? opts.countryNameEn : (opts && opts.country) || 'Country';

    // Section content — Trade is fully wired (overview + chart embeds);
    // the rest are placeholders until subsequent commits.
    const tradeCharts = (opts && opts.charts) || {};
    const grammar = state && state.countryGrammar;
    const investmentsState = state && state.investments
      ? Object.assign({}, state.investments, { sectors: state.investmentsSectors || null })
      : state && state.investments;
    const children = [
      ...buildTradeSection(D, state && state.trade, tradeCharts, t, country, lang),
      ...buildTourismSection(D, state && state.tourism, tradeCharts, t, country, lang, grammar),
      ...buildInvestmentsSection(D, investmentsState, tradeCharts, t, country, lang, grammar),
      ...buildCompaniesSection(D, state && state.companies, t, country, lang, opts && opts.countryNameEn, grammar),
      ...buildAppendixSection(D, state && state.appendix, t, country, lang),
    ];

    const doc = buildDocxDocument(D, children, {
      lang,
      country,
      countryNameEn: opts && opts.countryNameEn,
      fontBytes,
    });

    const blob = await D.Packer.toBlob(doc);
    triggerDownload(blob, filenameFor(country, lang));
  }

  window.StatisticsWord = { build };
})();
