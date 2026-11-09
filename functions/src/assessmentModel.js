// Questionnaires and scoring. Scores are computed server-side only.
const L4 = (a, b, c, d) => [{ v: 0, label: a }, { v: 1, label: b }, { v: 2, label: c }, { v: 3, label: d }];

const healthcare = [
  { id: 'distance', text: 'How far is the nearest health facility?', options: L4('Under 2 km', '2–5 km', '5–10 km', 'Over 10 km') },
  { id: 'transport', text: 'Can you get transport to a facility when needed?', options: L4('Always', 'Usually', 'Rarely', 'Never') },
  { id: 'doctor_visit', text: 'How recently did you consult a qualified doctor?', options: L4('Within 6 months', '6–12 months', 'Over a year ago', 'Never') },
  { id: 'affordability', text: 'Can your household afford treatment costs?', options: L4('Easily', 'With some difficulty', 'With great difficulty', 'Not at all') },
  { id: 'health_worker', text: 'Is a trained health worker available in your village?', options: L4('Always', 'Most days', 'Occasionally', 'Never') },
  { id: 'medicines', text: 'Are essential medicines available nearby?', options: L4('Always', 'Usually', 'Rarely', 'Never') },
  { id: 'vaccination', text: 'Are children/elders in your household up to date on vaccines?', options: L4('All', 'Most', 'Some', 'None') },
  { id: 'emergency', text: 'How quickly can you reach emergency care?', options: L4('Under 30 min', '30–60 min', '1–3 hours', 'Over 3 hours') },
];
const antibiotic = [
  { id: 'no_prescription', text: 'How often do you take antibiotics without a prescription?', options: L4('Never', 'Rarely', 'Sometimes', 'Often') },
  { id: 'stop_early', text: 'Do you stop the course when you feel better?', options: L4('Never', 'Rarely', 'Sometimes', 'Always') },
  { id: 'leftovers', text: 'Do you keep leftover antibiotics for later use?', options: L4('Never', 'Rarely', 'Sometimes', 'Often') },
  { id: 'pharmacy', text: 'Do you buy antibiotics directly from a pharmacy without seeing a doctor?', options: L4('Never', 'Rarely', 'Sometimes', 'Often') },
  { id: 'sharing', text: 'Do you share antibiotics with family or neighbours?', options: L4('Never', 'Rarely', 'Sometimes', 'Often') },
  { id: 'viral', text: 'Do you take antibiotics for cold, cough or flu?', options: L4('Never', 'Rarely', 'Sometimes', 'Often') },
  { id: 'awareness', text: 'How well do you understand antibiotic resistance?', options: L4('Very well', 'Somewhat', 'A little', 'Not at all') },
];

function score(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { error: 'answers must be an object' };
  let total = 0;
  const clean = {};
  for (const q of questions) {
    const v = answers[q.id];
    if (!Number.isInteger(v) || !q.options.some(o => o.v === v)) return { error: `Invalid or missing answer for "${q.id}"` };
    clean[q.id] = v; total += v;
  }
  return { answers: clean, pct: Math.round((total / (questions.length * 3)) * 100) };
}
const riskLevel = pct => (pct < 34 ? 'Low' : pct < 67 ? 'Moderate' : 'High');

module.exports = { healthcare, antibiotic, score, riskLevel };
