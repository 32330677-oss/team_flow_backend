// services/projectDailyReportDefaults.js
//
// Row lists and texts of the client's PROJECT DAILY REPORT form
// (UCC-IMS-CM-3003A, rev. 03). Labels are kept EXACTLY as printed on the form,
// spelling included, so the generated Word file matches the paper form.
// A new report profile starts from these lists; the Admin can change them per profile.

const STAFF_ROWS = [
  'PROJECT DIRECTOR', 'OPERATION MANAGER', 'HSE MANAGER', 'PLANNING ENGINEER', 'Senior SITE  ENGINEER',
  'TECHNICAL ENGINEER', 'QA/QC ENGINEER', 'SITE ENGINEER', 'SURVEYING ENGINEER', 'PROCUREMENT OFFICER',
  'LOGISTIC OFFICER', 'HSE OFFICER', 'SUPERVISOR', 'TIME KEEPER',
];

const TRADE_ROWS = [
  'FOREMAN', 'CHARGE HAND', 'CARPENTER', 'MASON', 'STEEL FIXER', 'FABRICATOR', 'WELDER', 'PAINTER',
  'SKILLED LABOR', 'UN-SKILLED LABOR', 'PICKUP DRIVER', 'BUS DRIVER', 'VEHICLE DRIVER',
];

const PLANT_ROWS = [
  'MANLIFT', 'WHEEL LOADER', 'TRUCK', 'ROAD ROLLER', 'EXCAVATOR', 'BACKHOE LOADER', 'BOOM TRUCK',
  'STEER SKID LOADER', 'MINI-ROAD ROLLER', 'MINI-EXCAVATOR', 'LOWBED', 'WATER TANKER', 'TRANSIT MIXER',
  'SAND BLAST MACHINE', 'PUMP TRUCK', 'GENERATOR', 'PICKUP 1 TON', 'PICKUP 2 TON', 'MINI-VAN',
  'TELEHANDLER', 'GRADER', 'CRANE', 'BOBCAT', 'Asphalt Machine',
];

/** Minimum number of lines in the staff / tradesmen block (the form has 17). */
const MANPOWER_MIN_LINES = 17;

/**
 * Common names found in the two systems -> form row. Matching is case- and
 * space-insensitive; the Admin adds more per profile ("position_map").
 * Keys are normalised with normKey().
 */
const DEFAULT_ALIASES = {
  // staff positions
  'project manager': 'PROJECT DIRECTOR',
  'operations manager': 'OPERATION MANAGER',
  'senior site engineer': 'Senior SITE  ENGINEER',
  'qa qc engineer': 'QA/QC ENGINEER',
  'qaqc engineer': 'QA/QC ENGINEER',
  'surveyor': 'SURVEYING ENGINEER',
  'survey engineer': 'SURVEYING ENGINEER',
  'safety officer': 'HSE OFFICER',
  'timekeeper': 'TIME KEEPER',
  'مهندس موقع': 'SITE ENGINEER',
  'مهندس مساحة': 'SURVEYING ENGINEER',
  'مشرف': 'SUPERVISOR',
  'مراقب دوام': 'TIME KEEPER',
  // trades
  'labor': 'UN-SKILLED LABOR',
  'labour': 'UN-SKILLED LABOR',
  'labourer': 'UN-SKILLED LABOR',
  'laborer': 'UN-SKILLED LABOR',
  'helper': 'UN-SKILLED LABOR',
  'unskilled labor': 'UN-SKILLED LABOR',
  'عامل': 'UN-SKILLED LABOR',
  'عامل عادي': 'UN-SKILLED LABOR',
  'skilled labour': 'SKILLED LABOR',
  'steel fixer': 'STEEL FIXER',
  'حداد': 'STEEL FIXER',
  'نجار': 'CARPENTER',
  'معلم': 'FOREMAN',
  'رئيس ورشة': 'FOREMAN',
  'driver': 'VEHICLE DRIVER',
  'سائق': 'VEHICLE DRIVER',
  'لحام': 'WELDER',
  'دهان': 'PAINTER',
  'بناء': 'MASON',
  // equipment types (Equipment Flow seed names)
  'wheel loader': 'WHEEL LOADER',
  'dump truck': 'TRUCK',
  'roller': 'ROAD ROLLER',
  'backhoe loader': 'BACKHOE LOADER',
  'mobile crane': 'CRANE',
  'tower crane': 'CRANE',
  'concrete pump': 'PUMP TRUCK',
  'water tanker': 'WATER TANKER',
  'mini excavator': 'MINI-EXCAVATOR',
  'skid steer loader': 'STEER SKID LOADER',
  'skid steer': 'STEER SKID LOADER',
  'bob cat': 'BOBCAT',
  'asphalt paver': 'Asphalt Machine',
  'forklift': 'TELEHANDLER',
};

const DEFAULT_HEADER = {
  doc_ref: 'UCC-IMS-CM-3003A',
  rev_no: '03',
  rev_date: '2026-03-18',
  page_numbers: true,
};

const DEFAULT_INFO = {
  project_ref: '[UCC PROJECT REF NO.]',
  contract_ref: '[SIGNED CONTRACT REF.]',
  project_name: '',
  project_location: '',
  client: '',
  consultant: '',
  commencement_date: '',
  completion_date: '',
  agreement_title: '',
};

// BOQ of "Agreement 71" (T2 Underground), as on the client's form. Used as the
// starting BOQ of a new profile; quantities to date (CURR) are left empty.
const SCOPE_TAIL = 'Supply, installation, testing, and commissioning of pipes, as well as fittings, sleeves, supports, and any mechanical works, are strictly excluded from our scope and shall';
const AGREEMENT_71_BOQ = [
  { type: 'line' },
  { type: 'line', description: 'ORIGINAL CONTRACT VALUE (A)', bold: true, fill: 'green' },
  { type: 'line', description: 'Section 334000 "STORM WATER  UTILITIES"', bold: true, fill: 'green' },
  {
    type: 'line', unit: 'ITEM', quantity: '1.00',
    description: 'Civil works only for underground pipelines (HDPE storm water pipes / sewer pipes and reinforced concrete pipes).The scope shall include, but not be limited to, excavation, backfilling, supply of suitable fill materials, compaction, reinforced concrete works, steel reinforcement works, and all civil works related to manhole appurtenances only, all in accordance with the approved drawings, specifications, and applicable codes of practice.\nSupply, installation, testing, and commissioning of pipes, as well as any mechanical works, are strictly excluded from our scope and shall\nbe by others.',
  },
  { type: 'line', task_code: '1', description: 'Storm water pipes 630 mm dia.,', unit: 'M', quantity: '43.00' },
  { type: 'line', task_code: '2', description: 'Storm water pipes 500 mm dia.,', unit: 'M', quantity: '43.00' },
  { type: 'line', task_code: '3', description: 'Storm water pipes 400 mm dia.,', unit: 'M', quantity: '1,126.00' },
  { type: 'line', task_code: '4', description: 'Storm water pipes 200 mm dia.,', unit: 'M', quantity: '30.00' },
  { type: 'line', task_code: '5', description: 'Storm Water Curbs Inlet', unit: 'NO', quantity: '5.00' },
  { type: 'line', task_code: '6', description: 'Storm Water Manhole 0.9x0.9 m2', unit: 'NO', quantity: '5.00' },
  { type: 'line', task_code: '7', description: 'Storm Water Manhole 1.2x1.2 m2', unit: 'NO', quantity: '42.00' },
  { type: 'line', task_code: '8', description: 'Storm Water Manhole 1.2x1.8 m2', unit: 'NO', quantity: '1.00' },
  { type: 'line', task_code: '9', description: 'Storm Water Manhole 1.2x2.3 m2', unit: 'NO', quantity: '1.00' },
  { type: 'line', description: 'Section 333000 "SANITARY  SEWER UTILITIES"', bold: true, fill: 'gray', unit: 'ITEM', quantity: '1.00' },
  {
    type: 'line', unit: 'ITEM', quantity: '1.00',
    description: 'Civil works only for HDPE sewer water pipes and reinforced concrete pipes. The scope shall include, but not be limited to, excavation, backfilling, supply of suitable fill materials, compaction, reinforced concrete works, steel reinforcement works, and civil works related to manhole appurtenances only, all in accordance with the approved drawings, specifications, and\napplicable codes of practice.',
  },
  { type: 'line', description: `${SCOPE_TAIL} be by others.` },
  { type: 'line', task_code: '10', description: 'Sewer water pipes 200 mm dia.,', unit: 'M', quantity: '241.00' },
  { type: 'line', task_code: '11', description: 'Sewer Water Manhole', unit: 'No', quantity: '4.00' },
  { type: 'line', task_code: '12', description: 'Sewer Inspection Chamber.', unit: 'No', quantity: '2.00' },
  { type: 'line', description: 'Section 333000 "SANITARY SEWER  UTILITIES"', bold: true, fill: 'gray', unit: 'ITEM', quantity: '1.00' },
  {
    type: 'line', quantity: '1.00',
    description: `Civil works only for HDPE irrigation water pipes and reinforced concrete pipes. The scope shall include, but not be limited to, excavation, backfilling, supply of suitable fill materials, compaction, reinforced concrete works, steel reinforcement works, and civil works related to manhole appurtenances only, all in accordance with the approved drawings, specifications, and applicable codes of practice.${SCOPE_TAIL}\nbe by others.`,
  },
  { type: 'line', task_code: '13', description: 'Gullies', unit: 'M', quantity: '701.00' },
  { type: 'line', task_code: '14', description: 'Culverts', unit: 'M', quantity: '595.00' },
  { type: 'line', description: 'Section 331000 "FIRE WATER PIPES"', bold: true, fill: 'gray', unit: 'ITEM', quantity: '1.00' },
  {
    type: 'line', unit: 'ITEM', quantity: '1.00',
    description: `Civil works only for HDPE fire water pipes and reinforced concrete pipes. The scope shall include, but not be limited to, excavation, backfilling, supply of suitable fill materials, compaction, reinforced concrete works, steel reinforcement works, and civil works related to manhole appurtenances only, all in accordance with the approved drawings, specifications, and applicable codes of practice.\n${SCOPE_TAIL}\nbe by others`,
  },
  { type: 'line', task_code: '15', description: 'Fire water pipes 200 mm dia.', unit: 'M', quantity: '564.00' },
  { type: 'line', task_code: '16', description: 'Fire water pipes 18 mm dia.', unit: 'M', quantity: '18.00' },
  { type: 'line', task_code: '17', description: 'Fire Hydrant', unit: 'No', quantity: '6.00' },
  { type: 'gap' },
  { type: 'line', description: 'Additional stormwater  RG manholes ', bold: true, unit: 'No', quantity: '23.00' },
];

/** Lower case, '-', '_', '/', '.' as spaces, single spaces. */
function normKey(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[-_/.,()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  STAFF_ROWS, TRADE_ROWS, PLANT_ROWS, MANPOWER_MIN_LINES, DEFAULT_ALIASES, DEFAULT_HEADER, DEFAULT_INFO,
  AGREEMENT_71_BOQ, normKey,
};
