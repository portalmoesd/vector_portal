/**
 * Statistics PDF Export (pdfmake-based)
 * Produces a multi-section vector PDF covering Trade, Tourism and Investments
 * in one document. Tables flow natively across pages without cutting rows.
 *
 * Usage:
 *   await StatisticsPdf.build(state, { lang: 'en'|'ka', country });
 */
(function () {
  'use strict';

  // ── Font loading ────────────────────────────────────────────────────────
  let fontsPromise = null;

  function abToB64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  // Arial covers Latin/digits/Cyrillic universally but has zero Georgian
  // glyphs; Sylfaen is Microsoft's classic Georgian companion (84/96
  // Mkhedruli). We embed both in every PDF so recipients on any OS see
  // identical output. Sylfaen Bold isn't bundled — Sylfaen Regular is
  // registered for both weights, mirroring how the previous FiraGO setup
  // mapped italics/bolditalics to Regular.
  async function ensureFonts() {
    if (fontsPromise) return fontsPromise;
    fontsPromise = (async () => {
      const [arialReg, arialBold, sylfaen] = await Promise.all([
        fetch('/fonts/Arial-Regular.ttf').then(r => r.arrayBuffer()),
        fetch('/fonts/Arial-Bold.ttf').then(r => r.arrayBuffer()),
        fetch('/fonts/Sylfaen.ttf').then(r => r.arrayBuffer()),
      ]);
      pdfMake.vfs = Object.assign({}, pdfMake.vfs || {}, {
        'Arial-Regular.ttf': abToB64(arialReg),
        'Arial-Bold.ttf': abToB64(arialBold),
        'Sylfaen.ttf': abToB64(sylfaen),
      });
      pdfMake.fonts = {
        Arial: {
          normal: 'Arial-Regular.ttf',
          bold: 'Arial-Bold.ttf',
          italics: 'Arial-Regular.ttf',
          bolditalics: 'Arial-Bold.ttf',
        },
        Sylfaen: {
          normal: 'Sylfaen.ttf',
          bold: 'Sylfaen.ttf',
          italics: 'Sylfaen.ttf',
          bolditalics: 'Sylfaen.ttf',
        },
      };
    })();
    return fontsPromise;
  }

  // Walk a pdfmake docDefinition tree and replace every leaf string
  // appearing in a `text:` property with an array of per-script runs
  // ({ text, font }). This lets pdfmake emit Latin segments via Arial
  // and Georgian segments via Sylfaen without rewriting every emitter
  // call site. Non-leaf properties (table cells, columns, stack, etc.)
  // recurse normally; numbers/booleans/null are left untouched.
  function applyScriptFonts(node) {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = applyScriptFonts(node[i]);
      return node;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (k === 'text') {
        node[k] = scriptifyTextValue(v);
      } else if (v && typeof v === 'object') {
        applyScriptFonts(v);
      }
    }
    return node;
  }

  // Eager script-split helper for content emitted lazily (e.g. pdfmake
  // header/footer functions, which run after applyScriptFonts has already
  // walked the doc tree). Returns an array suitable for pdfmake's
  // `text: [...]` form.
  function splitText(s) {
    return window.FontUtils.splitByScript(s).map(seg => ({ text: seg.text, font: seg.font }));
  }

  function scriptifyTextValue(value) {
    if (typeof value === 'string') {
      if (!window.FontUtils.hasGeorgian(value)) return value;
      return window.FontUtils.splitByScript(value).map(seg => ({ text: seg.text, font: seg.font }));
    }
    if (Array.isArray(value)) {
      const flat = [];
      for (const item of value) {
        if (typeof item === 'string') {
          if (!window.FontUtils.hasGeorgian(item)) {
            flat.push(item);
          } else {
            for (const seg of window.FontUtils.splitByScript(item)) {
              flat.push({ text: seg.text, font: seg.font });
            }
          }
        } else if (item && typeof item === 'object') {
          flat.push(applyScriptFonts(item));
        } else {
          flat.push(item);
        }
      }
      return flat;
    }
    if (value && typeof value === 'object') {
      return applyScriptFonts(value);
    }
    return value;
  }

  // ── Labels ──────────────────────────────────────────────────────────────
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

  // ── Georgian month declension ──────────────────────────────────────────
  // Keyed by month number (1..12). `stem` is the first-month-in-range form
  // (e.g. "იანვარ" in "იანვარ-თებერვლის"), `gen` is the genitive form used
  // in "…მონაცემებით" sentences, `loc` is the locative used in "…ში" form.
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

  const EN_MONTHS = { 1:'Jan', 2:'Feb', 3:'Mar', 4:'Apr', 5:'May', 6:'Jun', 7:'Jul', 8:'Aug', 9:'Sep', 10:'Oct', 11:'Nov', 12:'Dec' };

  const KA_MONTHS_SHORT = { 1:'იან', 2:'თებ', 3:'მარ', 4:'აპრ', 5:'მაი', 6:'ივნ', 7:'ივლ', 8:'აგვ', 9:'სექ', 10:'ოქტ', 11:'ნოე', 12:'დეკ' };

  // Derive the short period label ("Jan-Feb" / "იან-თებ") from latestMonth +
  // the PDF's language. trade.periodLabel is baked from the page locale at
  // fetch time, which is wrong when PDF language differs from page language.
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

  // Widened "no trade" range — spans the 5-year lookback + latest
  // period, e.g. "2021-2026 წლის იანვარ-თებერვლის" / "Jan-Feb 2021-2026".
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
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }

  // ── Formatting helpers ─────────────────────────────────────────────────
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

  function formatDate(locale) {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }

  // ── Section title row ──────────────────────────────────────────────────
  // sectionTitle / subTitle use named styles so the pageBreakBefore callback
  // (see buildDocDefinition) can identify them and push them to the next
  // page when their following content would otherwise be orphaned.
  function sectionTitle(text) {
    return { text: text, style: 'sectionTitle', headlineLevel: 1 };
  }

  function subTitle(text) {
    return { text: text, style: 'subTitle', headlineLevel: 2 };
  }

  // Wrap a title + its immediately-following content in an `unbreakable`
  // stack so the title never gets orphaned at the bottom of a page. pdfmake
  // keeps the whole stack on one page when it fits; if the content is
  // larger than a page, it still starts fresh on a new page (title + first
  // rows together), then lets the rest flow naturally.
  function withTitle(title, ...content) {
    return {
      unbreakable: true,
      stack: [title, ...content],
    };
  }

  // Shared pdfmake table layout
  const tableLayout = {
    hLineWidth: (i) => (i === 0 ? 0 : i === 1 ? 1 : 0.5),
    vLineWidth: () => 0,
    hLineColor: (i) => (i === 1 ? '#94a3b8' : '#e5e7eb'),
    paddingTop: () => 4,
    paddingBottom: () => 4,
    paddingLeft: () => 6,
    paddingRight: () => 6,
  };

  function th(text) {
    return { text: text, bold: true, fontSize: 8, color: '#475569', fillColor: '#f8fafc' };
  }

  function thRight(text) {
    return { text: text, bold: true, fontSize: 8, color: '#475569', fillColor: '#f8fafc', alignment: 'right' };
  }

  function thCenter(text) {
    return { text: text, bold: true, fontSize: 8, color: '#475569', fillColor: '#f8fafc', alignment: 'center' };
  }

  function tdNum(text, opts = {}) {
    return { text: text, alignment: 'right', fontSize: 9, ...opts };
  }
  function tdText(text, opts = {}) {
    return { text: text, fontSize: 9, ...opts };
  }

  function colorCell(value, isPositive) {
    // wrap tdNum with colour
    if (value > 0) return { color: '#16a34a' };
    if (value < 0) return { color: '#dc2626' };
    return {};
  }

  // ── Trade: overview table ──────────────────────────────────────────────
  function buildOverviewTable(data, periodMeta, t, latestMonth, monthNames) {
    const prevYear = periodMeta.prevYear;
    const latestYear = periodMeta.latestYear;
    const colFull = String(prevYear);
    const monthLbl = monthNames.find(m => m.value === latestMonth)?.label || '';
    const colMonth = `${periodMeta.periodLabel} ${latestYear}`;

    const rows = [
      { key: 'turnover', label: t.turnover },
      { key: 'export', label: t.export },
      { key: 'import', label: t.import },
      { key: 'balance', label: t.balance },
    ];

    const zeroMsg = {
      turnover: t.noTrade,
      export: t.noExports,
      import: t.noImports,
    };

    function cell(value, prev, isBalance, key, periodData) {
      if (isBalance && periodData.turnover === 0) return { text: '-', alignment: 'center' };
      if (value === 0 && !isBalance && zeroMsg[key]) return { text: zeroMsg[key], alignment: 'center', color: '#94a3b8', fontSize: 8.5 };
      if (isBalance) {
        const sign = value < 0 ? t.negative : t.positive;
        const color = value < 0 ? '#dc2626' : '#16a34a';
        return { text: `${sign} ${formatMln2(Math.abs(value))} ${t.mln}`, alignment: 'center', color };
      }
      const pct = calcChange(value, prev);
      const dir = pct >= 0 ? t.increase : t.decrease;
      const color = pct >= 0 ? '#16a34a' : '#dc2626';
      return {
        text: [
          { text: `${formatMln2(value)} ${t.mln}`, color: '#0f172a' },
          { text: `, ${dir} ${formatPct(pct)}`, color },
        ],
        alignment: 'center',
      };
    }

    const body = [
      [th(''), thCenter(colFull), thCenter(colMonth)],
    ];

    for (const r of rows) {
      const isBalance = r.key === 'balance';
      const fullVal = data.fullYear[r.key];
      const fullPrev = data.fullYear[r.key + 'Prev'];
      const monthVal = data.latestPeriod[r.key];
      const monthPrev = data.latestPeriod[r.key + 'Prev'];
      body.push([
        { text: r.label, bold: true, fontSize: 9 },
        cell(fullVal, fullPrev, isBalance, r.key, data.fullYear),
        cell(monthVal, monthPrev, isBalance, r.key, data.latestPeriod),
      ]);
    }

    return {
      table: {
        dontBreakRows: true,
        widths: ['auto', '*', '*'],
        body,
      },
      layout: tableLayout,
      margin: [0, 14, 0, 8],
    };
  }

  // ── Trade: products table (export/import) ─────────────────────────────
  function buildProductsTable(products, t, periodLabel, year, showReexport, lang) {
    if (!products || products.length === 0) {
      return { text: t.noData, italics: true, color: '#94a3b8', fontSize: 9, margin: [0, 4, 0, 8] };
    }
    const header = [
      th(t.hsProduct),
      thRight(t.volumeHeader),
      thRight(t.changeHeader),
    ];
    if (showReexport) header.push(thRight(t.reexportShareShort));

    const body = [header];
    for (const p of products) {
      const change = p.change;
      const changeColor = change > 0 ? '#16a34a' : (change < 0 ? '#dc2626' : '#475569');
      const changeSign = change > 0 ? '+' : '';
      const row = [
        tdText(lang === 'en' && p.nameEn ? p.nameEn : p.name),
        tdNum(formatMln(p.valueMln)),
        tdNum(`${changeSign}${formatPct(change)}`, { color: changeColor }),
      ];
      if (showReexport) {
        row.push(tdNum(p.reexportShare === 0 ? '-' : formatPct(p.reexportShare)));
      }
      body.push(row);
    }

    const widths = showReexport ? ['*', 80, 62, 80] : ['*', 80, 70];
    return {
      table: {
        dontBreakRows: true,
        widths,
        body,
      },
      layout: tableLayout,
      margin: [0, 0, 0, 6],
    };
  }

  // ── Trade: change table (increase/drop) ────────────────────────────────
  function buildChangeTable(products, t, periodLabel, year, lang) {
    if (!products || products.length === 0) {
      return { text: t.noData, italics: true, color: '#94a3b8', fontSize: 9, margin: [0, 4, 0, 8] };
    }
    const body = [
      [
        th(t.hsProduct),
        thRight(t.volumeHeader),
        thRight(t.changeHeader),
        thRight(t.differenceHeader),
      ],
    ];
    for (const p of products) {
      const changeColor = p.changePct > 0 ? '#16a34a' : '#dc2626';
      const diffColor = p.diffMln > 0 ? '#16a34a' : '#dc2626';
      const changeSign = p.changePct > 0 ? '+' : '';
      const diffSign = p.diffMln > 0 ? '+' : '';
      // No trade in the current period → render "-" instead of "0.00".
      const valueCell = p.valueMln > 0 ? formatMln(p.valueMln) : '-';
      body.push([
        tdText(lang === 'en' && p.nameEn ? p.nameEn : p.name),
        tdNum(valueCell),
        tdNum(`${changeSign}${formatPct(p.changePct)}`, { color: changeColor }),
        tdNum(`${diffSign}${formatMln(Math.abs(p.diffMln))}`, { color: diffColor }),
      ]);
    }
    return {
      table: {
        dontBreakRows: true,
        widths: ['*', 80, 62, 80],
        body,
      },
      layout: tableLayout,
      margin: [0, 0, 0, 6],
    };
  }

  // ── Trade summary paragraphs ───────────────────────────────────────────
  function buildTradeSummary(trade, t, country, lang) {
    const isKa = lang === 'ka';
    const periodGen = isKa ? gePeriodGen(trade.latestYear, trade.latestMonth) : null;
    const periodLoc = isKa ? gePeriodLoc(trade.latestYear, trade.latestMonth) : null;
    const periodEn  = !isKa ? enPeriod(trade.latestYear, trade.latestMonth) : null;
    const rank = trade.ranking && trade.ranking.country ? trade.ranking.country : null;
    // Hide rank-prose when the country sits outside the top 20 — bare
    // ordinals like "47th" don't add value. Volumes still render.
    const TOP_RANK_LIMIT = 20;
    const inTop = (r) => r && r.rank <= TOP_RANK_LIMIT;

    const B = (s) => ({ text: s, bold: true });
    const I = (s) => ({ text: s, italics: true });

    const heading = (ka, en) => ({ text: isKa ? ka : en, bold: true, fontSize: 11, color: '#0f172a', margin: [0, 0, 0, 4] });
    const divider = () => ({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 531, y2: 0, lineWidth: 0.5, lineColor: '#d1d5db' }], margin: [0, 6, 0, 6] });

    function pctInt(x) { return Math.round(Math.abs(x)); }
    function pctOne(x) { return (Math.round(x * 10) / 10).toFixed(1); }

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
        const changeSign = p.change > 0 ? '+' : '';
        const name = isKa ? p.name : (p.nameEn || p.name);
        parts.push(name + ' ');
        parts.push(I(`(${formatMln(p.valueMln)} ${unit}, ${changeSign}${formatPct(p.change)})`));
        parts.push(i < items.length - 1 ? ', ' : '.');
      });
      return parts;
    }

    const paraStyle = { fontSize: 10, lineHeight: 1.3, alignment: 'justify', margin: [0, 0, 0, 4] };
    const nodes = [];

    const curTurn  = trade.overview.latestPeriod.turnover;
    const prevTurn = trade.overview.latestPeriod.turnoverPrev;
    const curExp   = trade.overview.latestPeriod.export;
    const prevExp  = trade.overview.latestPeriod.exportPrev;
    const curImp   = trade.overview.latestPeriod.import;
    const prevImp  = trade.overview.latestPeriod.importPrev;

    // ── Turnover ─────────────────────────────────────────────────────────
    nodes.push(heading('სავაჭრო ბრუნვა', 'Trade Turnover'));
    if (curTurn < 0.01) {
      // Widen the "no trade" period from the latest period alone to the
      // full 5-year + latest window when there's zero trade everywhere.
      const widen = trade.hasAnyTrade === false && trade.fiveYearStart;
      const kaLabel = widen
        ? gePeriodGenRange(trade.fiveYearStart, trade.latestYear, trade.latestMonth)
        : periodGen;
      const enLabel = widen
        ? enPeriodRange(trade.fiveYearStart, trade.latestYear, trade.latestMonth)
        : periodEn;
      nodes.push({ text: isKa
        ? `${kaLabel} მონაცემებით, ვაჭრობა არ განხორციელდა.`
        : `For ${enLabel}, no trade was conducted.`, ...paraStyle });
      return nodes;
    }
    if (isKa) {
      nodes.push({ text: [
        `${periodGen} მონაცემებით, სავაჭრო ბრუნვა, წინა წლის ანალოგიურ პერიოდთან შედარებით, `,
        changeVerbParts(curTurn, prevTurn),
        ` და `, B(`${formatMln(curTurn)} მლნ. აშშ დოლარი`), ` შეადგინა.`,
      ], ...paraStyle });
      if (inTop(rank && rank.turnover)) {
        nodes.push({ text: [
          `${country} აღნიშნულ პერიოდში სავაჭრო ბრუნვის მოცულობის მიხედვით არის `,
          B(`${gePlace(rank.turnover.rank)} ადგილზე`), `, წილი `, B(`${pctOne(rank.turnover.sharePct)}%`), `.`,
        ], ...paraStyle });
      }
    } else {
      nodes.push({ text: [
        `For ${periodEn}, trade turnover `,
        changeVerbParts(curTurn, prevTurn),
        ` compared to the same period last year, amounting to `, B(`${formatMln(curTurn)} mln USD`), `.`,
      ], ...paraStyle });
      if (inTop(rank && rank.turnover)) {
        nodes.push({ text: [
          `${country} ranks `, B(enOrdinal(rank.turnover.rank)),
          ` by trade turnover with a `, B(`${pctOne(rank.turnover.sharePct)}%`), ` share.`,
        ], ...paraStyle });
      }
    }

    // ── Export ────────────────────────────────────────────────────────────
    nodes.push(divider());
    nodes.push(heading('ექსპორტი', 'Export'));
    if (!trade.hasExport || curExp < 0.01) {
      nodes.push({ text: isKa ? `ექსპორტი ${periodLoc} არ განხორციელდა.` : `No exports were conducted in ${periodEn}.`, ...paraStyle, margin: [0, 6, 0, 4] });
    } else {
      if (isKa) {
        nodes.push({ text: [
          `ექსპორტი ${periodLoc} `,
          changeVerbParts(curExp, prevExp),
          ` და `, B(`${formatMln(curExp)} მლნ. აშშ დოლარი`), ` შეადგინა.`,
          ...(inTop(rank && rank.export) ? [
            ` საქართველოსთვის ექსპორტის მიხედვით ${country} არის `,
            B(`${gePlace(rank.export.rank)} ადგილზე`), ` საქართველოს სავაჭრო პარტნიორებს შორის, წილი `, B(`${pctOne(rank.export.sharePct)}%`), `.`,
          ] : []),
        ], ...paraStyle, margin: [0, 6, 0, 4] });
      } else {
        nodes.push({ text: [
          `Exports in ${periodEn} `,
          changeVerbParts(curExp, prevExp),
          `, amounting to `, B(`${formatMln(curExp)} mln USD`), `.`,
          ...(inTop(rank && rank.export) ? [
            ` ${country} ranks `, B(enOrdinal(rank.export.rank)),
            ` by export volume with a `, B(`${pctOne(rank.export.sharePct)}%`), ` share.`,
          ] : []),
        ], ...paraStyle, margin: [0, 6, 0, 4] });
      }

      // Domestic export + re-export
      if (rank && rank.domesticExport && curExp > 0) {
        const domVal = rank.domesticExport.valueMln;
        const domPct = (100 * domVal / curExp).toFixed(0);
        const reVal = rank.reExport ? rank.reExport.valueMln : (curExp - domVal);
        const rePct = (100 * reVal / curExp).toFixed(0);
        const showDomRank = inTop(rank.domesticExport);

        if (isKa) {
          nodes.push({ text: [
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
          ], ...paraStyle });
        } else {
          nodes.push({ text: [
            `In the given period, domestic exports amounted to `,
            B(`${formatMln(domVal)} mln USD`),
            `, comprising `, B(`${domPct}%`), ` of total exports. `,
            ...(showDomRank ? [
              `By domestic exports, ${country} ranks `,
              B(enOrdinal(rank.domesticExport.rank)),
              ` among Georgia's trading partners. `,
            ] : []),
            `Re-exports in the same period amounted to `,
            B(`${formatMln(reVal)} mln USD`), ` `, I(`(${rePct}% share)`), `.`,
          ], ...paraStyle });
        }
      }

      // Product list
      const expParts = productListParts(trade.exportProducts);
      if (expParts.length) {
        nodes.push({ text: [
          B(isKa ? 'ძირითადი საექსპორტო პროდუქცია: ' : 'Main export products: '),
          ...expParts,
        ], ...paraStyle });
      }
    }

    // ── Import ───────────────────────────────────────────────────────────
    nodes.push(divider());
    nodes.push(heading('იმპორტი', 'Import'));
    if (!trade.hasImport || curImp < 0.01) {
      nodes.push({ text: isKa ? `იმპორტი ${periodLoc} არ განხორციელდა.` : `No imports were conducted in ${periodEn}.`, ...paraStyle, margin: [0, 6, 0, 4] });
    } else {
      if (isKa) {
        nodes.push({ text: [
          `იმპორტი ${periodLoc} `,
          changeVerbParts(curImp, prevImp),
          ` და `, B(`${formatMln(curImp)} მლნ. აშშ დოლარი`), ` შეადგინა.`,
          ...(inTop(rank && rank.import) ? [
            ` იმპორტის მიხედვით ${country} არის `,
            B(`${gePlace(rank.import.rank)} ადგილზე`), ` საქართველოს სავაჭრო პარტნიორებს შორის, წილი `, B(`${pctOne(rank.import.sharePct)}%`), `.`,
          ] : []),
        ], ...paraStyle, margin: [0, 6, 0, 4] });
      } else {
        nodes.push({ text: [
          `Imports in ${periodEn} `,
          changeVerbParts(curImp, prevImp),
          `, amounting to `, B(`${formatMln(curImp)} mln USD`), `.`,
          ...(inTop(rank && rank.import) ? [
            ` ${country} ranks `, B(enOrdinal(rank.import.rank)),
            ` by import volume with a `, B(`${pctOne(rank.import.sharePct)}%`), ` share.`,
          ] : []),
        ], ...paraStyle, margin: [0, 6, 0, 4] });
      }

      const impParts = productListParts(trade.importProducts);
      if (impParts.length) {
        nodes.push({ text: [
          B(isKa ? 'ძირითადი საიმპორტო პროდუქცია: ' : 'Main import products: '),
          ...impParts,
        ], ...paraStyle });
      }
    }

    return nodes;
  }

  // ── Trade section ──────────────────────────────────────────────────────
  function buildTradeSection(trade, charts, t, country, lang) {
    if (!trade) return [];

    // Derive the period label in the PDF's language. trade.periodLabel was
    // baked from the page locale at fetch time, which is wrong when the
    // user exports an EN PDF from the KA page (or vice versa).
    const periodLabel = periodShortLabel(trade.latestMonth, lang) || trade.periodLabel;

    const blocks = [];
    const title = `${country} - ${t.tradeOverview}, ${periodLabel} ${trade.latestYear}`;
    const summary = buildTradeSummary(trade, t, country, lang);
    blocks.push(withTitle(
      sectionTitle(title),
      ...summary,
      buildOverviewTable(
        trade.overview,
        { prevYear: trade.prevYear, latestYear: trade.latestYear, periodLabel },
        t, trade.latestMonth, trade.monthNames,
      ),
    ));

    // Charts — turnover + dynamics, stacked full-width so every chart in the
    // document has identical width (500pt) and uniform height (≈150pt).
    if (charts.turnover) {
      blocks.push({
        unbreakable: true,
        stack: [
          { text: t.turnover, style: 'chartCaption' },
          { image: charts.turnover, width: 500, alignment: 'center' },
        ],
        margin: [0, 4, 0, 6],
      });
    }
    if (charts.dynamics) {
      blocks.push({
        unbreakable: true,
        stack: [
          { text: t.dynamics, style: 'chartCaption' },
          {
            columns: [
              { width: 'auto', canvas: [{ type: 'rect', x: 0, y: 3, w: 8, h: 8, color: '#16a34a' }] },
              { width: 'auto', text: t.export, fontSize: 8, margin: [4, 0, 10, 0] },
              { width: 'auto', canvas: [{ type: 'rect', x: 0, y: 3, w: 8, h: 8, color: '#dc2626' }] },
              { width: 'auto', text: t.import, fontSize: 8, margin: [4, 0, 0, 0] },
            ],
            alignment: 'center',
            margin: [0, 0, 0, 2],
          },
          { image: charts.dynamics, width: 500, alignment: 'center' },
        ],
        margin: [0, 0, 0, 8],
      });
    }

    // Export products + changes
    if (trade.hasExport) {
      blocks.push(withTitle(
        subTitle(`${t.mainExport}, ${periodLabel} ${trade.latestYear}`),
        buildProductsTable(trade.exportProducts, t, periodLabel, trade.latestYear, true, lang),
      ));

      const incLabel = trade.exportGrowing ? t.exportIncrease : t.exportDrop;
      const dropLabel = trade.exportGrowing ? t.exportDrop : t.exportIncrease;
      const incProds = trade.exportGrowing ? trade.exportChange.increase : trade.exportChange.drop;
      const dropProds = trade.exportGrowing ? trade.exportChange.drop : trade.exportChange.increase;

      if (incProds && incProds.length) {
        blocks.push(withTitle(
          subTitle(`${incLabel}, ${periodLabel} ${trade.latestYear}`),
          buildChangeTable(incProds, t, periodLabel, trade.latestYear, lang),
        ));
      }
      if (dropProds && dropProds.length) {
        blocks.push(withTitle(
          subTitle(`${dropLabel}, ${periodLabel} ${trade.latestYear}`),
          buildChangeTable(dropProds, t, periodLabel, trade.latestYear, lang),
        ));
      }
    }

    // Import products + changes
    if (trade.hasImport) {
      blocks.push(withTitle(
        subTitle(`${t.mainImport}, ${periodLabel} ${trade.latestYear}`),
        buildProductsTable(trade.importProducts, t, periodLabel, trade.latestYear, false, lang),
      ));

      const incLabel = trade.importGrowing ? t.importIncrease : t.importDrop;
      const dropLabel = trade.importGrowing ? t.importDrop : t.importIncrease;
      const incProds = trade.importGrowing ? trade.importChange.increase : trade.importChange.drop;
      const dropProds = trade.importGrowing ? trade.importChange.drop : trade.importChange.increase;

      if (incProds && incProds.length) {
        blocks.push(withTitle(
          subTitle(`${incLabel}, ${periodLabel} ${trade.latestYear}`),
          buildChangeTable(incProds, t, periodLabel, trade.latestYear, lang),
        ));
      }
      if (dropProds && dropProds.length) {
        blocks.push(withTitle(
          subTitle(`${dropLabel}, ${periodLabel} ${trade.latestYear}`),
          buildChangeTable(dropProds, t, periodLabel, trade.latestYear, lang),
        ));
      }
    }

    return blocks;
  }

  // ── Tourism summary (5-year total + latest-period rank) ─────────────
  function buildTourismSummary(tourism, t, country, lang, grammar) {
    if (!tourism || !tourism.hasData) return [];
    const isKa = lang === 'ka';
    const B = (s) => ({ text: s, bold: true });
    const paraStyle = { fontSize: 10, lineHeight: 1.3, alignment: 'justify', margin: [0, 0, 0, 4] };
    const fmt = (n) => Number(n).toLocaleString();
    // Prefer the Georgian ablative from the grammar sheet ("…იდან"), which
    // handles cases like "ავსტრია → ავსტრიიდან" that naive "+დან" gets wrong.
    const kaFrom = (name) => (grammar && grammar.from) || (name + 'დან');

    function formatPeriodKa(label) {
      const m = /^(\d{4})\s+([IVX]+)\s+კვ$/.exec(label || '');
      if (!m) return label || '';
      return `${m[1]} წლის ${m[2]} კვარტლის`;
    }
    function formatPeriodEn(label) {
      const m = /^(\d{4})\s+([IVX]+)\s+კვ$/.exec(label || '');
      if (!m) return label || '';
      const roman = { I: 1, II: 2, III: 3, IV: 4 };
      return `Q${roman[m[2]] || m[2]} ${m[1]}`;
    }

    const nodes = [];
    if (tourism.fiveYearSum > 0) {
      if (isKa) {
        nodes.push({ text: [
          B(`${tourism.fiveYearStart} - ${tourism.fiveYearEnd}`),
          ` წლებში ${kaFrom(country)} საქართველოში შემოვიდა `,
          B(fmt(tourism.fiveYearSum)), ` ვიზიტორი.`,
        ], ...paraStyle });
      } else {
        nodes.push({ text: [
          `Between `, B(`${tourism.fiveYearStart}-${tourism.fiveYearEnd}`),
          `, `, B(fmt(tourism.fiveYearSum)), ` visitors came to Georgia from ${country}.`,
        ], ...paraStyle });
      }
    }
    if (tourism.currentRank && tourism.currentPeriodLabel) {
      if (isKa) {
        nodes.push({ text: [
          B(formatPeriodKa(tourism.currentPeriodLabel)),
          ` მონაცემებით ვიზიტორების რაოდენობის მიხედვით ${country} არის `,
          B(`${gePlace(tourism.currentRank)} ადგილზე`), `.`,
        ], ...paraStyle });
      } else {
        nodes.push({ text: [
          `By visitor count in `, B(formatPeriodEn(tourism.currentPeriodLabel)),
          `, ${country} ranks `, B(enOrdinal(tourism.currentRank)), `.`,
        ], ...paraStyle });
      }
    }
    return nodes;
  }

  // ── Tourism section ────────────────────────────────────────────────────
  function buildTourismSection(tourism, charts, t, country, lang, grammar) {
    if (!tourism) return [];
    const blocks = [];
    const title = sectionTitle(`${country} - ${t.internationalVisitors}`);

    if (!tourism.hasData) {
      blocks.push(withTitle(
        title,
        { text: t.noTourismData, italics: true, color: '#94a3b8', fontSize: 9, margin: [0, 4, 0, 8] },
      ));
      return blocks;
    }

    const summary = buildTourismSummary(tourism, t, country, lang, grammar);

    const rows = [...(tourism.quarterlyRows || []), ...[...(tourism.annualRows || [])].reverse()];
    const rankHeader = lang === 'ka' ? 'ადგილი' : 'Rank';
    const shareHeader = lang === 'ka' ? 'წილი, %' : 'Share, %';

    // Drop the rank column entirely when no row reaches the top 20.
    const TOP_RANK_LIMIT = 20;
    const showRank = rows.some(r => r.rank && r.rank <= TOP_RANK_LIMIT);

    const headerRow = [th(t.period)];
    if (showRank) headerRow.push(thRight(rankHeader));
    headerRow.push(thRight(t.visitors), thRight(t.changeHeader), thRight(shareHeader));
    const body = [headerRow];
    for (const r of rows) {
      let changeCell;
      if (r.changePct === null || r.changePct === undefined) {
        changeCell = tdNum('-');
      } else {
        const color = r.changePct > 0 ? '#16a34a' : (r.changePct < 0 ? '#dc2626' : '#475569');
        const sign = r.changePct > 0 ? '+' : '';
        changeCell = tdNum(`${sign}${formatPct(r.changePct)}`, { color });
      }
      const rankCell = r.rank ? tdNum(String(r.rank)) : tdNum('-');
      const shareCell = (r.share != null)
        ? tdNum(`${(Math.round(r.share * 10) / 10).toFixed(1)}%`)
        : tdNum('-');
      const row = [tdText(r.label, r.isCurrent ? { bold: true } : {})];
      if (showRank) row.push(rankCell);
      row.push(
        tdNum(r.visitors.toLocaleString()),
        changeCell,
        shareCell,
      );
      body.push(row);
    }

    const tableBlock = {
      table: {
        dontBreakRows: true,
        widths: showRank ? ['*', 'auto', 'auto', 'auto', 'auto'] : ['*', 'auto', 'auto', 'auto'],
        body,
      },
      layout: tableLayout,
      margin: [0, 0, 0, 6],
    };

    if (charts.tourism) {
      blocks.push({
        unbreakable: true,
        stack: [
          title,
          ...summary,
          tableBlock,
          { text: t.internationalVisitors, style: 'chartCaption', margin: [0, 6, 0, 2] },
          { image: charts.tourism, width: 500, alignment: 'center', margin: [0, 0, 0, 8] },
        ],
      });
    } else {
      blocks.push(withTitle(title, ...summary, tableBlock));
    }

    return blocks;
  }

  // ── Investments section ────────────────────────────────────────────────
  // ── Investments summary ─────────────────────────────────────────────
  function buildInvestmentsSummary(inv, t, country, lang, grammar) {
    if (!inv || !inv.hasData) return [];
    const isKa = lang === 'ka';
    const B = (s) => ({ text: s, bold: true });
    const paraStyle = { fontSize: 10, lineHeight: 1.3, alignment: 'justify', margin: [0, 0, 0, 4] };
    const fmt = (n) => (Math.round(Math.abs(n) * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    // Prefer the Georgian ablative from the grammar sheet ("…იდან").
    const kaFrom = (name) => (grammar && grammar.from) || (name + 'დან');
    const countryFrom = isKa ? kaFrom(country) : country;

    const nodes = [];

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
        nodes.push({ text: parts, ...paraStyle });
      } else {
        const parts = [
          `Foreign direct investment from ${country} to Georgia was first made in `,
          B(`${inv.firstYear}`), `. Total FDI amounts to `,
          B(`${fmt(inv.totalSum)} mln USD`), `.`,
        ];
        if (inv.totalRank) {
          parts.push(` ${country} ranks `, B(enOrdinal(inv.totalRank)),
            ` by total FDI volume in Georgia.`);
        }
        nodes.push({ text: parts, ...paraStyle });
      }
    }

    // Sentence 2: last 5 years sum
    if (inv.fiveYearSum > 0) {
      if (isKa) {
        nodes.push({ text: [
          B(`${inv.fiveYearStart} - ${inv.fiveYearEnd}`),
          ` წლებში ${countryFrom} საქართველოში შემოსული ინვესტიციების მოცულობამ შეადგინა `,
          B(`${fmt(inv.fiveYearSum)} მლნ. აშშ დოლარი`), `.`,
        ], ...paraStyle });
      } else {
        nodes.push({ text: [
          `Between `, B(`${inv.fiveYearStart}-${inv.fiveYearEnd}`),
          `, investments from ${country} to Georgia amounted to `,
          B(`${fmt(inv.fiveYearSum)} mln USD`), `.`,
        ], ...paraStyle });
      }
    }

    // Sentence 3/4: latest + previous year
    function yearSentence(year, value, rank) {
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
        return { text: parts, ...paraStyle };
      }
      const parts = [
        `In `, B(`${year}`), `, `, B(`${fmt(value)} mln USD`),
        ` of foreign direct investment came to Georgia from ${country}.`,
      ];
      if (rank) {
        parts.push(` ${country} ranked `, B(enOrdinal(rank)), ` by FDI volume in ${year}.`);
      }
      return { text: parts, ...paraStyle };
    }
    function noInvestmentSentence(year) {
      if (isKa) {
        return { text: [B(`${year} წელს`), ` ${countryFrom} ინვესტიცია არ განხორციელდა.`], ...paraStyle };
      }
      return { text: [`In `, B(`${year}`), `, no investment was conducted from ${country}.`], ...paraStyle };
    }

    if (inv.latestYear) {
      const s3 = yearSentence(inv.latestYear, inv.latestYearValue, inv.latestYearRank);
      nodes.push(s3 || noInvestmentSentence(inv.latestYear));
    }
    if (inv.prevYear) {
      const s4 = yearSentence(inv.prevYear, inv.prevYearValue, inv.prevYearRank);
      nodes.push(s4 || noInvestmentSentence(inv.prevYear));
    }

    return nodes;
  }

  // ── Companies section ──────────────────────────────────────────────────
  function buildCompaniesSection(state, t, country, lang, countryNameEn, grammar) {
    const hasOwn = !!(state && state.hasData && state.counts);
    const combined = state && state.combined;
    if (!hasOwn && !combined) return [];
    const isKa = lang === 'ka';
    const displayCountry = isKa ? (state.countryKa || country) : (state.countryEn || countryNameEn || country);
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
    const paraStyle = { fontSize: 10, lineHeight: 1.3, alignment: 'justify', margin: [0, 0, 0, 4] };
    const liStyle = { fontSize: 10, lineHeight: 1.3, margin: [0, 0, 0, 2] };

    const title = isKa ? 'კომპანიები' : 'Companies';
    const heading = sectionTitle(title);
    const nodes = [];

    if (hasOwn) {
      if (isKa) {
        nodes.push({ text: `${countryOf} კაპიტალის მონაწილეობით დარეგისტრირებული მოქმედი კომპანიები:`, ...paraStyle });
        nodes.push({ text: [B(fmt(c.total)), ` მოქმედი კომპანია ${countryOf} კაპიტალის მონაწილეობით.`], ...paraStyle });
      } else {
        nodes.push({ text: `Active companies with capital originating from ${displayCountry}:`, ...paraStyle });
        nodes.push({ text: [B(fmt(c.total)), ` active companies with capital originating from ${displayCountry}.`], ...paraStyle });
      }
      if (!(state && state.suppressBreakdown)) {
        if (isKa) {
          nodes.push({
            ul: [
              { text: [B(fmt(c.solo)), ` კომპანია - ${countryOf} კაპიტალით შექმნილი;`], ...liStyle },
              { text: [B(fmt(c.withGeorgia)), ` კომპანია - ${displayCountry} - საქართველოს წილობრივი კაპიტალით შექმნილი;`], ...liStyle },
              { text: [B(fmt(c.withGeorgiaAndThird)), ` კომპანია - ${displayCountry}, საქართველოსა და მესამე ქვეყნის კაპიტალით შექმნილი;`], ...liStyle },
              { text: [B(fmt(c.withThirdOnly)), ` კომპანია - ${countryOf} და მესამე ქვეყნების წილობრივი კაპიტალით შექმნილი.`], ...liStyle },
            ],
          });
        } else {
          nodes.push({
            ul: [
              { text: [B(fmt(c.solo)), ` companies - established with capital from only ${displayCountry};`], ...liStyle },
              { text: [B(fmt(c.withGeorgia)), ` companies - established with joint capital from ${displayCountry} and Georgia;`], ...liStyle },
              { text: [B(fmt(c.withGeorgiaAndThird)), ` companies - established with joint capital from ${displayCountry}, Georgia and the third country;`], ...liStyle },
              { text: [B(fmt(c.withThirdOnly)), ` companies - established with joint capital from ${displayCountry} and third countries.`], ...liStyle },
            ],
          });
        }
      }
    }

    if (combined) {
      // Single sentence for the legacy Serbia-Montenegro union — no
      // breakdown bullets.
      const cbOf = isKa ? combined.labelKaOf : combined.labelEn;
      const cbNom = isKa ? combined.labelKa : combined.labelEn;
      if (isKa) {
        nodes.push({ text: [B(fmt(combined.total)), ` მოქმედი კომპანია ${cbOf} კაპიტალის მონაწილეობით.`], ...paraStyle });
      } else {
        nodes.push({ text: [B(fmt(combined.total)), ` active companies with capital originating from ${cbNom}.`], ...paraStyle });
      }
    }

    return [withTitle(heading, ...nodes)];
  }

  function buildInvestmentsSection(inv, charts, t, country, lang, grammar) {
    if (!inv) return [];
    const blocks = [];
    const title = sectionTitle(`${country} - ${t.fdi}`);

    if (!inv.hasData) {
      blocks.push(withTitle(
        title,
        { text: t.noFdiData, italics: true, color: '#94a3b8', fontSize: 9, margin: [0, 4, 0, 8] },
      ));
      return blocks;
    }

    const summary = buildInvestmentsSummary(inv, t, country, lang, grammar);

    const data = [...inv.tableData].reverse();
    const rankHeader = lang === 'ka' ? 'ადგილი' : 'Rank';
    const shareHeader = lang === 'ka' ? 'წილი, %' : 'Share, %';

    // Drop the rank column entirely when no year reaches the top 20.
    const TOP_RANK_LIMIT = 20;
    const showRank = data.some(r => r.valueMln > 0 && r.rank && r.rank <= TOP_RANK_LIMIT);

    const headerRow = [th(t.year)];
    if (showRank) headerRow.push(thRight(rankHeader));
    headerRow.push(thRight(t.volumeHeader), thRight(t.changeHeader), thRight(shareHeader));
    const body = [headerRow];
    for (const r of data) {
      const isCurNeg = !(r.valueMln > 0);
      const isPrevNeg = !(r.prevMln > 0);
      const valueCell = isCurNeg ? tdNum('-') : tdNum(formatMln(r.valueMln));
      let changeCell;
      if (isCurNeg || isPrevNeg) {
        changeCell = tdNum('-');
      } else {
        const pct = ((r.valueMln - r.prevMln) / r.prevMln) * 100;
        const color = pct > 0 ? '#16a34a' : (pct < 0 ? '#dc2626' : '#475569');
        const sign = pct > 0 ? '+' : '';
        changeCell = tdNum(`${sign}${formatPct(pct)}`, { color });
      }
      const rankCell = (!isCurNeg && r.rank) ? tdNum(String(r.rank)) : tdNum('-');
      const shareCell = (!isCurNeg && r.share != null)
        ? tdNum(`${(Math.round(r.share * 10) / 10).toFixed(1)}%`)
        : tdNum('-');
      const row = [tdText(String(r.year))];
      if (showRank) row.push(rankCell);
      row.push(valueCell, changeCell, shareCell);
      body.push(row);
    }

    const tableBlock = {
      table: {
        dontBreakRows: true,
        widths: showRank ? ['auto', 'auto', '*', 'auto', 'auto'] : ['auto', '*', 'auto', 'auto'],
        body,
      },
      layout: tableLayout,
      margin: [0, 0, 0, 6],
    };

    if (charts.fdi) {
      blocks.push({
        unbreakable: true,
        stack: [
          title,
          ...summary,
          tableBlock,
          { text: t.fdiShort, style: 'chartCaption', margin: [0, 6, 0, 2] },
          { image: charts.fdi, width: 500, alignment: 'center', margin: [0, 0, 0, 8] },
        ],
      });
    } else {
      blocks.push(withTitle(title, ...summary, tableBlock));
    }

    // Optional sectors table (only if admin has uploaded the file AND the
    // selected country has a row in it).
    if (inv.sectors) {
      const sectorsBlock = buildFdiSectorsTable(inv.sectors, t, country, lang);
      if (sectorsBlock) blocks.push(sectorsBlock);
    }

    return blocks;
  }

  // ── FDI Sectors table (admin-uploaded; below main FDI block) ────────
  function buildFdiSectorsTable(sectors, t, country, lang) {
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
    function cellColor(v) {
      if (v === null || v === undefined || v === 0) return '#475569';
      return v < 0 ? '#dc2626' : '#0f172a';
    }

    const body = [];
    body.push([th(sectorHeader), ...years.map(y => thRight(String(y)))]);

    // Totals row (bold)
    const totalCells = [{ text: totalLabel, bold: true, fontSize: 8, color: '#0f172a', fillColor: '#f1f5f9' }];
    for (const y of years) {
      const v = data.totals ? data.totals[y] : null;
      totalCells.push({ text: fmt(v), alignment: 'right', bold: true, fontSize: 9, color: cellColor(v), fillColor: '#f1f5f9' });
    }
    body.push(totalCells);

    // Sector rows — sort by most-recent-period value, highest to lowest
    const sectorNames = Object.keys(data.sectors || {});
    const sortYear = years[years.length - 1];
    sectorNames.sort((a, b) => {
      const va = (data.sectors[a] && data.sectors[a][sortYear]) || 0;
      const vb = (data.sectors[b] && data.sectors[b][sortYear]) || 0;
      return vb - va;
    });
    const nameMap = sectors.sectorNameMap || {};
    for (const sector of sectorNames) {
      const displayName = isKa ? sector : (nameMap[sector] || sector);
      const row = [{ text: displayName, fontSize: 8 }];
      const vals = data.sectors[sector] || {};
      for (const y of years) {
        const v = vals[y];
        row.push({ text: fmt(v), alignment: 'right', fontSize: 9, color: cellColor(v) });
      }
      body.push(row);
    }

    const yearColWidth = years.length >= 6 ? 48 : years.length >= 5 ? 55 : 65;
    const widths = ['*', ...years.map(() => yearColWidth)];

    return {
      stack: [
        { text: titleText, fontSize: 11, bold: true, color: '#0f172a', margin: [0, 12, 0, 2] },
        { text: subtitleText, fontSize: 8.5, color: '#64748b', margin: [0, 0, 0, 4] },
        { table: { dontBreakRows: true, widths, body }, layout: tableLayout },
      ],
    };
  }

  // ── Appendix section ───────────────────────────────────────────────────
  // Multi-year trade matrix. One row per metric × one column per period.
  // Starts on a fresh page because the 9-column table is too wide to share
  // a page with other content.
  function buildAppendixSection(appendix, t, country, lang) {
    if (!appendix || !Array.isArray(appendix.columns) || !appendix.columns.length) return [];
    const hasAny = (appendix.data || []).some((d) => d && d.totals);
    if (!hasAny) return [];

    const cols = appendix.columns;
    const N = cols.length;

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

    const fontSmall = 7;
    const fontHdr = 7.5;

    // First 3 characters of the country name — forms labels like
    // "Turnover-TUR" / "ბრუნვა-თურ" for the country-value rows.
    const countryAbbr = (country || '').slice(0, 3);

    // Empty cells render "-" right-aligned (matches the data cells) so the
    // dash sits flush with the numeric column rather than centred.
    function dashCell(opts = {}) {
      return { text: '-', alignment: 'right', fontSize: fontSmall, ...opts };
    }
    function numCell(v, opts = {}) {
      if (v == null || !isFinite(v)) return dashCell(opts);
      return { text: formatMln2(v), alignment: 'right', fontSize: fontSmall, ...opts };
    }
    function pctCellColored(v, signed) {
      if (v == null || !isFinite(v)) return dashCell();
      const color = v > 0 ? '#16a34a' : (v < 0 ? '#dc2626' : '#475569');
      const sign = signed && v > 0 ? '+' : '';
      return { text: `${sign}${formatPct(v)}`, alignment: 'right', fontSize: fontSmall, color };
    }
    function pctCellPlain(v) {
      if (v == null || !isFinite(v)) return dashCell();
      return { text: formatPct(v), alignment: 'right', fontSize: fontSmall };
    }
    function labelCell(text, opts = {}) {
      return { text, fontSize: fontSmall, color: '#475569', ...opts };
    }
    function hdrCell(text, opts = {}) {
      return {
        text,
        bold: true,
        fontSize: fontHdr,
        color: '#475569',
        fillColor: '#f8fafc',
        alignment: 'right',
        ...opts,
      };
    }
    // Totals row doubles as group header — carries the group name in the
    // first column and Georgia's grand totals in the period columns.
    const groupOpts = { bold: true, fillColor: '#f1f5f9', color: '#1f2937', fontSize: fontHdr };

    const header = [hdrCell('', { alignment: 'left' })]
      .concat(cols.map((c) => hdrCell(c.label)));

    function flowRows(grpLabel, flow) {
      const totals = cols.map((_, i) => numCell(getTotal(i, flow), groupOpts));
      const values = cols.map((_, i) => numCell(getCountry(i, flow)));
      const changes = cols.map((_, i) => {
        if (!canCompareChange(i)) return dashCell();
        const cur = getCountry(i, flow);
        const prev = getCountry(i - 1, flow);
        if (cur == null || prev == null || prev === 0) return dashCell();
        return pctCellColored(((cur - prev) / prev) * 100, true);
      });
      const shares = cols.map((_, i) => {
        const cur = getCountry(i, flow);
        const tot = getTotal(i, flow);
        if (cur == null || !tot) return dashCell();
        return pctCellPlain((cur / tot) * 100);
      });
      return [
        [{ text: grpLabel, ...groupOpts }].concat(totals),
        [labelCell(`${grpLabel}-${countryAbbr}`)].concat(values),
        [labelCell(t.appChange)].concat(changes),
        [labelCell(t.appShare)].concat(shares),
      ];
    }

    const balanceCells = cols.map((_, i) => {
      const c = appendix.data[i] && appendix.data[i].country;
      if (!c) return { ...dashCell(), ...groupOpts };
      const bal = (c.export || 0) - (c.import || 0);
      const color = bal > 0 ? '#16a34a' : (bal < 0 ? '#dc2626' : '#1f2937');
      const sign = bal < 0 ? '-' : '';
      return { text: `${sign}${formatMln2(Math.abs(bal))}`, alignment: 'right', ...groupOpts, color };
    });

    const body = [header]
      .concat(flowRows(t.appTurnoverGrp, 'turnover'))
      .concat(flowRows(t.appExportGrp, 'export'))
      .concat(flowRows(t.appImportGrp, 'import'))
      .concat([[{ text: t.appBalanceGrp, ...groupOpts }].concat(balanceCells)]);

    // Keep the appendix on A4 portrait (pdfmake's per-page orientation is
    // flaky across versions). Fit the 7- or 8-column matrix within the
    // 531 pt content width by using tight cell padding and explicit
    // widths that are guaranteed to sum below the limit.
    const appendixLayout = {
      ...tableLayout,
      paddingLeft: () => 3,
      paddingRight: () => 3,
    };

    const CONTENT_W = 531;
    const PADDING_PER_CELL = 6; // 3pt × 2
    const labelW = 64;
    const available = CONTENT_W - labelW - (N + 1) * PADDING_PER_CELL;
    const numW = Math.floor(available / N);
    const widths = [labelW].concat(new Array(N).fill(numW));

    const titleText = `${country} - ${t.appendixSection}`;
    const title = { ...sectionTitle(titleText), pageBreak: 'before' };

    return [
      title,
      {
        table: { dontBreakRows: true, widths, body },
        layout: appendixLayout,
        margin: [0, 4, 0, 6],
      },
    ];
  }

  // ── Document definition ────────────────────────────────────────────────
  function buildDocDefinition(state, opts) {
    const lang = opts.lang || 'en';
    const t = T[lang] || T.en;
    const country = lang === 'en' && opts.countryNameEn ? opts.countryNameEn : (opts.country || '');
    const dateStr = formatDate(lang);
    const charts = opts.charts || {};

    const content = [];
    content.push(...buildTradeSection(state.trade, charts, t, country, lang));
    content.push(...buildTourismSection(state.tourism, charts, t, country, lang, state.countryGrammar));
    const investmentsWithSectors = state.investments
      ? { ...state.investments, sectors: state.investmentsSectors || null }
      : state.investments;
    content.push(...buildInvestmentsSection(investmentsWithSectors, charts, t, country, lang, state.countryGrammar));
    content.push(...buildCompaniesSection(state.companies, t, country, lang, opts.countryNameEn, state.countryGrammar));
    content.push(...buildAppendixSection(state.appendix, t, country, lang));

    if (content.length === 0) {
      content.push({ text: t.noData, italics: true, color: '#94a3b8', margin: [0, 40, 0, 0], alignment: 'center' });
    }

    return {
      pageSize: 'A4',
      pageOrientation: 'portrait',
      pageMargins: [32, 46, 32, 40],
      defaultStyle: {
        font: 'Arial',
        fontSize: 9.5,
        lineHeight: 1.25,
        color: '#1f2937',
      },
      styles: {
        sectionTitle: { fontSize: 13, bold: true, color: '#0f172a', margin: [0, 10, 0, 6] },
        subTitle: { fontSize: 10.5, bold: true, color: '#1f2937', margin: [0, 8, 0, 4] },
        chartCaption: { fontSize: 9.5, bold: true, alignment: 'left', color: '#1f2937', margin: [0, 0, 0, 4] },
      },
      // Orphan prevention for titles is handled structurally via
      // `withTitle(...)` wrappers in the section builders — each title
      // sits inside an `unbreakable: true` stack alongside its first
      // content block, so pdfmake moves them as one unit if the current
      // page can't fit them.
      // pdfmake calls header/footer per-page after createPdf, so the
      // applyScriptFonts walker can't reach the returned content. Inline
      // splitText here so Georgian text in the country name and the
      // "{generated}: …" / "{page} N {of} M" labels routes to Sylfaen.
      header: function (currentPage) {
        return {
          columns: [
            { text: splitText(country), fontSize: 8.5, color: '#94a3b8', margin: [32, 18, 0, 0] },
            { text: splitText(`${t.generated}: ${dateStr}`), fontSize: 8.5, color: '#94a3b8', alignment: 'right', margin: [0, 18, 32, 0] },
          ],
        };
      },
      footer: function (currentPage, pageCount) {
        return {
          text: splitText(`${t.page} ${currentPage} ${t.of} ${pageCount}`),
          alignment: 'center',
          fontSize: 8,
          color: '#94a3b8',
          margin: [0, 14, 0, 0],
        };
      },
      content,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────
  async function build(state, opts) {
    if (typeof pdfMake === 'undefined') {
      throw new Error('pdfmake library not loaded');
    }
    await ensureFonts();
    const docDef = buildDocDefinition(state, opts);
    applyScriptFonts(docDef);
    const safeCountry = (opts.country || 'report').replace(/[^a-zA-Z0-9\u10A0-\u10FF]/g, '_');
    const filename = `${safeCountry}_statistics_${opts.lang}.pdf`;
    pdfMake.createPdf(docDef).download(filename);
  }

  window.StatisticsPdf = { build };
})();
