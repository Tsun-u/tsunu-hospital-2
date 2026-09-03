/* =====================================================================
   小小醫院 2 — 遊戲資料表

   規則：
   - 病人抽症狀：只從「kind 相符、且 dept 已解鎖」的症狀中抽，人類依 ageWeight 加權
   - 每日病人數 = min(DAILY_PATIENTS_START + (day-1) * DAILY_PATIENTS_STEP, DAILY_PATIENTS_MAX)
   - 特別病人（animal / robot）以 SPECIAL_PATIENT_CHANCE 出現，前提是該 kind 有已解鎖病人
   - 彩蛋動物（egg）在常駐 10 隻全解鎖後，以 EASTER_EGG_CHANCE 取代一般動物
   - 病人與科別的解鎖看 unlockDay 與 UNLOCKS；day 從 1 起算
   ===================================================================== */

const CONFIG = {
  DAILY_PATIENTS_START: 6,
  DAILY_PATIENTS_STEP: 1,
  DAILY_PATIENTS_MAX: 15,
  WAITING_MAX: 5,
  PATIENT_INTERVAL_MS: 10000,
  PATIENT_INTERVAL_JITTER_MS: 3000,
  CRY_AFTER_MS: 25000,
  CHECK_MS: 1500,
  TREAT_MS: 2500,
  DISPENSE_MS: 1200,
  REST_MINUTES: 5,
  SPECIAL_PATIENT_CHANCE: 0.25,
  EASTER_EGG_CHANCE: 0.05,
};

const DEPTS = [
  { id: 'internal', npc: 'doc_internal' },
  { id: 'ent',      npc: 'doc_ent' },
  { id: 'dental',   npc: 'doc_dental' },
  { id: 'surgery',  npc: 'doc_surgery' },
  { id: 'tcm',      npc: 'doc_tcm' },
  { id: 'vet',      npc: 'doc_vet' },
  { id: 'repair',   npc: 'doc_repair' },
];

const SYMPTOMS = [
  { id: 'fever',       kind: 'human', check: 'thermometer', dept: 'internal', treat: 'icepack',       meds: ['fever_syrup', 'vitamin'],                    ageWeight: { kid: 1, teen: 1, adult: 1, elder: 1 } },
  { id: 'cold',        kind: 'human', check: 'stethoscope', dept: 'internal', treat: 'spray',         meds: ['cough_syrup', 'allergy_syrup', 'fever_syrup'], ageWeight: { kid: 1, teen: 1, adult: 1, elder: 1 } },
  { id: 'gastro',      kind: 'human', check: 'stethoscope', dept: 'internal', treat: 'heat_bag',      meds: ['stomach_pill', 'painkiller'],                ageWeight: { kid: 1, teen: 1, adult: 1, elder: 1 } },
  { id: 'runny_nose',  kind: 'human', check: 'flashlight',  dept: 'ent',      treat: 'tissue',        meds: ['allergy_syrup', 'vitamin'],                  ageWeight: { kid: 2, teen: 1, adult: 1, elder: 1 } },
  { id: 'nosebleed',   kind: 'human', check: 'flashlight',  dept: 'ent',      treat: 'cotton',        meds: ['vitamin', 'allergy_syrup', 'ointment'],      ageWeight: { kid: 1, teen: 1, adult: 1, elder: 1 } },
  { id: 'cavity',      kind: 'human', check: 'flashlight',  dept: 'dental',   treat: 'toothbrush',    meds: ['mouthwash', 'painkiller'],                   ageWeight: { kid: 2, teen: 1, adult: 1, elder: 1 } },
  { id: 'scrape',      kind: 'human', check: 'magnifier',   dept: 'surgery',  treat: 'bandage',       meds: ['ointment'],                                  ageWeight: { kid: 3, teen: 1, adult: 1, elder: 1 } },
  { id: 'fracture',    kind: 'human', check: 'xray',        dept: 'surgery',  treat: 'cast',          meds: ['painkiller'],                                ageWeight: { kid: 1, teen: 1, adult: 1, elder: 1 } },
  { id: 'backache',    kind: 'human', check: 'xray',        dept: 'tcm',      treat: 'heat_patch',    meds: ['herbal_pack'],                               ageWeight: { kid: 0, teen: 0, adult: 1, elder: 3 } },
  { id: 'bottom_pain', kind: 'human', check: 'magnifier',   dept: 'tcm',      treat: 'donut_cushion', meds: ['herbal_pack', 'ointment'],                   ageWeight: { kid: 3, teen: 1, adult: 1, elder: 1 } },
  { id: 'pet_fever',   kind: 'animal', check: 'thermometer', dept: 'vet', treat: 'vet_icepack',    meds: ['bone_pill', 'vitamin'] },
  { id: 'pet_tummy',   kind: 'animal', check: 'stethoscope', dept: 'vet', treat: 'vet_medicine',   meds: ['fish_pill'] },
  { id: 'pet_scrape',  kind: 'animal', check: 'magnifier',   dept: 'vet', treat: 'vet_bandage',    meds: ['bone_pill', 'painkiller'] },
  { id: 'pet_cold',    kind: 'animal', check: 'flashlight',  dept: 'vet', treat: 'vet_tissue',     meds: ['fish_pill', 'vitamin'] },
  { id: 'pet_cavity',  kind: 'animal', check: 'flashlight',  dept: 'vet', treat: 'vet_toothbrush', meds: ['bone_pill', 'painkiller'] },
  { id: 'pet_fleas',   kind: 'animal', check: 'magnifier',   dept: 'vet', treat: 'spray',          meds: ['fish_pill', 'ointment'] },
  { id: 'loose_screw', kind: 'robot', check: 'detector',      dept: 'repair', treat: 'screwdriver', meds: ['oil_can'] },
  { id: 'stuck_gear',  kind: 'robot', check: 'wrench_tap',    dept: 'repair', treat: 'wrench',      meds: ['oil_can'] },
  { id: 'low_battery', kind: 'robot', check: 'battery_meter', dept: 'repair', treat: 'charger',     meds: ['battery'] },
];

const CHECK_TOOLS = {
  human:  ['thermometer', 'stethoscope', 'flashlight', 'magnifier', 'xray'],
  animal: ['thermometer', 'stethoscope', 'flashlight', 'magnifier', 'xray'],
  robot:  ['detector', 'wrench_tap', 'battery_meter'],
};

const PATIENTS = [
  { id: 'kid_twintail_girl',    kind: 'human', age: 'kid',   unlockDay: 1 },
  { id: 'adult_office_dad',     kind: 'human', age: 'adult', unlockDay: 1 },
  { id: 'elder_cane_grandpa',   kind: 'human', age: 'elder', unlockDay: 1 },
  { id: 'kid_cap_boy',          kind: 'human', age: 'kid',   unlockDay: 3 },
  { id: 'adult_sporty_mom',     kind: 'human', age: 'adult', unlockDay: 5 },
  { id: 'elder_perm_grandma',   kind: 'human', age: 'elder', unlockDay: 7 },
  { id: 'teen_guitar_boy',      kind: 'human', age: 'teen',  unlockDay: 9 },
  { id: 'toddler_boy_plush',    kind: 'human', age: 'kid',   unlockDay: 11 },
  { id: 'adult_office_mom',     kind: 'human', age: 'adult', unlockDay: 13 },
  { id: 'elder_farmer_grandpa', kind: 'human', age: 'elder', unlockDay: 15 },
  { id: 'teen_bookish_girl',    kind: 'human', age: 'teen',  unlockDay: 17 },
  { id: 'toddler_girl_plush',   kind: 'human', age: 'kid',   unlockDay: 19 },
  { id: 'adult_apron_dad',      kind: 'human', age: 'adult', unlockDay: 21 },
  { id: 'elder_fisher_grandma', kind: 'human', age: 'elder', unlockDay: 23 },
  { id: 'dog',      kind: 'animal', unlockDay: 4 },
  { id: 'cat',      kind: 'animal', unlockDay: 4 },
  { id: 'rabbit',   kind: 'animal', unlockDay: 4 },
  { id: 'sheep',    kind: 'animal', unlockDay: 5 },
  { id: 'monkey',   kind: 'animal', unlockDay: 5 },
  { id: 'bird',     kind: 'animal', unlockDay: 6 },
  { id: 'raccoon',  kind: 'animal', unlockDay: 6 },
  { id: 'elephant', kind: 'animal', unlockDay: 7 },
  { id: 'giraffe',  kind: 'animal', unlockDay: 7 },
  { id: 'rhino',    kind: 'animal', unlockDay: 8 },
  { id: 'lion',     kind: 'animal', unlockDay: 9, egg: true },
  { id: 'tiger',    kind: 'animal', unlockDay: 9, egg: true },
  { id: 'dinosaur', kind: 'animal', unlockDay: 9, egg: true },
  { id: 'unicorn',  kind: 'animal', unlockDay: 9, egg: true },
  { id: 'robot',    kind: 'robot',  unlockDay: 8 },
];

const UNLOCKS = {
  1: { depts: ['internal', 'surgery'], pharmacyWindows: 1 },
  2: { depts: ['dental'] },
  3: { depts: ['ent'] },
  4: { depts: ['vet'] },
  5: { pharmacyWindows: 2 },
  6: { depts: ['tcm'] },
  8: { depts: ['repair'] },
};
