// services/dpr/dprUccLayout.js
//
// What the client's form (UCC-IMS-CM-3003A) contains, and what the QC may switch
// on / off: whole sections, tables inside them, columns inside the tables, the
// titles, empty rows. Layout = defaults <- contract default <- the day's layout.
// Nothing is hard coded for a contract: every text below is only the default.
'use strict';

const C = require('./dprCommon');

/** Sections in printing order, with their tables and columns. */
const SECTIONS = [
  { key: 'cover', label: 'Cover & fixed pages (maps, sections)', title: '' },
  { key: 'project', label: 'Project information', title: 'PROJECT DAILY REPORT' },
  { key: 'weather', label: 'Weather', title: 'WEATHER' },
  {
    key: 'manpower', label: 'Manpower (staff | tradesmen)',
    title: 'PROJECT WIZE - MANPOWER & MACHINERY [LIST THE POSITION AND NO. DEPLOYED AT SITE]',
    tables: [
      { key: 'staff', label: 'Staff', title: 'STAFF', columns: [['total', 'TOTAL'], ['present', 'PRESENT'], ['absent', 'ABSENT']] },
      { key: 'trades', label: 'Tradesmen', title: 'TRADESMEN', columns: [['total', 'TOTAL'], ['present', 'PRESENT'], ['absent', 'ABSENT']] },
    ],
  },
  {
    key: 'plant', label: 'Plant | tools', title: '',
    tables: [
      { key: 'plant', label: 'Plant', title: 'PLANT', columns: [['operative', 'OPERATIVE'], ['breakdown', 'BREAKDOWN'], ['idle', 'IDLE']] },
      { key: 'tools', label: 'Tools', title: 'TOOL', columns: [['operative', 'OPERATIVE'], ['breakdown', 'BREAKDOWN'], ['idle', 'IDLE']] },
    ],
  },
  {
    key: 'boq', label: 'Overall progress (BOQ)', title: 'PROJECT - OVERALL PROGRESS',
    tables: [
      {
        key: 'boq', label: 'BOQ', title: '',
        columns: [['task_code', 'Task Code'], ['cost_code', 'Cost Code'], ['description', 'Description'], ['unit', 'Unit'],
          ['qty', 'Quantity'], ['budget', 'BUDGET'], ['curr', 'CURR'], ['cum', 'CUMUL'], ['balance', 'BALANCE']],
      },
    ],
  },
  {
    key: 'activities', label: 'Activities of the day', title: 'ACTIVITIES',
    tables: [
      {
        key: 'activities', label: 'Activities', title: '',
        columns: [['no', 'No.'], ['description', 'Description'], ['location', 'Location'], ['boq', 'BOQ'], ['qty', 'Qty'], ['unit', 'Unit'], ['area', 'Area'], ['chainage', 'Chainage']],
      },
    ],
  },
  {
    key: 'areas', label: 'Area / bridge pages', title: '{area} - DAILY PROGRESS',
    tables: [
      {
        key: 'area', label: 'Area table', title: '',
        columns: [['item', 'Bill Item'], ['activity', 'ACTIVITY'], ['chainage', 'CHAINAGE'], ['plant', 'PLANT'], ['plant_no', 'No.'], ['plant_hrs', 'W-HRS'],
          ['trade', 'TRADESMEN'], ['trade_no', 'No.'], ['trade_hrs', 'W-HRS'], ['unit', 'UNIT'], ['output', 'OUTPUT']],
      },
    ],
  },
  {
    key: 'materials', label: 'Delivered materials', title: 'DELIVERED MATERIALS AT SITE',
    tables: [
      {
        key: 'materials', label: 'Materials', title: '',
        columns: [['no', 'Sr. No.'], ['description', 'Material Description / Specification / Grade'], ['unit', 'Unit'], ['qty', 'Qty Delivered'],
          ['supplier', 'Supplier'], ['delivery_note', 'Delivery Note No.'], ['mar_ref', 'MAR Ref.'], ['area', 'Bridge No.'], ['element', 'Element'],
          ['boq_ref', 'BOQ Ref.'], ['intended_use', 'Intended Use']],
      },
    ],
  },
  {
    key: 'wir', label: 'WIR register', title: 'WORK INSPECTION REQUEST (WIR) REGISTER',
    tables: [
      {
        key: 'wir', label: 'WIR', title: '',
        columns: [['no', 'Sr. No.'], ['ref', 'WIR Ref.'], ['activity', 'Activity / Work Description'], ['area', 'Bridge No.'],
          ['location', 'Location / Chainage'], ['ms_ref', 'MS Ref.'], ['status', 'Status'], ['comments', 'Comments']],
      },
    ],
  },
  { key: 'hse', label: 'Health, safety & environment', title: 'HEALTH, SAFETY & ENVIRONMENT' },
  { key: 'plan', label: 'Planned activities – next working day', title: 'PLANNED ACTIVITIES – NEXT WORKING DAY' },
  { key: 'ncr', label: 'NCRs open on the day (register)', title: 'NON-CONFORMANCE REPORTS – OPEN AS OF REPORT DATE' },
  { key: 'concerns', label: 'Areas of concern open on the day (register)', title: 'AREAS OF CONCERN / DELAYS / CONSTRAINTS – OPEN AS OF REPORT DATE' },
  { key: 'notes', label: 'General remarks', title: 'REMARKS', default: false },
  { key: 'photos', label: 'Photos', title: '{code} ACTIVITIES PHOTO:' },
  { key: 'signatures', label: 'Signatures (prepared / reviewed / consultant)', title: 'SIGNATURES' },
];

/** Columns the client's form does not print (the QC can switch them on). */
const OFF_BY_DEFAULT = ['activities.boq', 'activities.qty', 'activities.unit', 'activities.area', 'activities.chainage'];
/** Registers printed only when they have entries (switch "empty rows" on to print the empty grid). */
const EMPTY_HIDDEN_BY_DEFAULT = ['materials', 'wir'];

const ALL_TABLES = SECTIONS.flatMap((s) => (s.tables || []).map((t) => ({ ...t, section: s.key })));

/** The default layout (everything printed like the client's form). */
function defaults() {
  const sections = {};
  const tables = {};
  const columns = {};
  const titles = {};
  const hideEmpty = {};
  for (const s of SECTIONS) {
    sections[s.key] = s.default !== false;
    titles[s.key] = s.title;
    for (const t of s.tables || []) {
      tables[t.key] = true;
      hideEmpty[t.key] = EMPTY_HIDDEN_BY_DEFAULT.includes(t.key);
      if (t.title) titles[`table.${t.key}`] = t.title;
      for (const [c, label] of t.columns) {
        columns[`${t.key}.${c}`] = !OFF_BY_DEFAULT.includes(`${t.key}.${c}`);
        titles[`col.${t.key}.${c}`] = label;
      }
    }
  }
  return { sections, tables, columns, titles, hide_empty: hideEmpty, photos_per_page: 1, photo_captions: true };
}

/** Keeps only known keys with the right types (a layout from a screen or the database). */
function clean(raw) {
  const r = C.json(raw);
  if (!r || typeof r !== 'object') return {};
  const d = defaults();
  const out = {};
  for (const part of ['sections', 'tables', 'columns', 'hide_empty']) {
    if (r[part] && typeof r[part] === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(r[part])) if (k in d[part]) o[k] = C.bool(v, d[part][k]);
      if (Object.keys(o).length) out[part] = o;
    }
  }
  if (r.titles && typeof r.titles === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(r.titles)) {
      if (k in d.titles) o[k] = String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 200);
    }
    if (Object.keys(o).length) out.titles = o;
  }
  if (r.photos_per_page !== undefined) {
    const n = Number(r.photos_per_page);
    if ([1, 2, 4, 6].includes(n)) out.photos_per_page = n;
  }
  if (r.photo_captions !== undefined) out.photo_captions = C.bool(r.photo_captions, true);
  return out;
}

/** defaults <- contract <- day. */
function effective(contractLayout, dayLayout) {
  const out = defaults();
  for (const layer of [clean(contractLayout), clean(dayLayout)]) {
    for (const part of ['sections', 'tables', 'columns', 'titles', 'hide_empty']) {
      if (layer[part]) Object.assign(out[part], layer[part]);
    }
    if (layer.photos_per_page) out.photos_per_page = layer.photos_per_page;
    if (layer.photo_captions !== undefined) out.photo_captions = layer.photo_captions;
  }
  return out;
}

/** Sections whose day data may follow another contract (71 <-> 26). */
const LINKABLE = ['weather', 'manpower', 'plant', 'materials', 'wir', 'notes'];

/** Choice lists (each contract may change them in Setup). */
const LIST_DEFAULTS = {
  weather_conditions: ['SUNNY', 'CLOUDY', 'RAINY', 'DUSTY'],
  humidity_levels: ['HIGH', 'MEDIUM', 'LOW'],
  wir_status: ['Submitted', 'Approved', 'Approved with Comments', 'Rejected', 'Pending'],
  units: ['M', 'M2', 'M3', 'LM', 'No', 'Nr', 'TON', 'KG', 'ITEM', 'LS'],
};
function lists(raw) {
  const r = C.json(raw) || {};
  const out = {};
  for (const [k, def] of Object.entries(LIST_DEFAULTS)) {
    const v = Array.isArray(r[k]) ? r[k].map((x) => String(x ?? '').trim().slice(0, 60)).filter(Boolean).slice(0, 50) : null;
    out[k] = v && v.length ? v : def;
  }
  return out;
}

/** Texts of the form header (all editable in Setup). */
const FORM_DEFAULTS = {
  doc_ref: 'UCC-IMS-CM-3003A',
  system_title: 'Integrated Management System',
  department: 'Construction Management',
  form_title: 'PROJECT DAILY REPORT',
  rev_no: '03',
  rev_date: '',
  project_ref: '',
  contract_ref: '',
  project_manager: '',
  report_title: 'Daily Report – Agreement {code}',
  footer_note: '',
};
function form(raw) {
  const r = C.json(raw) || {};
  const out = {};
  for (const [k, def] of Object.entries(FORM_DEFAULTS)) {
    out[k] = r[k] === undefined || r[k] === null ? def : String(r[k]).replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').trim().slice(0, k === 'footer_note' ? 600 : 200);
  }
  return out;
}

/** Lists of the client's form, loaded into a contract with one button (then free to change). */
const UCC_DEFAULT_LINES = {
  staff: ['PROJECT DIRECTOR', 'OPERATION MANAGER', 'HSE MANAGER', 'PLANNING ENGINEER', 'Senior SITE ENGINEER', 'TECHNICAL ENGINEER',
    'QA/QC ENGINEER', 'SITE ENGINEER', 'SURVEYING ENGINEER', 'PROCUREMENT OFFICER', 'LOGISTIC OFFICER', 'HSE OFFICER', 'SUPERVISOR', 'TIME KEEPER'],
  trade: ['FOREMAN', 'CHARGE HAND', 'CARPENTER', 'MASON', 'STEEL FIXER', 'FABRICATOR', 'WELDER', 'PAINTER', 'SKILLED LABOR',
    'UN-SKILLED LABOR', 'PICKUP DRIVER', 'BUS DRIVER', 'VEHICLE DRIVER'],
  plant: ['MANLIFT', 'WHEEL LOADER', 'TRUCK', 'ROAD ROLLER', 'EXCAVATOR', 'BACKHOE LOADER', 'BOOM TRUCK', 'STEER SKID LOADER',
    'MINI-ROAD ROLLER', 'MINI-EXCAVATOR', 'LOWBED', 'WATER TANKER', 'TRANSIT MIXER', 'SAND BLAST MACHINE', 'PUMP TRUCK', 'GENERATOR',
    'PICKUP 1 TON', 'PICKUP 2 TON', 'MINI-VAN', 'TELEHANDLER', 'GRADER', 'CRANE', 'BOBCAT', 'ASPHALT MACHINE'],
  tool: ['GRINDER', 'POWER DRILL', 'JACK HAMMER', 'CONCRETE VIBRATOR', 'POWER FLOATER', 'WOOD SAW', 'HAND SHOVEL', 'PICKAXES',
    'WHEELBARROW', 'HAMMER', 'SPIRIT LEVEL', 'HAND TROWEL', 'PLATE COMPACTOR', 'WATER HOSE', 'PAINT BRUSH/ROLLER', 'BROOM', 'HAND CUTTER'],
};

module.exports = { SECTIONS, ALL_TABLES, defaults, clean, effective, LINKABLE, LIST_DEFAULTS, lists, FORM_DEFAULTS, form, UCC_DEFAULT_LINES };
