/**
 * HS edition concordance at the 4-digit level.
 *
 * Comtrade serves each reporter-year in the edition the country reported
 * (HS2017 for most 2020-2021 datasets, HS2022 from 2022) and does not
 * convert older years to HS2022 on request (checked 2026-10-08). At four
 * digits the editions differ in only a handful of headings, so rows from
 * older editions are mapped onto their HS2022 heading before aggregation.
 * Headings new in HS2022 (3827, 8485, 8524, 8549, 8806) have no 4-digit
 * ancestor and simply start in 2022; they are listed so the run summary
 * can flag them.
 */
'use strict';

// edition -> { oldHeading: hs2022Heading }
const TO_HS2022 = {
  H5: { 8803: '8807', 8107: '8112', 2848: '2853' },                   // HS2017 -> HS2022
  H4: { 8803: '8807', 8107: '8112', 2848: '2853', 6908: '6907', 8469: '8472' }, // HS2012 -> HS2022
  H3: { 8803: '8807', 8107: '8112', 2848: '2853', 6908: '6907', 8469: '8472' }, // HS2007 -> HS2022
  H2: { 8803: '8807', 8107: '8112', 2848: '2853', 6908: '6907', 8469: '8472', 8485: '8487' },
};

const NEW_IN_HS2022 = ['3827', '8485', '8524', '8549', '8806'];

function toHs2022(cmdCode, classificationCode) {
  const map = TO_HS2022[classificationCode];
  const code = String(cmdCode).padStart(4, '0');
  return (map && map[Number(code)]) || code;
}

module.exports = { toHs2022, NEW_IN_HS2022, TO_HS2022 };
