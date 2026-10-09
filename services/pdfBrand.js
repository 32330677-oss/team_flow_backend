// services/pdfBrand.js
//
// One colour palette for EVERY PDF the system generates, taken from the
// company logo (assets/logo.png): gold #CBAB5A and charcoal #4B4A4D, plus
// their tints and neutral greys. Status colours (paid, warning, absent, ...)
// are expressed with the same family: emphasis = charcoal / bold, accent = gold.
// Excel exports and the app keep their own colours (PDF only).

const BRAND = {
  // logo gold
  gold: '#CBAB5A',
  goldDark: '#8A6A1F', // readable gold for text on white
  goldMid: '#E3CF9C',
  goldLight: '#F4ECD6',
  goldPale: '#FBF8EF',
  // logo charcoal
  charcoal: '#4B4A4D',
  charcoal2: '#5E5D61',
  charcoalDark: '#2F2E31',
  ink: '#2B2A2E',
  muted: '#6E6D72',
  white: '#FFFFFF',
  // neutrals
  grey: '#F1F1F2',
  greyMid: '#E2E1E3',
  grid: '#D6D4D0',
  zebra: '#FAFAFA',
  friday: '#EDECEE',
};

// Day / status cells: { fill, font } — logo colours only.
const BRAND_TONES = {
  ot: { fill: BRAND.goldLight, font: BRAND.goldDark, bold: true },
  A: { fill: BRAND.charcoal, font: BRAND.white, bold: true },          // absent (unpaid)
  'A*': { fill: BRAND.goldMid, font: BRAND.charcoalDark, bold: true }, // absent paid by management
  S: { fill: BRAND.greyMid, font: BRAND.charcoalDark, bold: true },    // sick
  V: { fill: BRAND.goldPale, font: BRAND.goldDark, bold: true },       // vacation
  H: { fill: BRAND.goldLight, font: BRAND.charcoalDark, bold: true },  // holiday
};

module.exports = { BRAND, BRAND_TONES };
